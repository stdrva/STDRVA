const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const assistant = require('../src/services/assistant');

test('unassign_file tool: removes a file from its customer, leaving customer_id null (spec: unassign_file)', () => {
  const c = db.createCustomer({ name: 'Filed Under Me' });
  const id = db.createCustomerFile({ customer_id: c.id, stored_name: 'a.pdf', original_name: 'a.pdf' });
  const result = assistant.runTool('unassign_file', { file_id: id });
  assert.equal(result.ok, true);
  assert.equal(result.customer_id, null);
  const f = db.getCustomerFile(id);
  assert.equal(f.customer_id, null);
  assert.equal(f.assignment_status, 'needs_review');
});

test('unassign_file tool: unknown file_id returns an error, not a silent no-op', () => {
  const result = assistant.runTool('unassign_file', { file_id: 'nope' });
  assert.match(result.error, /File not found/);
});

test('unassign_file: the unassigned file shows up in the Files page Needs Review panel', () => {
  const c = db.createCustomer({ name: 'Was Filed Here' });
  const id = db.createCustomerFile({ customer_id: c.id, stored_name: 'b.pdf', original_name: 'b.pdf' });
  assistant.runTool('unassign_file', { file_id: id });
  const review = db.listFilesNeedingReview();
  assert.ok(review.some((f) => f.id === id));
});

test('unassign_file tool is registered on the assistant', () => {
  assert.ok(assistant.TOOLS.some((t) => t.name === 'unassign_file'));
});
