const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const assistant = require('../src/services/assistant');

test('consultant: upsert by name is find-or-create, case-insensitive', () => {
  const a = db.upsertConsultantByName('Andrew Kerwin');
  const b = db.upsertConsultantByName('  andrew kerwin ');
  assert.equal(a.id, b.id);
  assert.equal(db.listConsultants().length, 1);
});

test('scoreboard: lead-capture credit and appointment-booked credit are separate (spec 9)', () => {
  const con = db.upsertConsultantByName('Booth Rep');
  // consultant captures a lead but books NO appointment
  const c1 = db.createCustomer({ name: 'Lead Only' });
  db.setCustomerConsultant(c1.id, con.id, { actor: 'test' });
  // consultant captures a second lead AND books an appointment
  const c2 = db.createCustomer({ name: 'Lead + Appt' });
  db.setCustomerConsultant(c2.id, con.id, { actor: 'test' });
  db.createAppointment({ customer_id: c2.id, type: 'Short Design Consultation', scheduled_at: '2026-10-05T14:00:00Z', consultant_id: con.id });

  const row = db.consultantScoreboard().find((s) => s.id === con.id);
  assert.equal(row.leads_captured, 2, 'both leads counted');
  assert.equal(row.appointments_booked, 1, 'only one appointment counted');
  assert.equal(row.appointments_completed, 0);
  assert.equal(row.show_rate, 0);
});

test('scoreboard: show rate + revenue', () => {
  const con = db.upsertConsultantByName('Show Rate Rep');
  const c = db.createCustomer({ name: 'SR Cust' });
  db.setCustomerConsultant(c.id, con.id, { actor: 'test' });
  const a = db.createAppointment({ customer_id: c.id, type: 'Design Review', scheduled_at: '2026-10-06T14:00:00Z', consultant_id: con.id });
  db.setAppointmentStatusTracked(a.id, 'completed', { actor: 'test' });
  const lead = db.createLead({ customer_id: c.id, stage: 'Sold', consultant_id: con.id });
  db.createJob({ customer_id: c.id, lead_id: lead.id, sold_amount: 5000 });

  const row = db.consultantScoreboard().find((s) => s.id === con.id);
  assert.equal(row.appointments_completed, 1);
  assert.equal(row.show_rate, 1);
  assert.equal(row.jobs_sold, 1);
  assert.equal(row.revenue, 5000);
});

test('setCustomerConsultant cascades to the open lead and logs the credit', () => {
  const con = db.upsertConsultantByName('Cascade Rep');
  const c = db.createCustomer({ name: 'Cascade Cust' });
  const lead = db.createLead({ customer_id: c.id, stage: 'Contacted' });
  db.setCustomerConsultant(c.id, con.id, { actor: 'user:andrew' });
  assert.equal(db.getLead(lead.id).consultant_id, con.id);
  assert.ok(db.listActivityForCustomer(c.id).some((x) => x.field === 'sales_consultant' && x.new_value === 'Cascade Rep'));
});

test("existing customer's consultant is not stolen by a re-book", () => {
  const first = db.upsertConsultantByName('First Rep');
  const second = db.upsertConsultantByName('Second Rep');
  const c = db.createCustomer({ name: 'Loyal Cust' });
  db.setCustomerConsultant(c.id, first.id, { actor: 'test' });
  // simulate the booking-flow guard: only set if not already set
  const fresh = db.getCustomer(c.id);
  if (!fresh.consultant_id) db.setCustomerConsultant(c.id, second.id, { actor: 'test' });
  assert.equal(db.getCustomer(c.id).consultant_id, first.id);
});

test('assistant tool set_home_show_consultant credits the consultant + appointments', () => {
  const c = db.createCustomer({ name: 'Donna Voice' });
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-11-01T15:00:00Z' });
  const r = assistant.runTool('set_home_show_consultant', { customer_id: c.id, consultant_name: 'Andrew' });
  assert.equal(r.ok, true);
  assert.equal(r.consultant, 'Andrew');
  const con = db.findConsultantByName('Andrew');
  assert.equal(db.getCustomer(c.id).consultant_id, con.id);
  assert.equal(db.getAppointment(appt.id).consultant_id, con.id);
  // Home Show attribution recorded
  const attr = db.getCustomerAttribution(c.id);
  assert.ok(attr && attr.history.some((h) => /Home Show/.test(h.note || '')));
});

test('set_home_show_consultant + list_consultants registered as tools', () => {
  const names = assistant.TOOLS.map((t) => t.name);
  assert.ok(names.includes('set_home_show_consultant'));
  assert.ok(names.includes('list_consultants'));
});
