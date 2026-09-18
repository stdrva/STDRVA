const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');

// Fresh require of email.js (and the nodemailer module it holds a reference
// to) per test, so the cached transporter and env-driven config never leak
// between cases.
function freshEmail() {
  delete require.cache[require.resolve('../src/services/email')];
  delete require.cache[require.resolve('nodemailer')];
  return require('../src/services/email');
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('sendEmail: NOT CONFIGURED when GMAIL_USER/GMAIL_APP_PASSWORD are unset - recorded, not thrown', async () => {
  await withEnv({ GMAIL_USER: undefined, GMAIL_APP_PASSWORD: undefined }, async () => {
    const email = freshEmail();
    assert.equal(email.emailConfigured(), false);
    const logged = [];
    const result = await email.sendEmail({
      to: 'customer@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      customer_id: 42,
      logMessage: (m) => logged.push(m),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].status, 'not_configured (see console)');
    assert.equal(logged[0].channel, 'email');
    assert.equal(logged[0].customer_id, 42);
  });
});

test('sendEmail: no_email_address when the address is invalid - never attempts to send', async () => {
  await withEnv({ GMAIL_USER: 'shop@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' }, async () => {
    const email = freshEmail();
    const logged = [];
    const result = await email.sendEmail({ to: 'not-an-email', subject: 'Hello', html: '<p>hi</p>', logMessage: (m) => logged.push(m) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_email_address');
    assert.equal(logged[0].status, 'no_email_address');
  });
});

test('sendEmail: successful send (mocked transporter) - reports sent and logs it', async () => {
  await withEnv({ GMAIL_USER: 'shop@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' }, async () => {
    const email = freshEmail();
    const nodemailer = require('nodemailer');
    const sendMail = mock.fn(async (msg) => {
      assert.equal(msg.to, 'customer@example.com');
      assert.match(msg.from, /^Shelves to Drawers RVA <shop@gmail\.com>$/);
      return { messageId: '<abc123@gmail.com>' };
    });
    mock.method(nodemailer, 'createTransport', () => ({ sendMail }));

    const logged = [];
    const result = await email.sendEmail({
      to: 'customer@example.com',
      subject: 'Your appointment',
      html: '<p>see you then</p>',
      customer_id: 7,
      logMessage: (m) => logged.push(m),
    });

    assert.equal(result.ok, true);
    assert.equal(sendMail.mock.calls.length, 1);
    assert.equal(logged[0].status, 'sent');
    assert.equal(logged[0].customer_id, 7);
  });
});

test('sendEmail: SMTP failure - reports failed, logs it, never throws', async () => {
  await withEnv({ GMAIL_USER: 'shop@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' }, async () => {
    const email = freshEmail();
    const nodemailer = require('nodemailer');
    mock.method(nodemailer, 'createTransport', () => ({
      sendMail: mock.fn(async () => {
        throw new Error('535 Authentication failed');
      }),
    }));

    const logged = [];
    const result = await email.sendEmail({
      to: 'customer@example.com',
      subject: 'Your appointment',
      html: '<p>see you then</p>',
      logMessage: (m) => logged.push(m),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Authentication failed/);
    assert.match(logged[0].status, /^failed: .*Authentication failed/);
  });
});
