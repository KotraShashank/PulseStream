const { Server } = require("socket.io");
const { findSession, isAdminEmail } = require("../middleware/auth");
const { isAllowedOrigin } = require("./origin");

let io = null;

const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          return callback(null, true);
        }
        return callback(
          new Error(
            "Origin is not allowed by PulseStream Socket.io CORS policy",
          ),
        );
      },
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const session = token && await findSession(token);
      if (!session) return next(new Error("Invalid or expired session"));
      socket.data.session = session;
      next();
    } catch {
      next(new Error("Session check unavailable"));
    }
  });

  io.on("connection", (socket) => {
    const session = socket.data.session;
    socket.join(session.id);
    if (isAdminEmail(session.email)) socket.join("admin-metrics");
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, session.expiresAt - Date.now()));
    socket.once("disconnect", () => clearTimeout(expiry));
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error("Socket.io has not been initialized yet!");
  return io;
};

/**
 * Notify connected admin dashboards that delivery metrics have changed.
 * The event intentionally contains no sensitive metric data.
 * The frontend responds by requesting the authoritative metrics from /api/analytics.
 */
let metricsTimer;
const emitMetricsUpdate = () => {
  if (!io || metricsTimer) return;
  metricsTimer = setTimeout(() => {
    metricsTimer = null;
    io.to("admin-metrics").emit("metrics:update");
  }, 200);
  metricsTimer.unref();
};

module.exports = {
  initializeSocket,
  getIO,
  emitMetricsUpdate,
};
