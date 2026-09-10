const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');

// ---- Production URL config (spec 1) ----
test('baseUrl: BASE_URL wins, then RENDER_EXTERNAL_URL, then localhost; trailing slash stripped', () => {
  const saved = { b: process.env.BASE_URL, r: process.env.RENDER_EXTERNAL_URL, p: process.env.PUBLIC_BASE_URL };
  delete require.cache[require.resolve('../src/services/automations')];
  const a = require('../src/services/automations');

  delete process.env.BASE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  delete process.env.PUBLIC_BASE_URL;
  assert.match(a.baseUrl(), /^http:\/\/localhost:\d+$/);
  assert.equal(a.baseUrlIsLocal(), true);

  process.env.RENDER_EXTERNAL_URL = 'https://stdrva.onrender.com/';
  assert.equal(a.baseUrl(), 'https://stdrva.onrender.com');
  assert.equal(a.baseUrlIsLocal(), false);
  assert.equal(a.bookingUrl(), 'https://stdrva.onrender.com/book');

  process.env.BASE_URL = 'https://crm.example.com';
  assert.equal(a.baseUrl(), 'https://crm.example.com');

  process.env.BASE_URL = saved.b || '';
  process.env.RENDER_EXTERNAL_URL = saved.r || '';
  if (!saved.b) delete process.env.BASE_URL;
  if (!saved.r) delete process.env.RENDER_EXTERNAL_URL;
  if (!saved.p) delete process.env.PUBLIC_BASE_URL;
});

// ---- Assistant upload with no active customer must not throw (spec 16) ----
test('customer_files.customer_id is nullable - assistant upload with no customer context works', () => {
  const info = db.db.prepare('PRAGMA table_info(customer_files)').all();
  assert.equal(info.find((c) => c.name === 'customer_id').notnull, 0);

  const id = db.createCustomerFile({
    customer_id: null,
    stored_name: 'x.txt',
    original_name: 'receipt.txt',
    mime_type: 'text/plain',
    size: 10,
    note: 'Uploaded via assistant chat',
  });
  assert.ok(id);
  const row = db.getCustomerFile(id);
  assert.equal(row.customer_id, null);
  assert.equal(row.original_name, 'receipt.txt');
  // still searchable
  assert.ok(db.searchFiles('receipt').some((f) => f.id === id));
});

// ---- navigate_to_record tool (spec 19) ----
test('navigate_to_record resolves BOS routes and validates records', () => {
  const assistant = require('../src/services/assistant');
  const c = db.createCustomer({ name: 'Leora Copeland', phone: '8045430608' });
  const a = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-09-20T18:00:00Z' });

  let r = assistant.runTool('navigate_to_record', { type: 'customer', customer_id: c.id });
  assert.equal(r.__navigate, `/dashboard/customers/${c.id}`);
  assert.equal(r.customer_id, c.id);

  r = assistant.runTool('navigate_to_record', { type: 'appointment', appointment_id: a.id });
  assert.equal(r.__navigate, `/dashboard/appointments/${a.id}/edit`);
  assert.equal(r.customer_id, c.id);

  r = assistant.runTool('navigate_to_record', { type: 'production' });
  assert.equal(r.__navigate, '/dashboard/production');

  r = assistant.runTool('navigate_to_record', { type: 'customer', customer_id: 'nope' });
  assert.ok(r.error && !r.__navigate);

  r = assistant.runTool('navigate_to_record', { type: 'files' });
  assert.equal(r.__navigate, '/dashboard/files');
});

test('navigate_to_record tool is registered and exposed to the model', () => {
  const assistant = require('../src/services/assistant');
  assert.ok(assistant.TOOLS.some((t) => t.name === 'navigate_to_record'));
});
