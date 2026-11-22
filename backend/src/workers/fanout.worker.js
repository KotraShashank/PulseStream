const { Worker } = require("bullmq");
const { getRedisConnectionOptions } = require("../config/redis");
const { Follow } = require("../models/Follow");
const { Delivery } = require("../models/Delivery");
const User = require("../models/User");
const { emailQueue } = require("../queues/email.queue");
const { inAppQueue } = require("../queues/inapp.queue");
const { emitMetricsUpdate } = require("../config/socket");

const fanoutWorker = new Worker(
  "fanout-queue",
  async (job) => {
    const { eventId, topicId, type, payload } = job.data;

    if (!eventId || !topicId) {
      throw new Error("Fanout job is missing eventId or topicId");
    }

    console.log(
      `📣 [Fanout Worker] Processing event ${eventId} for topic ${topicId}`,
    );

    const followers = await Follow.find({
      topicId: String(topicId),
      channels: { $in: ["email", "inApp"] },
    }).lean();

    console.log(`[Fanout Worker] Found ${followers.length} active followers.`);

    if (followers.length === 0) {
      console.warn(
        `⚠️ [Fanout Worker] No subscribers for topicId "${topicId}". Event ${eventId} was recorded but has no deliveries.`,
      );
      return;
    }

    for (const follower of followers) {
      const userExists = await User.exists({ _id: follower.userId });

      if (!userExists) {
        console.warn(
          `🧹 [Fanout Worker] Removing orphaned follow for deleted user ${follower.userId}.`,
        );
        await Follow.deleteMany({ userId: follower.userId });
        continue;
      }

      for (const channel of new Set(follower.channels)) {
        if (channel !== "email" && channel !== "inApp") continue;
        const key = { eventId, userId: follower.userId, channel };
        const delivery = await Delivery.findOneAndUpdate(key, {
          $setOnInsert: { ...key, status: "pending", attempts: 0 },
        }, { upsert: true, returnDocument: "after" });
        if (delivery.status !== "pending") continue;
        const email = channel === "email";
        const queue = email ? emailQueue : inAppQueue;
        await queue.add(email ? "send-email" : "send-inapp", {
          eventId, userId: follower.userId, type, payload,
        }, { jobId: `delivery-${eventId}-${follower.userId}-${email ? "email" : "inapp"}` });
      }
    }

    // Tell connected admin dashboards that the Delivery collection has changed.
    emitMetricsUpdate();
    console.log(`✅ [Fanout Worker] Fan-out completed for event ${eventId}.`);
  },
  {
    connection: getRedisConnectionOptions("fanout-worker", { worker: true }),
    autorun: false,
  },
);

fanoutWorker.on("failed", (job, err) => {
  console.error(`❌ [Fanout Worker] Job ${job?.id} failed:`, err.message);
});

fanoutWorker.on("error", (err) => {
  console.error("❌ [Fanout Worker] Worker error:", err.message);
});

module.exports = { fanoutWorker };
