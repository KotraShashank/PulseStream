const { Worker, UnrecoverableError } = require("bullmq");
const { getRedisConnectionOptions } = require("../config/redis");
const { isMailConfigured, sendEmail } = require("../config/mail");
const User = require("../models/User");
const { Delivery } = require("../models/Delivery");
const { emitMetricsUpdate } = require("../config/socket");

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}

const emailWorker = new Worker(
  "email-queue",
  async (job) => {
    const { eventId, userId, subject, payload } = job.data;
    console.log(
      `📧 Email Worker: Picking up job ${job.id} (attempt ${job.attemptsMade + 1}) for User ID ${userId}`,
    );

    if (eventId && await Delivery.exists({ eventId, userId, channel: "email", status: "success" })) return;
    const user = await User.findById(userId);

    // Deleted/orphaned user
    if (!user) {
      console.error(
        `Email Worker: User ID ${userId} not found in MongoDB! Skipping.`,
      );
      if (eventId) {
        await Delivery.findOneAndUpdate(
          { eventId, userId, channel: "email" },
          {
            status: "failed",
            attempts: job.attemptsMade + 1,
            errorMessage: "User account was deleted from database.",
            faultType: "ORPHANED_USER",
          },
        );
        emitMetricsUpdate();
      }
      return;
    }

    const simulate = process.env.NODE_ENV !== "production" && process.env.LOAD_TEST_MODE === "true";
    if (!simulate && !isMailConfigured()) {
      const error = new UnrecoverableError(
        "Email delivery is not configured",
      );
      if (eventId) {
        await Delivery.findOneAndUpdate(
          { eventId, userId: user._id, channel: "email" },
          {
            $inc: { attempts: 1 },
            $set: {
              status: "failed",
              errorMessage: error.message,
              faultType: "EMAIL_NOT_CONFIGURED",
            },
          },
        );
        emitMetricsUpdate();
      }
      throw error;
    }

    if (eventId) {
      await Delivery.findOneAndUpdate(
        { eventId, userId: user._id, channel: "email" },
        { $inc: { attempts: 1 } },
      );
    }

    const productName = payload?.productName || "Your Watched Item";
    const oldPrice = payload?.oldPrice ?? "N/A";
    const newPrice = payload?.newPrice ?? "N/A";

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PulseStream Watchlist Update</title>
</head>
<body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 40px 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
    <div style="background-color: #0f172a; padding: 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">
        PulseStream<span style="color: #3b82f6;">.io</span>
      </h1>
    </div>
    <div style="padding: 40px 32px;">
      <p style="font-size: 16px; color: #475569; margin-top: 0;">
        Hello <strong style="color: #0f172a;">${escapeHtml(user.name)}</strong>,
      </p>
      <p style="font-size: 16px; color: #475569; line-height: 1.5;">
        This is an automated notification that an item on your PulseStream watchlist has recorded a price change.
      </p>
      <div style="margin: 32px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; background-color: #f8fafc; border-left: 4px solid #4f46e5;">
        <h2 style="margin: 0 0 12px 0; font-size: 20px; color: #0f172a;">${escapeHtml(productName)}</h2>
        <div style="display: block; margin-top: 8px;">
          <span style="font-size: 28px; font-weight: 800; color: #10b981;">$${escapeHtml(newPrice)}</span>
          <span style="font-size: 16px; color: #94a3b8; text-decoration: line-through; margin-left: 12px;">$${escapeHtml(oldPrice)}</span>
        </div>
      </div>
      <p style="font-size: 14px; color: #64748b;">
        You can review your active subscriptions and manage notification channels anytime from your account preferences.
      </p>
      <div style="text-align: center; margin-top: 32px;">
        <a href="${process.env.FRONTEND_URL || "http://localhost:5173"}" style="background-color: #4f46e5; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block;">
          View Watchlist
        </a>
      </div>
    </div>
    <div style="background-color: #f1f5f9; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="font-size: 12px; color: #94a3b8; margin: 0;">
        You are receiving this automated update because you opted into email notifications on PulseStream.
      </p>
    </div>
  </div>
</body>
</html>
`;

    try {
      const cleanSubject =
        subject || `Watchlist Update: New price recorded for ${productName}`;
      if (simulate) {
        console.log(
          `[LOAD TEST] Simulating email job ${job.id}`,
        );

        if (eventId) {
          await Delivery.findOneAndUpdate(
            {
              eventId,
              userId: user._id,
              channel: "email",
            },
            {
              status: "success",
              sentAt: new Date(),
              $unset: { errorMessage: 1, faultType: 1 },
            },
          );
        }

        emitMetricsUpdate();
        return;
      }
      await sendEmail(user.email, cleanSubject, html, `watchlist/${job.id}`);

      if (eventId) {
        await Delivery.findOneAndUpdate(
          { eventId, userId: user._id, channel: "email" },
          {
            status: "success",
            sentAt: new Date(),
            $unset: { errorMessage: 1, faultType: 1 },
          },
        );
        emitMetricsUpdate();
      }

      console.log(`Email provider accepted job ${job.id}`);
    } catch (error) {
      console.error(`Email job ${job.id} failed:`, error.code || error.name);
      if (eventId) {
        await Delivery.findOneAndUpdate(
          { eventId, userId: user._id, channel: "email" },
          {
            status: job.attemptsMade + 1 >= (job.opts.attempts || 1) ? "failed" : "pending",
            attempts: job.attemptsMade + 1,
            errorMessage: error.message,
            faultType: "EMAIL_DELIVERY_ERROR",
          },
        );
        emitMetricsUpdate();
      }
      throw error;
    }
  },

  {
    connection: getRedisConnectionOptions("email-worker", { worker: true }),
    concurrency: 5,
    autorun: false,
  },
);

emailWorker.on("failed", (job, err) => {
  console.error(`❌ [Email Worker] Job ${job?.id} failed:`, err.message);
});

emailWorker.on("error", (err) => {
  console.error("❌ [Email Worker] Worker error:", err.message);
});

module.exports = { emailWorker };
