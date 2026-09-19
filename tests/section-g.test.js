const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const automations = require('../src/services/automations');

function makeApptCustomer() {
  return db.createCustomer({ name: 'Dana Rivers', phone: '8045551212', email: 'dana@example.com', address: '9 Elm St, Ashland, VA 23005' });
}

test('createAppointment: gets its own private public_token, distinct from any job token', () => {
  const c = makeApptCustomer();
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-10-05T18:00:00.000Z' });
  assert.ok(appt.public_token);
  assert.equal(appt.confirmed, 0);
  assert.equal(db.getAppointmentByToken(appt.public_token).id, appt.id);
});

test('confirmAppointment: sets the confirmed flag without touching status (spec G2.4)', () => {
  const c = makeApptCustomer();
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-10-06T18:00:00.000Z' });
  const updated = db.confirmAppointment(appt.id);
  assert.equal(updated.confirmed, 1);
  assert.equal(updated.status, 'scheduled'); // unchanged - no new status value
});

test('canceling an appointment (existing status value) frees it from the scheduled listing', () => {
  const c = makeApptCustomer();
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-10-07T18:00:00.000Z' });
  db.updateAppointmentStatus(appt.id, 'canceled');
  const between = db.listAppointmentsBetween('2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
  assert.equal(between.some((a) => a.id === appt.id), false);
});

test('onAppointmentBooked email includes address and duration, not just service and time (spec G1)', async () => {
  const logged = [];
  mock.method(db, 'logMessage', (m) => logged.push(m));
  const c = makeApptCustomer();
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-10-08T18:00:00.000Z', duration_min: 90 });
  await automations.onAppointmentBooked(appt, c);
  mock.restoreAll();
  const emailLog = logged.find((m) => m.channel === 'email');
  assert.ok(emailLog, 'expected an email to be logged');
  assert.match(emailLog.subject, /You're booked: Short Design Consultation/);
  assert.match(emailLog.body, /9 Elm St, Ashland, VA 23005/);
  assert.match(emailLog.body, /about 1\.5 hours|about 90 minutes/);
});

test('onAppointmentReminder email includes the cabinet-prep line and a Confirm/Change/Cancel link (spec G2)', async () => {
  const logged = [];
  mock.method(db, 'logMessage', (m) => logged.push(m));
  const c = makeApptCustomer();
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-10-09T18:00:00.000Z' });
  const applike = { ...appt, customer_name: c.name, customer_phone: c.phone, customer_email: c.email };
  await automations.onAppointmentReminder(applike);
  mock.restoreAll();
  const emailLog = logged.find((m) => m.channel === 'email');
  assert.ok(emailLog);
  assert.match(emailLog.body, /empty (out )?your cabinets/i);
  assert.match(emailLog.body, new RegExp(`/appointment/${appt.public_token}`));
});

test('appointmentUrl builds a link containing the token', () => {
  const url = automations.appointmentUrl('abc123');
  assert.match(url, /\/appointment\/abc123$/);
});
