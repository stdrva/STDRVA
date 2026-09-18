const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const pub = require('../src/routes/public');

test('bookingContact: split address fields recombine into the single address string (spec C3)', () => {
  const q = { name: 'Dana Fields', phone: '8045551212', email: 'dana@example.com', address_line1: '10 Main St', address_city: 'Richmond', address_state: 'VA', address_zip: '23220' };
  const r = pub.bookingContact(q);
  assert.equal(r.address, '10 Main St, Richmond, VA 23220');
  assert.equal(r.hasContact, true);
  // The combined value is written back onto q so contactQS()/downstream links carry it forward.
  assert.equal(q.address, '10 Main St, Richmond, VA 23220');
});

test('bookingContact: an explicit combined address always wins over split fields', () => {
  const q = { address: 'already combined', address_line1: 'ignored' };
  assert.equal(pub.bookingContact(q).address, 'already combined');
});

test('bookingContact: no address fields at all - empty address, hasContact false', () => {
  const r = pub.bookingContact({ name: 'X', phone: '8045551212', email: 'x@example.com' });
  assert.equal(r.address, '');
  assert.equal(r.hasContact, false);
});

test('upsertDiscoverySection: first save appends the discovery block', () => {
  const result = pub.upsertDiscoverySection('', 'Rooms: Kitchen');
  assert.match(result, /\[Discovery\]/);
  assert.match(result, /Rooms: Kitchen/);
});

test('upsertDiscoverySection: a second save overwrites the first instead of duplicating (spec C6)', () => {
  const first = pub.upsertDiscoverySection('', 'Rooms: Kitchen');
  const second = pub.upsertDiscoverySection(first, 'Rooms: Kitchen, Bathroom(s) | Pets: yes, treat OK: Yes');
  const occurrences = (second.match(/\[Discovery\]/g) || []).length;
  assert.equal(occurrences, 1);
  assert.match(second, /Pets: yes/);
  assert.equal(second.match(/Rooms:/g).length, 1); // old "Rooms: Kitchen" line is gone, not just added-to
});

test('upsertDiscoverySection: preserves notes written before the discovery block', () => {
  const withManualNote = 'Andrew: called to confirm parking.';
  const saved = pub.upsertDiscoverySection(withManualNote, 'Rooms: Kitchen');
  assert.match(saved, /^Andrew: called to confirm parking\./);
  assert.match(saved, /Rooms: Kitchen/);
  const resaved = pub.upsertDiscoverySection(saved, 'Rooms: Kitchen, Garage');
  assert.match(resaved, /^Andrew: called to confirm parking\./);
  assert.equal((resaved.match(/Andrew: called to confirm parking\./g) || []).length, 1);
});
