// Run against the disposable services in checks.yml. Mailpit captures all mail.
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");
const { io } = createRequire(path.resolve(__dirname, "../../frontend/package.json"))("socket.io-client");
const base = "http://127.0.0.1:15090";
const mailbox = "http://127.0.0.1:8025/api/v1";

async function eventually(description, read) {
  const deadline = Date.now() + 45000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function api(method, route, body, token, expected = 200) {
  const response = await fetch(base + "/api" + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, expected, `${method} ${route}`);
  return response.json();
}
async function run() {
  await eventually("backend readiness", async () => (await fetch(base + "/health")).ok);
  const password = "Tmp1" + randomBytes(16).toString("hex");
  const email = `shopper-${randomBytes(5).toString("hex")}@example.test`;
  const admin = await api("POST", "/auth/login", { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  const shopper = await api("POST", "/auth/signup", { name: "Test Shopper", email, password }, null, 201);
  const userId = shopper.user._id;
  await api("GET", "/analytics", null, shopper.token, 403);
  const products = await api("GET", "/catalog", null, shopper.token);
  const product = products[0];
  for (const channel of ["inApp", "email"]) {
    await api("PATCH", `/users/${userId}/watchlist`, { productId: product.id, channel, enabled: true }, shopper.token);
  }
  const socket = io(base, { auth: { token: shopper.token } });
  let alert;
  socket.on("notification", data => { alert = data; });
  try {
    await eventually("authenticated socket", () => socket.connected);
    const price = product.price - 50;
    await api("PATCH", `/catalog/${product.id}`, { version: product.version, price }, admin.token);
    await eventually("live alert", () => alert?.notification?._id);
    const inbox = await api("GET", `/notifications/${userId}`, null, shopper.token);
    assert.equal(inbox.data[0]._id, alert.notification._id);
    assert.equal((await api("GET", "/catalog", null, shopper.token))[0].price, price);
    await eventually("two successful channel deliveries", async () => {
      const metrics = await api("GET", "/analytics", null, admin.token);
      return metrics.successful === 2 && metrics.pending === 0 && metrics.failed === 0;
    });
    await api("POST", "/auth/forgot-password", { email });
    const mail = await eventually("reset email", async () => {
      const page = await (await fetch(mailbox + "/messages")).json();
      return page.messages.find(item => item.Subject.includes("Password Reset") && item.To.some(to => to.Address === email));
    });
    const message = await (await fetch(mailbox + "/message/" + mail.ID)).json();
    const token = message.HTML.match(/[a-f0-9]{40}/)?.[0];
    assert.ok(token, "Email contains a recovery code");
    const newPassword = "New1" + randomBytes(16).toString("hex");
    await api("POST", "/auth/reset-password", { token, newPassword });
    await api("GET", "/auth/me", null, shopper.token, 401);
    const fresh = await api("POST", "/auth/login", { email, password: newPassword });
    await api("DELETE", `/notifications/clear/${userId}`, null, fresh.token);
    assert.deepEqual((await api("GET", `/notifications/${userId}`, null, fresh.token)).data, []);
    console.log("Passed signup, authorization, subscriptions, saved inventory, real-time delivery, SMTP, recovery and inbox clearing.");
  } finally { socket.disconnect(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
