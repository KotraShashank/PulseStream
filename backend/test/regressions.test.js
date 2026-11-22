const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");

// Exercise the Express router, JWT verification and permission middleware.
// Replace external transports and database I/O in this isolated test process.
function replaceModule(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
replaceModule("../src/config/redis", { redisHealthConnection: { eval: async () => 1 } });
replaceModule("../src/config/mail", { sendEmail: assert.fail });
const updates = [];
replaceModule("../src/config/socket", { getIO: () => ({ emit: (...args) => updates.push(args) }) });
const queue = { add: async () => {} };
replaceModule("../src/queues/fanout.queue", { fanoutQueue: queue });
const { dispatchPending } = require("../src/queues/event-dispatch");
const catalog = require("../src/routes/catalog");
const users = require("../src/routes/users");
const auth = require("../src/routes/auth");
const User = require("../src/models/User");
const { Event } = require("../src/models/Event");
const { Follow } = require("../src/models/Follow");
const { isAllowedOrigin } = require("../src/config/origin");
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.ADMIN_EMAIL = "admin@example.test";
const admin = { _id: String(new Types.ObjectId()), email: process.env.ADMIN_EMAIL };
const shopper = { _id: String(new Types.ObjectId()), email: "shopper@example.test" };
function query(value) {
  return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value };
}
function asUser(t, user = admin, version = 0) {
  t.mock.method(User, "findById", () => query(user));
  return jwt.sign({ id: user._id, version }, process.env.JWT_SECRET, { expiresIn: "1h" });
}
function request(router, method, url, body = {}, token) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, data }); },
    };
    const req = { method, url, path: url, body, headers: token ? { authorization: `Bearer ${token}` } : {} };
    router.handle(req, res, err => reject(err || new Error("Unmatched route")));
  });
}

test("catalog requires a current session", async () => {
  assert.equal((await request(catalog, "GET", "/")).status, 401);
});
test("password changes invalidate an older session", async t => {
  const token = asUser(t, { ...shopper, sessionVersion: 1 }, 0);
  assert.equal((await request(catalog, "GET", "/", {}, token)).status, 401);
});
test("shoppers can read the five products but cannot change inventory", async t => {
  const token = asUser(t, shopper);
  t.mock.method(Event, "findOne", () => query(null));
  const { data } = await request(catalog, "GET", "/", {}, token);
  assert.equal(data.length, 5);
  assert.equal(data[0].version, 0);
  assert.equal((await request(catalog, "PATCH", "/prod_1", { version: 0, price: 649 }, token)).status, 403);
});
test("inventory uses saved prices and rejects stale versions", async t => {
  const token = asUser(t);
  let saved;
  t.mock.method(Event, "findOne", () => query(saved));
  t.mock.method(Event, "find", () => query([]));
  t.mock.method(Event, "create", async row => { saved = row; });
  const first = await request(catalog, "PATCH", "/prod_1", { version: 0, price: 649 }, token);
  assert.equal(first.status, 200);
  assert.equal(saved.publishPending, true);
  assert.equal(saved.type, "price_drop");
  assert.equal(first.data.oldPrice, 699);
  assert.equal(updates.at(-1)[0], "catalog:update");
  const stale = await request(catalog, "PATCH", "/prod_1", { version: 0, inStock: false }, token);
  assert.equal(stale.status, 409);
  const stock = await request(catalog, "PATCH", "/prod_1", { version: 1, inStock: false }, token);
  assert.equal(stock.data.price, 649);
  assert.equal(stock.data.version, 2);
  assert.equal(saved.publishPending, false);
});
test("dispatch retries an unqueued event with a stable job ID", async t => {
  const row = { _id: String(new Types.ObjectId()), topicId: "prod_1", type: "price_drop", payload: {} };
  const ids = [];
  t.mock.method(Event, "find", () => query([row]));
  const acknowledged = t.mock.method(Event, "updateOne", async () => {});
  t.mock.method(queue, "add", async (_name, _data, opts) => {
    ids.push(opts.jobId);
    if (ids.length === 1) throw new Error("Fixture queue unavailable");
  });
  await dispatchPending();
  assert.equal(acknowledged.mock.callCount(), 0);
  await dispatchPending();
  assert.deepEqual(ids, [`event-${row._id}`, `event-${row._id}`]);
  assert.equal(acknowledged.mock.callCount(), 1);
});
test("watchlist saves return the admin role and the selected channels", async t => {
  const token = asUser(t);
  const write = t.mock.method(Follow, "updateOne", async () => {});
  t.mock.method(Follow, "deleteOne", async () => {});
  t.mock.method(Follow, "find", () => query([{ topicId: "prod_1", channels: ["inApp"] }]));
  const result = await request(users, "PATCH", `/${admin._id}/watchlist`,
    { productId: "prod_1", channel: "inApp", enabled: true }, token);
  assert.equal(result.status, 200);
  assert.equal(result.data.data.isAdmin, true);
  assert.deepEqual(result.data.data.subscriptions, [{ productId: "prod_1", inApp: true, email: false }]);
  assert.ok(write.mock.calls[0].arguments[1][0].$set.channels.$setUnion);
});
test("enable-all upserts requested products and preserves unrelated follows", async t => {
  const token = asUser(t);
  const writes = t.mock.method(Follow, "bulkWrite", async () => {});
  t.mock.method(Follow, "deleteMany", assert.fail);
  t.mock.method(Follow, "find", () => query([{ topicId: "custom", channels: ["email"] }]));
  const result = await request(users, "POST", `/${admin._id}/arm-all`, { productIds: ["prod_1", "prod_1"] }, token);
  assert.equal(writes.mock.calls[0].arguments[0].length, 1);
  assert.equal(result.data.data.subscriptions[0].productId, "custom");
});
test("configured administrator addresses are reserved at signup", async () => {
  const result = await request(auth, "POST", "/signup",
    { name: "Fixture User", email: admin.email, password: "SamplePass123" });
  assert.equal(result.status, 409);
});
test("missing recovery email transport gives the same result for any address", async () => {
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  for (const email of [shopper.email, "unknown@example.test"]) {
    const result = await request(auth, "POST", "/forgot-password", { email });
    assert.equal(result.status, 503);
    assert.equal(result.data.devResetToken, undefined);
  }
});
test("the configured production web origin is accepted", () => {
  process.env.FRONTEND_URL = "https://fixture.example/";
  process.env.NODE_ENV = "production";
  assert.equal(isAllowedOrigin("https://fixture.example"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), false);
});
