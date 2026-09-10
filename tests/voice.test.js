const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const pub = require('../src/routes/public');
const assistant = require('../src/services/assistant');

test('voiceBookingSlots: spread ISO options, respects a requested date window', () => {
  const now = new Date();
  const from = new Date(now.getTime() + 20 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 45 * 86400000).toISOString().slice(0, 10);
  const r = pub.voiceBookingSlots({ address: '10 Main St, Richmond, VA 23220', type: 'Short Design Consultation', from_date: from, to_date: to, fromDate: from, toDate: to, count: 4 });
  assert.ok(r.slots.length >= 1 && r.slots.length <= 4);
  for (const s of r.slots) {
    assert.match(s.iso, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(s.iso.slice(0, 10) >= from && s.iso.slice(0, 10) <= to, s.iso + ' outside window');
    assert.doesNotMatch(s.label, /\d{4}-\d{2}-\d{2}T/); // readable label, not ISO
  }
});

test('voiceBookingSlots: near an area with an existing appointment lists those days first (spec 14)', () => {
  // Seed an existing appointment in Ashland (23005) ~2 weeks out on a weekday.
  const near = db.createCustomer({ name: 'Existing Nearby', address: '1 Center St, Ashland, VA 23005' });
  const d = new Date();
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6 || d < new Date(Date.now() + 12 * 86400000));
  const isoDay = d.toISOString().slice(0, 10);
  db.createAppointment({ customer_id: near.id, type: 'Short Design Consultation', scheduled_at: `${isoDay}T15:00:00.000Z` });

  const r = pub.voiceBookingSlots({ address: '99 Elm St, Ashland, VA 23005', near: '99 Elm St, Ashland, VA 23005', type: 'Short Design Consultation', count: 4 });
  assert.equal(r.used_geography, true);
  assert.match(r.note, /already has an appointment/i);
  assert.ok(r.slots.some((s) => s.nearby), 'at least one option flagged nearby');
  // the first option should be on a nearby day
  assert.equal(r.slots[0].nearby, true);
});

test('createBooking: full path - customer, lead, appointment, consultant credit', async () => {
  const now = new Date();
  const slot = new Date(now.getTime() + 15 * 86400000);
  slot.setHours(14, 0, 0, 0);
  while (slot.getDay() === 0 || slot.getDay() === 6) slot.setDate(slot.getDate() + 1);

  const r = await pub.createBooking({
    name: 'Donna Marsh',
    phone: '804-555-3131',
    email: 'donna.m@example.com',
    address: '4 Oak Ln, Bowling Green, VA 22427',
    slotIso: slot.toISOString(),
    type: 'Short Design Consultation',
    consultantName: 'Andrew',
    leadSource: 'Home Show',
    actor: 'assistant',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.customer.name, 'Donna Marsh');
  assert.ok(r.appt && r.appt.scheduled_at === slot.toISOString());
  const con = db.findConsultantByName('Andrew');
  assert.equal(r.customer.consultant_id, con.id);
  assert.equal(db.getAppointment(r.appt.id).consultant_id, con.id);
  const lead = db.listLeads().find((l) => l.customer_id === r.customer.id);
  assert.match(lead.source, /Home Show/);
});

test('createBooking: missing pieces -> ok:false, no write', async () => {
  const before = db.listCustomers().length;
  const r = await pub.createBooking({ name: 'Nobody', phone: '', email: 'bad', address: '', slotIso: '', actor: 'assistant' });
  assert.equal(r.ok, false);
  assert.equal(db.listCustomers().length, before);
});

test('assistant: voice booking tools registered; book_design_appointment is confirm-gated', () => {
  const names = assistant.TOOLS.map((t) => t.name);
  assert.ok(names.includes('list_available_slots'));
  assert.ok(names.includes('book_design_appointment'));

  const gate = assistant.runTool('book_design_appointment', {
    name: 'X', phone: '1', email: 'x@y.com', address: 'a', scheduled_at: '2026-10-01T14:00:00Z', confirmed: false,
  });
  assert.ok(gate.error && /confirmed:true/.test(gate.error));

  const marker = assistant.runTool('book_design_appointment', {
    name: 'X', phone: '1', email: 'x@y.com', address: 'a', scheduled_at: '2026-10-01T14:00:00Z', confirmed: true,
  });
  assert.ok(marker.__async_booking, 'confirmed call yields the async-booking marker');
});

test('list_available_slots tool returns readable options', () => {
  const r = assistant.runTool('list_available_slots', { address: '10 Main St, Richmond, VA 23220', count: 3 });
  assert.ok(Array.isArray(r.slots));
  if (r.slots.length) assert.doesNotMatch(r.slots[0].label, /T\d{2}:\d{2}/);
});
