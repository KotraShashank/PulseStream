const nodemailer = require("nodemailer");

function isMailConfigured() {
  if (process.env.RESEND_API_KEY) return Boolean(process.env.EMAIL_FROM?.trim());
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

let smtpTransport;

async function sendEmail(to, subject, html, idempotencyKey) {
  if (!isMailConfigured()) throw new Error("Email delivery is not configured");

  if (process.env.RESEND_API_KEY) {
    const headers = {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({ from: process.env.EMAIL_FROM.trim(), to: [to], subject, html }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Email provider rejected delivery (HTTP ${response.status})`);
    const receipt = await response.json();
    if (!receipt?.id) throw new Error("Email provider returned no message ID");
    return true;
  }

  const port = Number(process.env.SMTP_PORT) || 465;
  smtpTransport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  await smtpTransport.sendMail({
    from: `"PulseStream Alerts" <${process.env.SMTP_USER}>`,
    to, subject, html,
  });
  return true;
}

module.exports = { isMailConfigured, sendEmail };
