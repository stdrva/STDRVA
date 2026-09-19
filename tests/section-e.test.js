const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const { humanizeActivityValue } = require('../src/util');
const assistant = require('../src/services/assistant');

test('humanizeActivityValue: rewrites an ISO timestamp to readable US Eastern (spec E11)', () => {
  const out = humanizeActivityValue('2026-09-20T18:00:00.000Z');
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T/);
  assert.match(out, /ET$/);
});

test('humanizeActivityValue: plain text with no timestamp passes through unchanged', () => {
  assert.equal(humanizeActivityValue('Estimate Overdue'), 'Estimate Overdue');
  assert.equal(humanizeActivityValue(null), '');
});

test('updateJobSoldAmount: changes the sold amount (spec E3)', () => {
  const c = db.createCustomer({ name: 'Job Owner' });
  const job = db.createJob({ customer_id: c.id, sold_amount: 1000 });
  db.updateJobSoldAmount(job.id, 1500);
  assert.equal(db.getJob(job.id).sold_amount, 1500);
});

test('getJobBalance reflects sold amount minus payments, for Total Due (spec E2)', () => {
  const c = db.createCustomer({ name: 'Balance Customer' });
  const job = db.createJob({ customer_id: c.id, sold_amount: 2000 });
  db.createPayment({ job_id: job.id, amount: 500 });
  assert.equal(db.getJobBalance(job.id), 1500);
});

test('createPayment: stores the tax portion separately (spec E10)', () => {
  const c = db.createCustomer({ name: 'Tax Customer' });
  const job = db.createJob({ customer_id: c.id, sold_amount: 1000 });
  db.createPayment({ job_id: job.id, amount: 500, tax: 35.5 });
  const payment = db.listPayments().find((p) => p.job_id === job.id);
  assert.equal(payment.tax, 35.5);
});

test('setFollowupDueDate: snoozes without changing status (spec E8)', () => {
  const c = db.createCustomer({ name: 'Snooze Customer' });
  const f = db.createFollowup({ customer_id: c.id, title: 'Call back', due_at: '2026-01-01T00:00:00.000Z' });
  db.setFollowupDueDate(f.id, '2026-02-01T00:00:00.000Z');
  const updated = db.getFollowup(f.id);
  assert.equal(updated.due_at, '2026-02-01T00:00:00.000Z');
  assert.equal(updated.status, 'open');
});

test('setFollowupWaiting: sets and clears a "waiting on someone" note (spec E8)', () => {
  const c = db.createCustomer({ name: 'Waiting Customer' });
  const f = db.createFollowup({ customer_id: c.id, title: 'Send estimate' });
  db.setFollowupWaiting(f.id, 'the supplier quote');
  assert.equal(db.getFollowup(f.id).waiting_on, 'the supplier quote');
  db.setFollowupWaiting(f.id, '');
  assert.equal(db.getFollowup(f.id).waiting_on, null);
});

test('create_job tool requires confirmation and creates a real job (spec E6)', () => {
  const c = db.createCustomer({ name: 'Assistant Job Customer' });
  const unconfirmed = assistant.runTool('create_job', { customer_id: c.id, sold_amount: 800, confirmed: false });
  assert.match(unconfirmed.error, /Not created/);
  const result = assistant.runTool('create_job', { customer_id: c.id, sold_amount: 800, confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.job.sold_amount, 800);
  assert.equal(result.job.customer_id, c.id);
});

test('get_job_detail no longer includes product lines (spec: product lines hidden)', () => {
  const c = db.createCustomer({ name: 'No Products Customer' });
  const job = db.createJob({ customer_id: c.id, sold_amount: 500 });
  const result = assistant.runTool('get_job_detail', { job_id: job.id });
  assert.equal('products' in result, false);
  assert.ok('job' in result && 'payments' in result && 'balance_due' in result);
});

test('create_product tool remains removed (product lines hidden entirely)', () => {
  assert.ok(!assistant.TOOLS.some((t) => t.name === 'create_product'));
});
