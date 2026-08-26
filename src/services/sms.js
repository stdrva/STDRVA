// SMS via Twilio's REST API, called directly over HTTPS (no `twilio` npm package
// required). If Twilio env vars aren't set, messages are logged to the console
// and to the messages table with status 'not_configured' instead of failing.
const https = require('https');
const { normalizePhone } = require('../util');

function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function sendRaw({ to, body }) {
  return new Promise((resolve) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const params = new URLSearchParams({ To: to, From: from, Body: body }).toString();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${sid}/Messages.json`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, data });
          } else {
            resolve({ ok: false, status: res.statusCode, data });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: String(err) }));
    req.write(params);
    req.end();
  });
}

// Sends a text and always logs it to the messages table (via the db module,
// passed in as `logMessage` to avoid a circular require).
async function sendSms({ to, body, customer_id, logMessage }) {
  const toNorm = normalizePhone(to);
  if (!toNorm) {
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'sms', body, status: 'no_phone_number' });
    return { ok: false, reason: 'no_phone_number' };
  }
  if (!twilioConfigured()) {
    console.log(`[SMS - Twilio not configured] Would text ${toNorm}: ${body}`);
    if (logMessage) logMessage({ customer_id, direction: 'out', channel: 'sms', body, status: 'not_configured (see console)' });
    return { ok: false, reason: 'not_configured' };
  }
  const result = await sendRaw({ to: toNorm, body });
  if (logMessage) {
    logMessage({
      customer_id,
      direction: 'out',
      channel: 'sms',
      body,
      status: result.ok ? 'sent' : `failed: ${result.status || result.error}`,
    });
  }
  if (!result.ok) console.error('Twilio send failed:', result);
  return result;
}

module.exports = { sendSms, twilioConfigured };
