// Email via Gmail SMTP (smtp.gmail.com:587, STARTTLS), sent with nodemailer -
// the one npm dependency in this otherwise zero-dependency codebase (see
// CHANGELOG). Auth is a Gmail "app password" (16 chars, generated in the
// Google Account's security settings), never the real account password.
// If GMAIL_USER/GMAIL_APP_PASSWORD aren't set, emails are logged instead of sent.
const nodemailer = require('nodemailer');
const { isValidEmail } = require('../util');

function emailConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let cachedTransporter = null;
let cachedForUser = null;

// Rebuilds the transporter if GMAIL_USER changes (e.g. between tests) rather
// than caching one forever across a process that never changes its own env.
function transporter() {
  if (cachedTransporter && cachedForUser === process.env.GMAIL_USER) return cachedTransporter;
  cachedForUser = process.env.GMAIL_USER;
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS, not implicit TLS
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return cachedTransporter;
}

async function sendRaw({ to, subject, html }) {
  try {
    const info = await transporter().sendMail({
      from: `${process.env.BUSINESS_NAME || 'Shelves to Drawers RVA'} <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function sendEmail({ to, subject, html, customer_id, logMessage }) {
  if (!isValidEmail(to)) {
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'email', body: subject, status: 'no_email_address' });
    return { ok: false, reason: 'no_email_address' };
  }
  if (!emailConfigured()) {
    console.log(`[Email - not configured] Would email ${to}: ${subject}`);
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'email', body: subject, status: 'not_configured (see console)' });
    return { ok: false, reason: 'not_configured' };
  }
  const result = await sendRaw({ to, subject, html });
  if (logMessage) {
    logMessage({
      customer_id,
      direction: 'out',
      channel: 'email',
      body: subject,
      status: result.ok ? 'sent' : `failed: ${result.error}`,
    });
  }
  if (!result.ok) console.error('Email send failed:', result);
  return result;
}

module.exports = { sendEmail, emailConfigured };
