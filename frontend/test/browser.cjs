const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { chromium } = require("playwright-core");

const site = "http://127.0.0.1:5173";
const product = "PlayStation 5 Pro";

async function checkWidths(page) {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const contentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(contentWidth <= width, `Page overflows at ${width}px (${contentWidth}px)`);
  }
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
  const pageErrors = [];
  try {
    const shopper = await browser.newPage({ viewport: { width: 360, height: 800 } });
    const admin = await browser.newPage();
    for (const page of [shopper, admin]) {
      page.on("pageerror", error => pageErrors.push(error.message));
      page.setDefaultTimeout(20000);
    }
    await shopper.goto(site);
    await shopper.getByRole("button", { name: /Need an account/ }).click();
    const password = "Example1" + randomBytes(12).toString("hex");
    await shopper.getByLabel("Full Name").fill("Browser Shopper");
    await shopper.getByLabel("Email Address").fill(`browser-${randomBytes(5).toString("hex")}@example.test`);
    await shopper.getByLabel("Password", { exact: true }).fill(password);
    await shopper.getByLabel("Confirm Password", { exact: true }).fill(password);
    await shopper.getByRole("button", { name: "Sign Up Now" }).click();
    const toggle = shopper.getByRole("button", { name: `In-app alerts for ${product}` });
    await toggle.click();
    await shopper.getByRole("button", { name: `In-app alerts for ${product}`, pressed: true }).waitFor();
    await shopper.reload();
    await shopper.getByRole("button", { name: `In-app alerts for ${product}`, pressed: true }).waitFor();
    await checkWidths(shopper);
    assert.equal(await shopper.getByRole("button", { name: /Admin Center/ }).count(), 0);

    await admin.goto(site);
    await admin.getByLabel("Email Address").fill(process.env.ADMIN_EMAIL);
    await admin.getByLabel("Password", { exact: true }).fill(process.env.ADMIN_PASSWORD);
    await admin.getByRole("button", { name: "Sign In", exact: true }).click();
    await admin.getByRole("button", { name: /Admin Center/ }).click();
    await admin.getByRole("heading", { name: product }).waitFor();
    await checkWidths(admin);
    await admin.getByRole("button", { name: "-$50", exact: true }).first().click();
    await shopper.getByRole("heading", { name: /Price Drop Alert: PlayStation 5 Pro/ }).waitFor();
    await shopper.setViewportSize({ width: 360, height: 800 });
    await shopper.getByRole("button", { name: "Recent alerts" }).click();
    await shopper.getByRole("button", { name: "Clear", exact: true }).click();
    await shopper.getByText("No alerts yet", { exact: true }).waitFor();
    await shopper.getByRole("button", { name: "Sign Out" }).click();
    await shopper.getByRole("button", { name: "Sign In", exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
    console.log("Chrome passed signup, admin login, watchlist persistence, price drops, live inbox, clearing, logout and three viewport widths.");
  } finally {
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
