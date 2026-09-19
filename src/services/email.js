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
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
  });
  return cachedTransporter;
}

// A bare-bones HTML-to-text fallback (spec F1.2) - HTML-only email is a known
// spam-filter signal. Good enough for the simple <p>/<br> bodies this app
// sends; not a general HTML renderer.
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendRaw({ to, subject, html }) {
  try {
    const info = await transporter().sendMail({
      from: `${process.env.BUSINESS_NAME || 'Shelves to Drawers RVA'} <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
      text: htmlToText(html),
    });
    // info.response is Gmail's raw SMTP response line (e.g. "250 2.0.0 OK
    // 1700000000 abc123-xyz - gsmtp") - accepted-for-delivery, not proof of
    // inbox arrival. Recorded in full (spec F1.1) rather than a bare "sent",
    // since acceptance and arrival are different things (see the AOL note).
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function sendEmail({ to, subject, html, customer_id, logMessage }) {
  if (!isValidEmail(to)) {
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'email', subject, body: html, to_address: to, status: 'no_email_address' });
    return { ok: false, reason: 'no_email_address' };
  }
  if (!emailConfigured()) {
    console.log(`[Email - not configured] Would email ${to}: ${subject}`);
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'email', subject, body: html, to_address: to, status: 'not_configured (see console)' });
    return { ok: false, reason: 'not_configured' };
  }
  const result = await sendRaw({ to, subject, html });
  if (logMessage) {
    logMessage({
      customer_id,
      direction: 'out',
      channel: 'email',
      subject,
      body: html,
      to_address: to,
      status: result.ok ? 'sent' : `failed: ${result.error}`,
      provider_response: result.ok ? result.response : result.error,
    });
  }
  if (!result.ok) console.error('Email send failed:', result);
  return result;
}

module.exports = { sendEmail, emailConfigured, htmlToText };
