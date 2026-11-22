const { Router } = require("express");
const { Types } = require("mongoose");
const User = require("../models/User");
const { Follow } = require("../models/Follow");
const {
  isAdminEmail,
  requireAuth,
  requireAdmin,
  requireSelfOrAdmin,
} = require("../middleware/auth");

const router = Router();

function formatSubscriptions(follows) {
  return follows.map((follow) => ({
    productId: String(follow.topicId),
    inApp: Array.isArray(follow.channels) && follow.channels.includes("inApp"),
    email: Array.isArray(follow.channels) && follow.channels.includes("email"),
  }));
}

// GET /api/users - Admin-only observability endpoint.
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select("name email avatar").lean();
    const follows = await Follow.find({ userId: { $in: users.map(user => user._id) } }).lean();
    const byUser = new Map();
    for (const follow of follows) {
      const key = String(follow.userId);
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push(follow);
    }
    const usersWithFollows = users.map(user => ({
      ...user, subscriptions: formatSubscriptions(byUser.get(String(user._id)) || []),
    }));
    res.json(usersWithFollows);
  } catch (error) {
    res.status(500).json({ error: "Unable to update or load subscriptions" });
  }
});

// PATCH /api/users/:userId/watchlist - Toggle a user's notification channel.
router.patch(
  "/:userId/watchlist",
  requireAuth,
  requireSelfOrAdmin("userId"),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { productId, channel } = req.body;

      if (!Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ error: "Invalid userId" });
      }
      if (typeof productId !== "string" || !productId.trim() || productId.length > 128 || !["inApp", "email"].includes(channel)) {
        return res.status(400).json({
          error:
            'productId and channel must be provided; channel must be "inApp" or "email"',
        });
      }

      const targetUserId = new Types.ObjectId(userId);
      const targetTopicId = String(productId).trim();
      const user = await User.findById(targetUserId).select("name email avatar").lean();
      if (!user) return res.status(404).json({ error: "User not found" });

      const filter = { userId: targetUserId, topicId: targetTopicId };
      const enabled = req.body.enabled;
      if (enabled !== undefined && typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      const channels = { $ifNull: ["$channels", []] };
      const add = { $setUnion: [channels, [channel]] };
      const remove = { $setDifference: [channels, [channel]] };
      const next = enabled === undefined
        ? { $cond: [{ $in: [channel, channels] }, remove, add] }
        : enabled ? add : remove;
      const change = [{ $set: { channels: next } }];
      try {
        await Follow.updateOne(filter, change, { upsert: true, updatePipeline: true });
      } catch (err) {
        if (err.code !== 11000) throw err;
        await Follow.updateOne(filter, change, { updatePipeline: true });
      }
      await Follow.deleteOne({ ...filter, channels: { $size: 0 } });

      const updatedFollows = await Follow.find({ userId: targetUserId }).lean();
      res.json({
        success: true,
        data: { ...user, isAdmin: isAdminEmail(user.email), subscriptions: formatSubscriptions(updatedFollows) },
      });
    } catch (error) {
      console.error("🚨 [BACKEND] Watchlist DB Update Failed:", error);
      res.status(500).json({ error: "Unable to update or load subscriptions" });
    }
  },
);

// POST /api/users/:userId/arm-all - Admin-only demo helper.
// This is also used by the seeded demo admin when explicit test subscriptions are needed.
router.post("/:userId/arm-all", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { productIds } = req.body;

    if (!Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res
        .status(400)
        .json({ error: "productIds must be a non-empty array" });
    }

    const targetUserId = new Types.ObjectId(userId);
    if (productIds.length > 100 || productIds.some(id => typeof id !== "string" || !id.trim() || id.length > 128)) {
      return res.status(400).json({ error: "Provide up to 100 valid product IDs" });
    }
    const user = await User.findById(targetUserId).select("name email avatar").lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    const ids = [...new Set(productIds.map(id => id.trim()))];
    await Follow.bulkWrite(ids.map(topicId => ({
      updateOne: {
        filter: { userId: targetUserId, topicId },
        update: { $set: { channels: ["inApp", "email"] } },
        upsert: true,
      },
    })));
    const follows = await Follow.find({ userId: targetUserId }).lean();

    res.json({
      success: true,
      data: {
        ...user,
        isAdmin: isAdminEmail(user.email),
        subscriptions: formatSubscriptions(follows),
      },
    });
  } catch (error) {
    console.error(
      "🚨 [BACKEND] Failed to enable all notification subscriptions:",
      error,
    );
    res.status(500).json({ error: "Unable to update or load subscriptions" });
  }
});

module.exports = router;
