// Email via the Resend HTTPS API (https://resend.com) called directly - no
// nodemailer/SMTP setup required. Swap the endpoint/body in sendRaw() if you
// prefer SendGrid, Mailgun, Postmark, etc. - they're all a single JSON POST.
// If RESEND_API_KEY isn't set, emails are logged instead of sent.
const https = require('https');
const { isValidEmail } = require('../util');

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function sendRaw({ to, subject, html }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      html,
    });
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, data });
          else resolve({ ok: false, status: res.statusCode, data });
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: String(err) }));
    req.write(payload);
    req.end();
  });
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
      status: result.ok ? 'sent' : `failed: ${result.status || result.error}`,
    });
  }
  if (!result.ok) console.error('Email send failed:', result);
  return result;
}

module.exports = { sendEmail, emailConfigured };
