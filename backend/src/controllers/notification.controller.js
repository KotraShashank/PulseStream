const { Event } = require("../models/Event");
const { Follow } = require("../models/Follow");
const { Notification } = require("../models/Notification");
const { Topic } = require("../models/Topic");
const { dispatchPending } = require("../queues/event-dispatch");

// 1. TRIGGER EVENT (The missing link for the Dashboard Analytics!)
const triggerEvent = async (req, res) => {
  try {
    const { topicId, type, payload } = req.body;

    if (typeof topicId !== "string" || !topicId.trim() || topicId.length > 128 || typeof type !== "string" || !type.trim() || type.length > 128 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      res
        .status(400)
        .json({ error: "topicId, type, and payload are required" });
      return;
    }

    const safeTopicId = String(topicId).trim();

    const subscriberCount = await Follow.countDocuments({
      topicId: safeTopicId,
      channels: { $in: ["email", "inApp"] },
    });

    if (subscriberCount === 0) {
      console.warn(
        `⚠️ [Event Trigger] Topic "${safeTopicId}" currently has no active subscribers.`,
      );
    }

    const newEvent = await Event.create({
      topicId: safeTopicId,
      type,
      payload,
      publishPending: true,
    });
    void dispatchPending();

    res.status(201).json({
      success: true,
      message: "Event accepted for background processing",
      subscriberCount,
      event: newEvent,
    });
  } catch (error) {
    console.error("🚨 Failed to trigger event:", error);
    res.status(500).json({ success: false, error: "Request could not be completed" });
  }
};

// 2. GET USER NOTIFICATIONS (For the in-app bell icon)
const getNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50); // Keep it fast, only fetch recent 50

    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    res.status(500).json({ success: false, error: "Request could not be completed" });
  }
};

// 3. FOLLOW A TOPIC (Opt-in to notifications)
const followTopic = async (req, res) => {
  try {
    const { userId, topicId, channels } = req.body;

    if (String(userId) !== String(req.userId)) {
      return res
        .status(403)
        .json({ error: "You can only manage your own subscriptions" });
    }

    if (!userId || typeof topicId !== "string" || !topicId.trim() || topicId.length > 128 || !channels || !Array.isArray(channels)) {
      res.status(400).json({
        error: "userId, topicId, and an array of channels are required",
      });
      return;
    }

    const safeChannels = channels.filter((channel) =>
      ["email", "inApp"].includes(channel),
    );
    if (safeChannels.length === 0) {
      return res
        .status(400)
        .json({ error: 'channels must contain "email" and/or "inApp"' });
    }
    const follow = await Follow.findOneAndUpdate(
      { userId, topicId: String(topicId).trim() },
      { channels: safeChannels },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    res.status(200).json({ success: true, data: follow });
  } catch (error) {
    res.status(500).json({ success: false, error: "Request could not be completed" });
  }
};

// 4. UNFOLLOW A TOPIC (Opt-out)
const unfollowTopic = async (req, res) => {
  try {
    const { id } = req.params;
    const follow = await Follow.findById(id);
    if (!follow) {
      return res.status(404).json({ error: "Follow subscription not found" });
    }
    if (String(follow.userId) !== String(req.userId)) {
      return res
        .status(403)
        .json({ error: "You can only remove your own subscription" });
    }

    await Follow.deleteOne({ _id: id });

    res.status(200).json({ success: true, message: "Unfollowed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: "Request could not be completed" });
  }
};

// 5. CREATE A TOPIC (Optional/Admin)
const createTopic = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();

    if (!name) {
      res.status(400).json({ error: "Topic name is required" });
      return;
    }

    const topic = new Topic({ name });
    await topic.save();

    res.status(201).json({ message: "Topic created successfully", topic });
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: "A topic with this name already exists" });
      return;
    }
    res.status(500).json({ error: "Request could not be completed" });
  }
};

module.exports = {
  triggerEvent,
  getNotifications,
  followTopic,
  unfollowTopic,
  createTopic,
};
