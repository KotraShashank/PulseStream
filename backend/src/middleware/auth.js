const jwt = require("jsonwebtoken");
const User = require("../models/User");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "JWT_SECRET must be set in .env — refusing to sign/verify tokens without it.",
    );
  }
  return secret;
}

async function findSession(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
  } catch {
    return null;
  }
  if (typeof decoded.id !== "string" || !/^[a-f0-9]{24}$/i.test(decoded.id)) return null;
  const user = await User.findById(decoded.id).select("email sessionVersion").lean();
  if (!user || (user.sessionVersion || 0) !== (decoded.version ?? 0)) return null;
  return { id: decoded.id, email: user.email, expiresAt: decoded.exp * 1000 };
}

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const session = token && await findSession(token);
  if (!session) return res.status(401).json({ success: false, error: "Sign in to continue" });
  req.userId = session.id;
  req.session = session;
  next();
};

// Keep admin emails configurable so the demo account is not hard-wired into
// the authorization logic. Multiple addresses can be comma-separated.

function getAdminEmails() {
  const configured = [
    ...(process.env.ADMIN_EMAILS?.split(",") || []),
    process.env.ADMIN_EMAIL || "",
  ]
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(configured)];
}

const isAdminEmail = (email) =>
  getAdminEmails().includes(
    String(email || "")
      .trim()
      .toLowerCase(),
  );

const requireAdmin = (req, res, next) => {
  if (isAdminEmail(req.session.email)) return next();
  return res.status(403).json({ success: false, error: "Admin access only" });
};

const requireSelfOrAdmin = (paramName = "id") => (req, res, next) => {
  if (req.params[paramName] === req.userId || isAdminEmail(req.session.email)) return next();
  return res.status(403).json({ success: false, error: "Forbidden" });
};

module.exports = {
  requireAuth,
  findSession,
  requireAdmin,
  requireSelfOrAdmin,
  getJwtSecret,
  getJWTSecret: getJwtSecret,
  isAdminEmail,
  getAdminEmails,
};
