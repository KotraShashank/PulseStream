const { createHash } = require("node:crypto");
const { redisHealthConnection } = require("../config/redis");

const increment = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], 900) end
  return count
`;

function limitAuth(maximum) {
  return async (req, res, next) => {
    const identity = String(req.body?.email || req.body?.token || "").trim().toLowerCase();
    const digest = createHash("sha256").update(identity).digest("hex");
    const count = await redisHealthConnection.eval(increment, 1, `pulsestream:auth:${req.path}:${digest}`);
    if (count <= maximum) return next();
    res.set("Retry-After", "900").status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  };
}

module.exports = { limitAuth };
