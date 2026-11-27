function isAllowedOrigin(origin) {
  if (!origin) return true;
  const configured = (process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (origin === configured) return true;
  return process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

module.exports = { isAllowedOrigin };
