const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');

test('SALES_STAGES has the 6 stages and no "Lost"', () => {
  assert.deepEqual(db.SALES_STAGES, [
    'Bona Fide Lead',
    'Design Appointment Set',
    'Design Appointment Completed',
    'Estimate Presented',
    'Sold',
    'Closed / We Declined Customer',
  ]);
  assert.ok(!db.SALES_STAGES.includes('Lost'));
  assert.ok(!db.SALES_STAGES.some((s) => /inquiry/i.test(s)));
});

test('new customer starts as Bona Fide Lead with first_contact_at set', () => {
  const c = db.createCustomer({ name: 'Stage Test', phone: '8045550001' });
  assert.equal(c.sales_stage, 'Bona Fide Lead');
  assert.ok(c.first_contact_at);
});

test('setSalesStage records history: field, old, new, timestamp, actor', () => {
  const c = db.createCustomer({ name: 'History Test' });
  db.setSalesStage(c.id, 'Design Appointment Set', { substatus: 'Upcoming', actor: 'user:andrew' });
  db.setSalesStage(c.id, 'Estimate Presented', { actor: 'assistant', note: 'sent the quote' });
  const hist = db.getCustomerStageHistory(c.id).filter((h) => h.field === 'sales_stage');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].old_value, 'Bona Fide Lead');
  assert.equal(hist[0].new_value, 'Design Appointment Set');
  assert.equal(hist[0].actor, 'user:andrew');
  assert.equal(hist[1].new_value, 'Estimate Presented');
  assert.equal(hist[1].actor, 'assistant');
  assert.ok(hist[1].note.includes('sent the quote'));
  assert.ok(hist.every((h) => h.created_at));
});

test('changing stage does NOT erase prior stage history', () => {
  const c = db.createCustomer({ name: 'Preserve Test' });
  db.setSalesStage(c.id, 'Design Appointment Set', { actor: 'user' });
  db.setSalesStage(c.id, 'Sold', { actor: 'user' });
  db.setSalesStage(c.id, 'Closed / We Declined Customer', { actor: 'user' });
  const stages = db
    .getCustomerStageHistory(c.id)
    .filter((h) => h.field === 'sales_stage')
    .map((h) => h.new_value);
  assert.deepEqual(stages, ['Design Appointment Set', 'Sold', 'Closed / We Declined Customer']);
});

test('unknown stage is rejected', () => {
  const c = db.createCustomer({ name: 'Bad Stage' });
  assert.throws(() => db.setSalesStage(c.id, 'Lost', { actor: 'user' }));
});

test('dormant is a flag, independent of stage; logged', () => {
  const c = db.createCustomer({ name: 'Dormant Test' });
  db.setSalesStage(c.id, 'Estimate Presented', { actor: 'user' });
  db.setCustomerDormant(c.id, true, { actor: 'user' });
  const fresh = db.getCustomer(c.id);
  assert.equal(fresh.dormant, 1);
  assert.equal(fresh.sales_stage, 'Estimate Presented'); // still active at its stage
  assert.ok(db.listActivityForCustomer(c.id).some((a) => a.field === 'dormant'));
});
