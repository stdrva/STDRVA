// FF-2640-025 Five questions on the two design consultations. Throwaway DB and
// uploads folder (tests/helpers.js) and a real server on a random port
// (tests/http-helper.js) with every messaging and AI credential blanked, so a
// booking here can never send a real text or email.
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const { startServer } = require('./http-helper');
const pub = require('../src/routes/public');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
});

function weekdaySlot(daysOut) {
  const d = new Date();
  d.setDate(d.getDate() + daysOut);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}
const reviewUrl = (type, n, daysOut) =>
  `/book/review?${new URLSearchParams({ type, name: `Five Q ${n}`, phone: `804555${String(1000 + n).slice(-4)}`, email: `fiveq${n}@example.com`, address: `${n} Main St, Richmond, VA 23220`, slot: weekdaySlot(daysOut) })}`;

test('FF-2640-025: Short Design Consultation and Long Design Consultation show the five questions on the booking page, before the visit is booked', async () => {
  assert.deepEqual(pub.FIVE_QUESTION_TYPES, ['Short Design Consultation', 'Long Design Consultation']);
  for (const [i, type] of pub.FIVE_QUESTION_TYPES.entries()) {
    const html = await (await srv.get(reviewUrl(type, i + 1, 40 + i * 2))).text();
    assert.match(html, /Nothing is booked yet/, 'this is the page before booking');
    const form = html.slice(html.indexOf('action="/book/confirm"'), html.indexOf('</form>', html.indexOf('action="/book/confirm"')));
    assert.match(form, /data-five-questions/, `${type} shows the form inside the confirm form`);
    assert.match(form, /Question <span id="wq-num">1<\/span> of 5/);
    assert.ok(form.indexOf('data-five-questions') < form.indexOf('Confirm Appointment'), 'the questions come before Confirm');
    assert.ok(!/wizard-skip|id="wq-submit"/.test(form), 'Confirm is the only button that sends; the questions stay optional');
  }
});

test('FF-2640-025: the five questions are the questions BOS already asks, with no new questions', async () => {
  const html = await (await srv.get(reviewUrl('Short Design Consultation', 3, 44))).text();
  assert.match(html, /1\. Where are you looking to make a change\?/);
  for (const room of ['Kitchen', 'Bathroom(s)', 'Garage', 'Shop', 'Studio', 'Commercial', 'Hidden kick-panel', 'Closet']) {
    assert.ok(html.includes(`name="rooms" value="${room}"`), room);
  }
  assert.match(html, /2\. Do you have any pets\?/);
  assert.match(html, /OK if we bring a treat\?/);
  assert.match(html, /Pet name\(s\) and breed\(s\)/);
  assert.match(html, /3\. Have you had pull-out shelves before\?/);
  assert.match(html, /What did you like about them\?/);
  assert.match(html, /What didn't you like\?/);
  assert.match(html, /4\. Which products would you like us to show you/);
  assert.match(html, /name="products" value="Pull-out shelves"/);
  assert.match(html, /5\. Anything else we should know\?/);
  assert.equal((html.match(/class="wizard-step"/g) || []).length, 5);
});

test('FF-2640-025: no other visit type shows the five-question form', async () => {
  for (const [i, type] of ['Design Review', 'Repair or Warranty'].entries()) {
    const html = await (await srv.get(reviewUrl(type, 10 + i, 50 + i * 2))).text();
    assert.match(html, /Confirm Appointment/);
    assert.ok(!/class="wizard"|data-five-questions/.test(html), type);
  }
  for (const type of ['Callback by Owner', 'More Info by Email']) {
    const html = await (await srv.get(`/book?type=${encodeURIComponent(type)}`)).text();
    assert.ok(!/class="wizard"/.test(html), type);
    assert.match(html, type === 'Callback by Owner' ? />Request a callback</ : />Submit request</);
  }
});

test('FF-2640-025: answers given before booking go on the appointment and the customer, and the booked page does not ask again', async () => {
  const slot = weekdaySlot(56);
  const res = await srv.post('/book/confirm', {
    type: 'Long Design Consultation', slot, name: 'Answer Person', phone: '8045550171', email: 'answer.person@example.com', address: '7 Main St, Richmond, VA 23220',
    rooms: ['Kitchen', 'Closet'], has_pets: 'Yes', pet_treat_ok: 'Yes', pet_details: 'Biscuit, Lab mix', had_pullouts: 'No', products: ['Pull-out shelves'], notes: 'Gate code 1234',
  });
  assert.equal(res.status, 302);
  const apptId = new URL(res.headers.get('location'), srv.base).searchParams.get('appt');
  const appt = db.getAppointment(apptId);
  assert.match(appt.notes, /Rooms: Kitchen, Closet/);
  assert.match(appt.notes, /Pets: yes \(Biscuit, Lab mix\), treat OK: Yes/);
  assert.match(appt.notes, /Interested in: Pull-out shelves/);
  assert.match(appt.notes, /Gate code 1234/);
  assert.match(db.getCustomer(appt.customer_id).notes, /Rooms: Kitchen, Closet/);

  const booked = await (await srv.get(`/book/booked?appt=${apptId}`)).text();
  assert.match(booked, /You're booked!/);
  assert.ok(!/class="wizard"/.test(booked), 'the booked page does not ask the five questions again');
});

test('FF-2640-025: the questions stay optional, and a booking with no answers writes no answers', async () => {
  const res = await srv.post('/book/confirm', {
    type: 'Short Design Consultation', slot: weekdaySlot(60), name: 'Skip Person', phone: '8045550172', email: 'skip.person@example.com', address: '8 Main St, Richmond, VA 23220',
  });
  assert.equal(res.status, 302);
  const appt = db.getAppointment(new URL(res.headers.get('location'), srv.base).searchParams.get('appt'));
  assert.ok(appt, 'booked without answering');
  assert.ok(!/\[Discovery\]/.test(appt.notes || ''));
});
