const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { db } = require('./helpers');

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
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test('htmlToText: strips tags and unescapes entities (spec F1.2)', () => {
  const email = require('../src/services/email');
  assert.equal(email.htmlToText('<p>Hi Jane,</p><p>See you Tuesday.</p>'), 'Hi Jane,\n\nSee you Tuesday.');
  assert.equal(email.htmlToText('Line one<br>Line two'), 'Line one\nLine two');
  assert.equal(email.htmlToText('Tom &amp; Jerry'), 'Tom & Jerry');
});

test('sendEmail: logs the full body (not just the subject) and the provider response (spec F1.1/F2.1)', async () => {
  await withEnv({ GMAIL_USER: 'shop@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' }, async () => {
    const email = freshEmail();
    const nodemailer = require('nodemailer');
    mock.method(nodemailer, 'createTransport', () => ({
      sendMail: mock.fn(async (msg) => {
        assert.equal(msg.text, 'See you Tuesday at 2pm.');
        return { messageId: '<abc@gmail.com>', response: '250 2.0.0 OK 1700000000 abc123 - gsmtp' };
      }),
    }));
    const logged = [];
    await email.sendEmail({
      to: 'customer@example.com',
      subject: 'Your appointment',
      html: '<p>See you Tuesday at 2pm.</p>',
      customer_id: 5,
      logMessage: (m) => logged.push(m),
    });
    assert.equal(logged[0].subject, 'Your appointment');
    assert.equal(logged[0].body, '<p>See you Tuesday at 2pm.</p>');
    assert.match(logged[0].provider_response, /250 2\.0\.0 OK/);
  });
});

test('messages.customer_id is nullable and listAllMessages includes no-customer sends (spec F2.3)', () => {
  const id = db.logMessage({ customer_id: null, direction: 'out', channel: 'email', subject: 'Copy for Andrew', body: 'fyi', to_address: 'andrew@example.com', status: 'sent' });
  const all = db.listAllMessages({ limit: 500 });
  const found = all.find((m) => m.id === id);
  assert.ok(found, 'no-customer message should be listed');
  assert.equal(found.customer_id, null);
  assert.equal(found.customer_name, null);
  assert.equal(found.to_address, 'andrew@example.com');
});

test('getMessage returns full detail including subject and provider_response', () => {
  const id = db.logMessage({ customer_id: null, direction: 'out', channel: 'email', subject: 'Test', body: 'body text', to_address: 'x@example.com', status: 'sent', provider_response: '250 OK' });
  const m = db.getMessage(id);
  assert.equal(m.subject, 'Test');
  assert.equal(m.provider_response, '250 OK');
});

test('send_email tool requires confirmation, validates the address, and can send with no customer (spec F3)', async () => {
  const assistant = require('../src/services/assistant');
  const unconfirmed = assistant.runTool('send_email', { to: 'andrew@example.com', subject: 'x', body: 'y', confirmed: false });
  assert.match(unconfirmed.error, /Not sent/);

  const badAddress = assistant.runTool('send_email', { to: 'not-an-email', subject: 'x', body: 'y', confirmed: true });
  assert.match(badAddress.error, /valid email/);

  const marker = assistant.runTool('send_email', { to: 'andrew@example.com', subject: 'Copy', body: 'fyi', confirmed: true });
  assert.ok(marker.__async_email);
  assert.equal(marker.__async_email.customer_id, null);
  assert.equal(marker.__async_email.to, 'andrew@example.com');
});

test('send_email tool rejects an unknown customer_id rather than silently sending unattributed', () => {
  const assistant = require('../src/services/assistant');
  const result = assistant.runTool('send_email', { to: 'andrew@example.com', subject: 'x', body: 'y', customer_id: 'nope', confirmed: true });
  assert.match(result.error, /Customer not found/);
});
