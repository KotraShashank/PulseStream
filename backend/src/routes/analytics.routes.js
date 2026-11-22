const { Router } = require("express");

const { Delivery } = require("../models/Delivery");
const { Event } = require("../models/Event");
const { Notification } = require("../models/Notification");

const { emailQueue } = require("../queues/email.queue");
const { inAppQueue } = require("../queues/inapp.queue");
const { fanoutQueue } = require("../queues/fanout.queue");

const { requireAuth, requireAdmin } = require("../middleware/auth");

const { emitMetricsUpdate } = require("../config/socket");

const router = Router();
async function waitForNoActiveJobs(queues, timeoutMs = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const activeCounts = await Promise.all(
      queues.map((queue) => queue.getActiveCount()),
    );

    const hasActiveJobs = activeCounts.some((count) => count > 0);

    if (!hasActiveJobs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Timed out waiting for active BullMQ jobs to finish.");
}

function categorizeFailure(errorMessage = "Unknown delivery error") {
  const message = String(errorMessage);

  if (
    message.includes("552") ||
    message.includes("Mailbox is full") ||
    message.includes("Quota exceeded")
  ) {
    return { faultType: "USER_QUOTA_EXCEEDED", actionable: false };
  }

  if (
    message.includes("550") ||
    message.includes("User unknown") ||
    message.includes("Invalid domain")
  ) {
    return { faultType: "INVALID_EMAIL_ADDRESS", actionable: false };
  }

  return { faultType: "SYSTEM_INFRASTRUCTURE_ERROR", actionable: true };
}

// GET /api/analytics -> Real-time delivery metrics using MongoDB aggregation.
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const stats = await Delivery.aggregate([
      {
        $group: {
          _id: null,
          totalProcessed: { $sum: 1 },
          successful: {
            $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalProcessed: 1,
          successful: 1,
          failed: 1,
          pending: 1,
          successRate: {
            $cond: [
              { $eq: ["$totalProcessed", 0] },
              100,
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$successful", "$totalProcessed"] },
                      100,
                    ],
                  },
                  1,
                ],
              },
            ],
          },
        },
      },
    ]);

    res.json(
      stats[0] || {
        totalProcessed: 0,
        successful: 0,
        failed: 0,
        pending: 0,
        successRate: 100,
      },
    );
  } catch (err) {
    res.status(500).json({ error: "Unable to complete the analytics request" });
  }
});

// GET /api/analytics/failures -> Failed deliveries with fault classification.
router.get("/failures", requireAuth, requireAdmin, async (req, res) => {
  try {
    const failures = await Delivery.find({ status: "failed" })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("userId", "name email")
      .populate("eventId", "type payload")
      .lean();

    res.json(
      failures.map((delivery) => {
        const { faultType, actionable } = categorizeFailure(
          delivery.errorMessage,
        );
        return {
          ...delivery,
          faultType: delivery.faultType || faultType,
          actionable,
        };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: "Unable to complete the analytics request" });
  }
});

// POST /api/analytics/retry/:id -> Re-inject a failed delivery into BullMQ.
router.post("/retry/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid delivery ID" });
    const delivery = await Delivery.findById(req.params.id).populate("eventId");
    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }
    if (delivery.status !== "failed") {
      return res
        .status(400)
        .json({ error: "Only failed deliveries can be retried" });
    }

    const event = delivery.eventId;
    if (!event) {
      return res
        .status(404)
        .json({ error: "Original event payload no longer exists" });
    }

    const retryKey = `retry-${delivery._id}-${delivery.updatedAt.getTime()}`;
    const claimed = await Delivery.updateOne({ _id: delivery._id, updatedAt: delivery.updatedAt, status: "failed" }, {
      $set: { status: "pending", attempts: 0 },
    });
    if (!claimed.modifiedCount) return res.status(409).json({ error: "Delivery already changed" });

    const email = delivery.channel === "email";
    try {
      await (email ? emailQueue : inAppQueue).add(email ? "send-email" : "send-inapp", {
        eventId: event._id, userId: delivery.userId, type: event.type, payload: event.payload,
      }, { jobId: retryKey });
    } catch (error) {
      await Delivery.updateOne({ _id: delivery._id, status: "pending", attempts: 0 }, {
        $set: { status: "failed", attempts: delivery.attempts },
      });
      throw error;
    }
    emitMetricsUpdate();
    res.json({ success: true, message: "Delivery re-queued successfully" });
  } catch (err) {
    res.status(500).json({ error: "Unable to complete the analytics request" });
  }
});

// POST /api/analytics/reset -> Reset analytics data and pending notification jobs. Admin-only.
router.post("/reset", requireAuth, requireAdmin, async (req, res) => {
  const queues = [fanoutQueue, inAppQueue, emailQueue];

  const pausedHere = [];

  try {
    console.log("🧹 [Reset Metrics] Starting reset...");

    // Stop new jobs from being picked up.
    for (const queue of queues) {
      if (await queue.isPaused()) continue;
      await queue.pause();
      pausedHere.push(queue);
    }

    console.log("⏸️ [Reset Metrics] BullMQ queues paused.");

    // Let jobs that are already running finish.
    await waitForNoActiveJobs(queues);

    console.log("✅ [Reset Metrics] No active BullMQ jobs remain.");

    // Remove waiting, delayed, completed and failed jobs.
    await Promise.all(
      queues.map((queue) =>
        queue.obliterate({
          force: true,
        }),
      ),
    );

    console.log("🗑️ [Reset Metrics] BullMQ queues cleared.");

    // Delete only analytics/runtime data.
    const [events, deliveries, notifications] = await Promise.all([
      Event.deleteMany({ inventoryVersion: { $exists: false } }),
      Delivery.deleteMany({}),
      Notification.deleteMany({}),
    ]);

    console.log("🗑️ [Reset Metrics] MongoDB analytics data cleared.");

    await Event.updateMany({ publishPending: true, inventoryVersion: { $exists: true } }, { $unset: { publishPending: 1 } });
    require("../config/socket").getIO().emit("inbox:reset");
    // Tell every connected admin dashboard to refresh.
    emitMetricsUpdate();

    console.log("📊 [Reset Metrics] Metrics update emitted.");

    res.json({
      success: true,
      message: "Metrics and pending notification jobs have been reset.",

      deleted: {
        events: events.deletedCount || 0,

        deliveries: deliveries.deletedCount || 0,

        notifications: notifications.deletedCount || 0,
      },

      preserved: ["users", "follows", "topics"],
    });
  } catch (err) {
    console.error("❌ [Reset Metrics] Failed:", err);

    res.status(500).json({
      success: false,
      error: "Unable to complete the analytics request",
    });
  } finally {
    if (pausedHere.length) {
      await Promise.all(
        pausedHere.map((queue) =>
          queue.resume().catch((resumeError) => {
            console.error(
              `❌ Failed to resume ${queue.name}:`,
              resumeError.message,
            );
          }),
        ),
      );

      console.log("▶️ [Reset Metrics] BullMQ queues resumed.");
    }
  }
});

module.exports = router;
