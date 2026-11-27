const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isMailConfigured, sendEmail } = require("../src/config/mail");

// This test file runs in its own process. Use fixture credentials and intercept all HTTPS calls.
const recipient = "shopper@example.test";
process.env.RESEND_API_KEY = "fixture-key";
process.env.EMAIL_FROM = "PulseStream <alerts@example.test>";

test("alerts use HTTPS and reuse the delivery key on a retry", async t => {
  const requests = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "test-id" }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await sendEmail(recipient, "Price drop", "<p>Updated price</p>", "watchlist/123");
  }
  for (const call of requests.mock.calls) {
    const [url, options] = call.arguments;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer fixture-key");
    assert.equal(options.headers["Idempotency-Key"], "watchlist/123");
    assert.deepEqual(JSON.parse(options.body), {
      from: process.env.EMAIL_FROM, to: [recipient], subject: "Price drop", html: "<p>Updated price</p>",
    });
  }
  assert.equal(requests.mock.callCount(), 2);
});

test("password reset mail needs a provider receipt and surfaces delivery failures", async t => {
  const responses = [
    Response.json({ id: "reset-id" }), Response.json({}), new Response(null, { status: 429 }),
  ];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["Idempotency-Key"], undefined);
    return responses.shift();
  });
  const sendReset = () => sendEmail(recipient, "Password reset", "<p>Fixture reset code</p>");
  assert.equal(await sendReset(), true);
  await assert.rejects(sendReset(), /no message ID/);
  await assert.rejects(sendReset(), /HTTP 429/);
});

test("an incomplete HTTPS configuration fails before attempting a delivery", async t => {
  process.env.EMAIL_FROM = "";
  t.after(() => { process.env.EMAIL_FROM = "PulseStream <alerts@example.test>"; });
  t.mock.method(globalThis, "fetch", assert.fail);
  assert.equal(isMailConfigured(), false);
  await assert.rejects(sendEmail(recipient, "Price drop", "Update"), /not configured/);
});
