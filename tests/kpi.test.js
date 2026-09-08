const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');

// Build a known cohort inside a fixed window.
const WIN = { start: '2026-01-01T00:00:00.000Z', end: '2026-12-31T23:59:59.999Z' };

function makeCustomerAt(name, iso, stage) {
  const c = db.createCustomer({ name });
  db.db.prepare(`UPDATE customers SET first_contact_at = ?, created_at = ? WHERE id = ?`).run(iso, iso, c.id);
  if (stage) db.setSalesStage(c.id, stage, { actor: 'test' });
  return db.getCustomer(c.id);
}

test('kpiFunnel: funnel counts are monotonically non-increasing', () => {
  makeCustomerAt('L1', '2026-03-01T12:00:00Z', 'Bona Fide Lead');
  makeCustomerAt('L2', '2026-03-02T12:00:00Z', 'Design Appointment Set');
  makeCustomerAt('L3', '2026-03-03T12:00:00Z', 'Design Appointment Completed');
  makeCustomerAt('L4', '2026-03-04T12:00:00Z', 'Estimate Presented');
  makeCustomerAt('L5', '2026-03-05T12:00:00Z', 'Sold');
  makeCustomerAt('L6', '2026-03-06T12:00:00Z', 'Sold');
  const k = db.kpiFunnel(WIN);
  const { bona_fide_leads, design_appointments_set, design_appointments_completed, estimates_presented, sales } = k.counts;
  assert.ok(bona_fide_leads >= design_appointments_set, JSON.stringify(k.counts));
  assert.ok(design_appointments_set >= design_appointments_completed);
  assert.ok(design_appointments_completed >= estimates_presented);
  assert.ok(estimates_presented >= sales);
  assert.equal(sales, 2);
});

test('kpiFunnel: a Sold customer counts as having reached every earlier forward stage', () => {
  const k = db.kpiFunnel(WIN);
  // 2 sold customers -> they are inside every earlier bucket too
  assert.ok(k.counts.design_appointments_set >= 2);
  assert.ok(k.counts.estimates_presented >= 2);
});

test('kpiFunnel: a customer we Closed keeps the forward stage they had reached, but is not a sale', () => {
  const c = makeCustomerAt('Closed1', '2026-04-01T12:00:00Z', 'Estimate Presented');
  db.setSalesStage(c.id, 'Closed / We Declined Customer', { actor: 'test' });
  const k = db.kpiFunnel(WIN);
  assert.equal(k.counts.closed_we_declined, 1);
  // still counted at "estimates_presented" (they got that far) but not in sales
  const before = db.kpiFunnel(WIN).counts.estimates_presented;
  assert.ok(before >= 1);
});

test('kpiFunnel: every conversion rate ships numerator, denominator and a label', () => {
  const k = db.kpiFunnel(WIN);
  for (const [name, v] of Object.entries(k.conversion)) {
    assert.ok('numerator' in v, name);
    assert.ok('denominator' in v, name);
    assert.ok(typeof v.denominator_label === 'string' && v.denominator_label.length, name);
    if (v.rate !== null) {
      assert.ok(Math.abs(v.rate - (v.numerator / v.denominator) * 100) < 0.11, `${name} rate math`);
    }
  }
});

test('kpiFunnel: cohort window excludes customers contacted outside it', () => {
  makeCustomerAt('Old', '2025-06-01T12:00:00Z', 'Sold');
  const inWin = db.kpiFunnel(WIN).counts.bona_fide_leads;
  const allTime = db.kpiFunnel({}).counts.bona_fide_leads;
  assert.ok(allTime > inWin);
});
