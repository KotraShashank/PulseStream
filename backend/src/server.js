const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === "production") throw new Error("Set JWT_SECRET before starting PulseStream");
  process.env.JWT_SECRET = require("node:crypto").randomBytes(32).toString("hex");
}

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDB } = require("./config/db");
const {
  redisHealthConnection,
  verifyRedis,
  closeRedis,
} = require("./config/redis");

const { fanoutWorker } = require("./workers/fanout.worker");
const { inAppWorker } = require("./workers/inapp.worker");
const { emailWorker } = require("./workers/email.worker");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const User = require("./models/User");
const analyticsRoutes = require("./routes/analytics.routes");
const notificationRoutes = require("./routes/notification.routes");
const { initializeSocket } = require("./config/socket");
const { Follow } = require("./models/Follow");

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const { isAllowedOrigin } = require("./config/origin");

const httpServer = http.createServer(app);
const io = initializeSocket(httpServer);

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(
        new Error("Origin is not allowed by PulseStream CORS policy"),
      );
    },
    credentials: true,
  }),
);
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT"].includes(req.method) && req.body != null &&
      (Array.isArray(req.body) || typeof req.body !== "object")) {
    return res.status(400).json({ error: "Expected a JSON object" });
  }
  req.body ??= {};
  next();
});

app.get("/health", (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const redisReady = redisHealthConnection.status === "ready";
  const healthy = mongoReady && redisReady;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "OK" : "DEGRADED",
    service: "PulseStream Server",
    mongo: mongoReady ? "connected" : mongoose.connection.readyState,
    redis: redisReady ? "connected" : redisHealthConnection.status,
    email:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? "configured"
        : "not-configured",
  });
});

app.use("/api/catalog", require("./routes/catalog"));
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);
if (process.env.NODE_ENV !== "production") {
  app.get("/test-client", (req, res) => res.sendFile(path.resolve(__dirname, "../test-client.html")));
}

app.use((err, req, res, next) => {
  console.error("Unhandled API error:", err.name, err.code || err.status || 500);
  if (res.headersSent) return next(err);
  const status = err.status === 413 ? 413 : err.status === 400 ? 400 : 500;
  res.status(status).json({ success: false, error: status === 413 ? "Request is too large" : status === 400 ? "Invalid JSON" : "Internal server error" });
});

const DEMO_PRODUCT_IDS = ["prod_1", "prod_2", "prod_3", "prod_4", "prod_5"];

const ensureDemoAdminSubscriptions = async (adminUser) => {
  if (process.env.NODE_ENV === "production") return;

  // Ensure the five current demo topics are present even when the database
  // contains stale subscriptions from an older version of the project.
  // Existing demo subscriptions are preserved and only missing channels are added.
  let changed = false;

  for (const topicId of DEMO_PRODUCT_IDS) {
    const follow = await Follow.findOne({
      userId: adminUser._id,
      topicId,
    });

    if (!follow) {
      await Follow.create({
        userId: adminUser._id,
        topicId,
        channels: ["inApp", "email"],
      });
      changed = true;
      continue;
    }

    const channels = new Set(follow.channels || []);
    channels.add("inApp");
    channels.add("email");
    const nextChannels = [...channels];

    if (nextChannels.length !== follow.channels.length) {
      follow.channels = nextChannels;
      await follow.save();
      changed = true;
    }
  }

  console.log(
    changed
      ? `🎯 Demo admin subscriptions verified for ${DEMO_PRODUCT_IDS.length} topics (in-app + email).`
      : `✅ Demo admin subscriptions already cover all ${DEMO_PRODUCT_IDS.length} demo topics.`,
  );
};

const seedDevelopmentAdmin = async () => {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SEED_ADMIN !== "true"
  ) {
    return;
  }

  const masterEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

  const masterPassword = process.env.ADMIN_PASSWORD || "";

  const masterName = process.env.ADMIN_NAME || "PulseStream Admin";

  if (!masterPassword && process.env.SEED_ADMIN !== "true") return;
  if (!masterEmail) {
    throw new Error("ADMIN_EMAIL must be set in backend/.env");
  }

  if (!masterPassword) {
    throw new Error("ADMIN_PASSWORD must be set in backend/.env");
  }

  let admin = await User.findOne({ email: masterEmail });
  if (admin) {
    return;
  } else {
    const hashedPassword = await bcrypt.hash(masterPassword, 10);
    admin = await User.create({
      name: masterName,
      email: masterEmail,
      password: hashedPassword,
      avatar: "👤",
    });
    console.log(`🔥 Seeded development admin account: ${masterEmail}`);
  }

  await ensureDemoAdminSubscriptions(admin);
};

const startServer = async () => {
  try {
    await connectDB();
    await verifyRedis();
    await seedDevelopmentAdmin();
    await require("./models/Event").Event.init();
    for (const worker of [fanoutWorker, inAppWorker, emailWorker]) {
      worker.run().catch(error => {
        console.error("Worker stopped:", worker.name, error.name);
        process.exit(1);
      });
    }
    require("./queues/event-dispatch").startDispatcher();

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server & WebSockets running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();

let stopping = false;
const gracefulShutdown = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try {
    await new Promise(resolve => io.close(resolve));
    await Promise.all([fanoutWorker.close(), emailWorker.close(), inAppWorker.close()]);
    await Promise.all([
      require("./queues/fanout.queue").fanoutQueue.close(),
      require("./queues/email.queue").emailQueue.close(),
      require("./queues/inapp.queue").inAppQueue.close(),
    ]);
    await Promise.all([mongoose.connection.close(), closeRedis()]);
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed:", error.name);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
