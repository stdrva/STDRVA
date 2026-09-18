const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const assistant = require('../src/services/assistant');

function makeCustomer(name) {
  return db.createCustomer({ name });
}

test('findConfidentCustomerByName: exact single match', () => {
  const c = makeCustomer('Zelda Huffington');
  makeCustomer('Someone Else');
  const found = db.findConfidentCustomerByName('please file this under Zelda Huffington, thanks');
  assert.equal(found.id, c.id);
});

test('findConfidentCustomerByName: no match returns null, never guesses', () => {
  makeCustomer('Zelda Huffington');
  assert.equal(db.findConfidentCustomerByName('this is for nobody in particular'), null);
});

test('findConfidentCustomerByName: ambiguous (two customers with the identical name) returns null', () => {
  makeCustomer('Pat Morgan');
  makeCustomer('Pat Morgan'); // same full name, e.g. a duplicate/relative entry
  assert.equal(db.findConfidentCustomerByName('this receipt is for Pat Morgan'), null);
});

test('decideFileAssignment: a named customer beats the on-screen customer (spec B4)', () => {
  const onScreen = makeCustomer('On Screen Customer');
  const named = makeCustomer('Actually Named Person');
  const decision = db.decideFileAssignment({ message: 'file this for Actually Named Person', ctxCustomer: onScreen });
  assert.equal(decision.assignment_status, 'confirmed');
  assert.equal(decision.customer_id, named.id);
  assert.equal(decision.suggested_customer_id, null);
});

test('decideFileAssignment: no name, on-screen customer present -> unconfirmed suggestion, not attached', () => {
  const onScreen = makeCustomer('Just Viewing');
  const decision = db.decideFileAssignment({ message: 'here is the receipt', ctxCustomer: onScreen });
  assert.equal(decision.assignment_status, 'unconfirmed');
  assert.equal(decision.customer_id, null); // never silently attached
  assert.equal(decision.suggested_customer_id, onScreen.id);
});

test('decideFileAssignment: no name, no on-screen customer -> needs_review', () => {
  const decision = db.decideFileAssignment({ message: 'here is a file', ctxCustomer: null });
  assert.equal(decision.assignment_status, 'needs_review');
  assert.equal(decision.customer_id, null);
  assert.equal(decision.suggested_customer_id, null);
});

test('setFileAssignment + listFilesNeedingReview: unconfirmed and needs_review both surface, confirmed does not', () => {
  const suggested = makeCustomer('Suggested Customer');
  const id1 = db.createCustomerFile({ customer_id: null, stored_name: 'a.pdf', original_name: 'a.pdf', assignment_status: 'unconfirmed', suggested_customer_id: suggested.id });
  const id2 = db.createCustomerFile({ customer_id: null, stored_name: 'b.pdf', original_name: 'b.pdf', assignment_status: 'needs_review' });
  const id3 = db.createCustomerFile({ customer_id: suggested.id, stored_name: 'c.pdf', original_name: 'c.pdf' }); // normal, confirmed-equivalent

  const review = db.listFilesNeedingReview();
  const ids = review.map((f) => f.id);
  assert.ok(ids.includes(id1) && ids.includes(id2));
  assert.ok(!ids.includes(id3));
  assert.equal(review.find((f) => f.id === id1).suggested_customer_name, 'Suggested Customer');
});

test('setFileAssignment: confirm resolves an unconfirmed suggestion', () => {
  const suggested = makeCustomer('Confirm Me');
  const id = db.createCustomerFile({ customer_id: null, stored_name: 'x.pdf', original_name: 'x.pdf', assignment_status: 'unconfirmed', suggested_customer_id: suggested.id });
  db.setFileAssignment(id, { customer_id: suggested.id, assignment_status: 'confirmed' });
  const f = db.getCustomerFile(id);
  assert.equal(f.customer_id, suggested.id);
  assert.equal(f.assignment_status, 'confirmed');
  assert.equal(db.listFilesNeedingReview().some((r) => r.id === id), false);
});

test('setFileAssignment: undo reverts to needs_review with no customer', () => {
  const suggested = makeCustomer('Undo Target');
  const id = db.createCustomerFile({ customer_id: null, stored_name: 'y.pdf', original_name: 'y.pdf', assignment_status: 'unconfirmed', suggested_customer_id: suggested.id });
  db.setFileAssignment(id, { customer_id: null, assignment_status: 'needs_review' });
  const f = db.getCustomerFile(id);
  assert.equal(f.customer_id, null);
  assert.equal(f.assignment_status, 'needs_review');
  assert.equal(f.suggested_customer_id, null);
});

test('move_file_to_customer tool re-files a file and returns the customer name', () => {
  const wrong = makeCustomer('Wrong Person');
  const right = makeCustomer('Right Person');
  const id = db.createCustomerFile({ customer_id: wrong.id, stored_name: 'z.pdf', original_name: 'z.pdf' });
  const result = assistant.runTool('move_file_to_customer', { file_id: id, customer_id: right.id });
  assert.equal(result.ok, true);
  assert.equal(result.customer_name, 'Right Person');
  const f = db.getCustomerFile(id);
  assert.equal(f.customer_id, right.id);
  assert.equal(f.assignment_status, 'confirmed');
});

test('create_product tool has been removed entirely (spec B6)', () => {
  assert.ok(!assistant.TOOLS.some((t) => t.name === 'create_product'));
  const result = assistant.runTool('create_product', { job_id: 'x', name: 'y', confirmed: true });
  assert.match(result.error, /Unknown tool/);
});
