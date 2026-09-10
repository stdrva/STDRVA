const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers'); // throwaway DB before public.js -> db.js loads
const pub = require('../src/routes/public');

// ---- Address parsing (spec 5) ----
test('parseAddress: one-line "street, city, ST zip"', () => {
  const a = pub.parseAddress('123 Maple St, Richmond, VA 23220');
  assert.equal(a.line1, '123 Maple St');
  assert.equal(a.city, 'Richmond');
  assert.equal(a.state, 'VA');
  assert.equal(a.zip, '23220');
});

test('parseAddress: multi-line paste from Contacts / Maps', () => {
  const a = pub.parseAddress('123 Maple St\nRichmond, VA 23220');
  assert.equal(a.zip, '23220');
  assert.equal(a.state, 'VA');
  assert.match(a.full, /123 Maple St, Richmond, VA 23220/);
});

test('parseAddress: "street, city ST zip" (no comma before state)', () => {
  const a = pub.parseAddress('9 Oak Ave, Ashland VA 23005');
  assert.equal(a.state, 'VA');
  assert.equal(a.zip, '23005');
  assert.equal(a.city, 'Ashland');
});

test('addressLooksComplete: needs zip OR city+state OR known town; street-only is not enough', () => {
  assert.equal(pub.addressLooksComplete('123 Maple St'), false);
  assert.equal(pub.addressLooksComplete('123 Maple St, Richmond, VA 23220'), true);
  assert.equal(pub.addressLooksComplete('123 Maple St, Midlothian, VA'), true);
  assert.equal(pub.addressLooksComplete('50 Broad St, Richmond'), true); // known town
});

// ---- Service area is a routing preference, never a rejection (spec 6) ----
test('allowedDaysForAddress: out-of-area still returns business days (no rejection)', () => {
  const days = pub.allowedDaysForAddress('9 Nowhere Rd, Bangor, ME 04401');
  assert.ok(days.length >= 5 || days.length === 5); // Mon-Fri
  assert.deepEqual([...days].sort(), [1, 2, 3, 4, 5]);
});

test('allowedDaysForAddress: Caroline county -> Wednesday only (routing kept)', () => {
  assert.deepEqual(pub.allowedDaysForAddress('100 Main St, Bowling Green, VA 22427'), [3]);
});

// ---- Four spread options (spec 3) ----
test('pickSpreadSlots: returns at most 4, across multiple days, offset walks further', () => {
  const first = pub.pickSpreadSlots([1, 2, 3, 4, 5], 60, { count: 4, offset: 0 });
  assert.ok(first.slots.length <= 4);
  assert.ok(first.slots.length >= 3);
  const days = new Set(first.slots.map((d) => d.toISOString().slice(0, 10)));
  assert.ok(days.size >= 3, 'options should be spread across at least 3 days');

  const next = pub.pickSpreadSlots([1, 2, 3, 4, 5], 60, { count: 4, offset: 4 });
  const firstIsos = first.slots.map((d) => d.toISOString());
  assert.ok(next.slots.every((d) => !firstIsos.includes(d.toISOString())), 'offset must not repeat earlier options');

  // Not "the first four chronological openings" (which on an open calendar
  // would be four back-to-back hours on the very first day). Expect a mix of
  // days and a mix of times of day.
  assert.ok(days.size >= 3, 'not clustered on one or two days');
  const hours = new Set(first.slots.map((d) => d.getHours()));
  assert.ok(hours.size >= 2, 'not all the same time of day');
  const firstDayCount = first.slots.filter(
    (d) => d.toISOString().slice(0, 10) === first.slots[0].toISOString().slice(0, 10)
  ).length;
  assert.ok(firstDayCount <= 2, 'not stacked onto the first available day');
});
