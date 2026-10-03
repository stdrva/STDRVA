// BF-2640-083 Today, the day page. Throwaway DB (tests/helpers.js) and a real
// server on a random port (tests/http-helper.js) with every messaging and AI
// credential blanked, so nothing here can send a text or an email.
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const { startServer } = require('./http-helper');
const assistant = require('../src/services/assistant');
const { bosDayString } = require('../src/util');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
});

const TODAY = bosDayString();
const nextDate = (d) => new Date(new Date(`${d}T12:00:00.000Z`).getTime() + 86400000).toISOString().slice(0, 10);
const prevDate = (d) => new Date(new Date(`${d}T12:00:00.000Z`).getTime() - 86400000).toISOString().slice(0, 10);
const takeMeds = () => db.listRoutine('morning', TODAY).find((r) => r.title === 'Take meds');

test('BF-2640-083: Today contains Take meds, and the Menu links to Today', async () => {
  const res = await srv.get('/dashboard/today');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1 data-day-heading>Today<\/h1>/);
  assert.match(html, /id="routine-morning"[\s\S]*Take meds/);
  assert.match(html, /<a href="\/dashboard\/today" class="active">Today<\/a>/, 'Today is in the Menu');

  assert.deepEqual(
    db.listRoutine('morning', TODAY).map((r) => r.title),
    ['Take meds', 'Make coffee', 'Shower', 'Brush teeth', 'Meditate', 'Exercise or yoga', 'Plan the day', 'Leftover calls']
  );
  assert.deepEqual(db.listRoutine('evening', TODAY).map((r) => r.title), ['Leftover calls', "Lay out tomorrow's bring-list", "Glance at tomorrow's visits"]);
});

test('BF-2640-083: a checked morning item is stored on that date, and the next date starts unchecked', async () => {
  const thursday = '2026-01-15';
  const meds = db.listRoutine('morning', thursday).find((r) => r.title === 'Take meds');
  const res = await srv.post(`/dashboard/today/routine/${meds.id}/check`, { date: thursday, checked: '1' });
  assert.equal(res.status, 302);

  const row = db.db.prepare(`SELECT * FROM routine_checks WHERE routine_item_id = ? AND date = ?`).get(meds.id, thursday);
  assert.ok(row, 'the check is stored on that date');
  assert.equal(db.listRoutine('morning', thursday).find((r) => r.id === meds.id).checked, true, 'Thursday still shows the meds were checked');
  assert.equal(db.listRoutine('morning', nextDate(thursday)).find((r) => r.id === meds.id).checked, false, 'the next date starts unchecked');

  const thursdayPage = await (await srv.get(`/dashboard/today?date=${thursday}`)).text();
  assert.match(thursdayPage, new RegExp(`data-routine-item="${meds.id}" data-checked="1"`));
  const fridayPage = await (await srv.get(`/dashboard/today?date=${nextDate(thursday)}`)).text();
  assert.match(fridayPage, new RegExp(`data-routine-item="${meds.id}">`));
  assert.match(fridayPage, /The morning routine still has 8 of 8 open\./, 'an open routine is a line on Today');
});

test('BF-2640-083: an unsorted item is not on today until Andrew pulls that item onto today', async () => {
  await srv.post('/dashboard/today/items', { title: 'Call the tile supplier back', date: TODAY });
  const it = db.listUnsortedDayItems().find((i) => i.title === 'Call the tile supplier back');
  assert.ok(it, 'an item with no day is unsorted');
  assert.equal(it.day, null);
  assert.ok(!db.todaySummary(TODAY).items.some((i) => i.id === it.id), 'not on today yet');
  let html = await (await srv.get('/dashboard/today')).text();
  const todayPanel = html.slice(html.indexOf('id="today-items"'), html.indexOf('id="today-unsorted"'));
  assert.ok(!todayPanel.includes(it.id));

  const res = await srv.post(`/dashboard/today/items/${it.id}/day`, { day: TODAY, date: TODAY });
  assert.equal(res.status, 302);
  assert.ok(db.todaySummary(TODAY).items.some((i) => i.id === it.id), 'on today after the pull');
  assert.ok(!db.listUnsortedDayItems().some((i) => i.id === it.id), 'no longer unsorted');
  html = await (await srv.get('/dashboard/today')).text();
  assert.ok(html.slice(html.indexOf('id="today-items"'), html.indexOf('id="today-unsorted"')).includes(it.id));
});

test('BF-2640-083: an overdue item is marked so the page can show that item in red, and Andrew can change the due date', async () => {
  const it = db.createDayItem({ title: 'Return the sample doors', day: TODAY, due_date: prevDate(TODAY) });
  assert.equal(db.getDayItem(it.id).overdue, true);
  let html = await (await srv.get('/dashboard/today')).text();
  assert.match(html, new RegExp(`class="day-item overdue" data-day-item="${it.id}" data-overdue="1"`));
  assert.match(html, /\.day-item\.overdue \.day-item-title[^{]*\{color:#c62828/, 'overdue shows in red');

  await srv.post(`/dashboard/today/items/${it.id}/due`, { due_date: nextDate(TODAY), date: TODAY });
  assert.equal(db.getDayItem(it.id).due_date, nextDate(TODAY));
  assert.equal(db.getDayItem(it.id).overdue, false);
  html = await (await srv.get('/dashboard/today')).text();
  assert.ok(!html.includes(`data-day-item="${it.id}" data-overdue="1"`));
});

test('BF-2640-083: ABC 123 sorts the items on a day', async () => {
  const day = '2026-11-05';
  db.createDayItem({ title: 'Could do', day, priority: 'C1' });
  db.createDayItem({ title: 'Must do second', day, priority: 'A2' });
  db.createDayItem({ title: 'Should do', day, priority: 'b1' });
  const first = db.createDayItem({ title: 'Must do first', day });
  await srv.post(`/dashboard/today/items/${first.id}/priority`, { priority: 'A1', date: day });
  assert.deepEqual(db.listDayItemsForDay(day).map((i) => i.priority), ['A1', 'A2', 'B1', 'C1']);
  assert.throws(() => db.parseDayPriority('D4'));
});

test('BF-2640-083: Today lists the visits already booked on that day', async () => {
  const c = db.createCustomer({ name: 'Today Visit Person', phone: '+18045550183' });
  const at = new Date(`${TODAY}T16:00:00.000Z`).toISOString();
  db.createAppointment({ customer_id: c.id, type: 'Consultation', scheduled_at: at, duration_min: 60 });
  const html = await (await srv.get('/dashboard/today')).text();
  const visits = html.slice(html.indexOf('id="today-visits"'), html.indexOf('id="today-items"'));
  assert.match(visits, /Today Visit Person/);
});

test('BF-2640-083: a write-in becomes part of that routine list', async () => {
  await srv.post('/dashboard/today/routine', { routine: 'evening', title: 'Charge the phone', date: TODAY });
  assert.ok(db.listRoutine('evening', nextDate(TODAY)).some((r) => r.title === 'Charge the phone'));
});

test('BF-2640-083: Foreman adds an item, checks an item, reads today, and adds a write-in, and waits for Andrew yes before a write', async () => {
  for (const name of ['read_today', 'add_day_item', 'check_today_item', 'add_routine_item']) {
    assert.ok(assistant.TOOLS.some((t) => t.name === name), `${name} is a Foreman tool`);
  }

  const before = db.listUnsortedDayItems().length;
  const draft = await assistant.runTool('add_day_item', { title: 'Order hinges', priority: 'B1' }, {});
  assert.ok(draft.error && draft.readback, 'no write without confirmed');
  assert.equal(db.listUnsortedDayItems().length, before);
  const added = await assistant.runTool('add_day_item', { title: 'Order hinges', priority: 'B1', confirmed: true }, {});
  assert.equal(added.ok, true);
  assert.equal(db.getDayItem(added.item_id).day, null, 'Foreman item without on_today is unsorted');

  const meds = takeMeds();
  const noCheck = await assistant.runTool('check_today_item', { item_id: meds.id }, {});
  assert.ok(noCheck.error);
  assert.equal(takeMeds().checked, false);
  assert.equal((await assistant.runTool('check_today_item', { item_id: meds.id, confirmed: true }, {})).ok, true);
  assert.equal(takeMeds().checked, true);

  const noWriteIn = await assistant.runTool('add_routine_item', { routine: 'morning', title: 'Feed the cat' }, {});
  assert.ok(noWriteIn.error);
  assert.ok(!db.listRoutine('morning', TODAY).some((r) => r.title === 'Feed the cat'));
  await assistant.runTool('add_routine_item', { routine: 'morning', title: 'Feed the cat', confirmed: true }, {});
  assert.ok(db.listRoutine('morning', TODAY).some((r) => r.title === 'Feed the cat'));

  const read = await assistant.runTool('read_today', {}, {});
  assert.equal(read.date, TODAY);
  assert.ok(read.morning.some((r) => r.title === 'Take meds' && r.checked));
  assert.ok(read.unsorted.some((i) => i.title === 'Order hinges'));
});
