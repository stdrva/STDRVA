// BF-2640-070, BF-2640-072, BF-2640-075, BF-2640-080, BF-2640-082 - each test
// titled with its full ticket name. Real server on a random port
// (tests/http-helper.js), throwaway DB and uploads folder, every messaging / AI
// credential blanked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');

const UPLOADS = path.join(path.dirname(tmpDbPath), 'uploads');

let srv;
const madeDirs = new Set();
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
});

const layout = (active = '/dashboard') => require('../src/render').dashboardLayout({ title: 'T', active, body: '<p>x</p>', context: {} });
const scriptWith = (html, marker) => {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const start = html.lastIndexOf('<script>', at) + '<script>'.length;
  return html.slice(start, html.indexOf('</script>', at));
};
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ================================================================ BF-2640-070
// The Voice screen script, run against a fake recognizer and a tiny DOM.
function bootVoice() {
  const recs = [];
  class FakeSR {
    constructor() { this.started = false; this.aborted = false; this.stopped = false; recs.push(this); }
    start() { this.started = true; }
    abort() { this.aborted = true; }
    stop() { this.stopped = true; }
  }
  const handlers = {};
  const el = (id) => ({
    id, hidden: true, textContent: '', attrs: {}, style: {},
    getAttribute(k) { return this.attrs[k] || ''; },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild() {},
    addEventListener(t, fn) { handlers[id + ':' + t] = fn; },
  });
  const els = {};
  for (const id of ['voice-launch', 'voice-overlay', 'vm-status', 'vm-log', 'vm-orb', 'vm-end', 'vm-fallback']) els[id] = el(id);
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: () => ({ className: '', textContent: '' }),
    addEventListener() {},
    body: { style: {} },
  };
  const fetches = [];
  class FD { constructor() { this.m = {}; } append(k, v) { this.m[k] = v; } }
  const fetchStub = (url, opts) => {
    fetches.push({ url, message: opts.body.m.message });
    return new Promise(() => {}); // never settles: the test only checks what was sent
  };
  const window = { SpeechRecognition: FakeSR, speechSynthesis: null };
  const code = scriptWith(layout(), "getElementById('voice-launch')");
  new Function('window', 'document', 'navigator', 'FormData', 'fetch', 'setTimeout', 'clearTimeout', code)(
    window, document, { userAgent: 'Chrome' }, FD, fetchStub, () => 0, () => {}
  );
  const result = (text, isFinal) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
  return {
    recs, fetches, result,
    status: () => els['vm-status'].textContent,
    open: () => handlers['voice-launch:click'](),
    orb: () => handlers['vm-orb:click'](),
  };
}

test('BF-2640-070: pause aborts the recognizer so Listening never shows on a dead microphone', () => {
  const v = bootVoice();
  v.open();
  assert.equal(v.recs.length, 1);
  const first = v.recs[0];
  assert.equal(first.started, true);
  assert.equal(v.status(), 'Starting…', 'not Listening until the recognizer really starts');
  first.onstart();
  assert.equal(v.status(), 'Listening…');

  v.orb(); // pause
  assert.equal(first.aborted, true, 'pause aborts the recognizer');
  assert.match(v.status(), /^Paused/);

  // Late events from the aborted recognizer change nothing.
  first.onstart();
  first.onresult(v.result('ghost words', false));
  first.onresult(v.result('ghost words', true));
  first.onend();
  assert.match(v.status(), /^Paused/, 'still Paused, never Listening');
  assert.equal(v.fetches.length, 0, 'nothing from the dead recognizer is sent');
  assert.equal(v.recs.length, 1, 'no recognizer restarts itself while paused');
});

test('BF-2640-070: resume starts a new recognizer and the words on screen come only from it', () => {
  const v = bootVoice();
  v.open();
  const first = v.recs[0];
  v.orb(); // pause before the first recognizer ever started (the old code would start another one here)
  assert.equal(first.aborted, true);
  assert.match(v.status(), /^Paused/);

  v.orb(); // resume
  assert.equal(v.recs.length, 2, 'resume makes a brand-new recognizer');
  const second = v.recs[1];
  assert.notEqual(second, first);
  assert.equal(second.started, true);
  second.onstart();
  assert.equal(v.status(), 'Listening…');
  second.onresult(v.result('kitchen shelves', false));
  assert.equal(v.status(), '“kitchen shelves”', 'the words on screen match the live microphone');
  first.onresult(v.result('ghost words', false));
  assert.equal(v.status(), '“kitchen shelves”', 'an old recognizer cannot add words');

  second.onresult(v.result('kitchen shelves', true));
  second.onend();
  assert.deepEqual(v.fetches.map((f) => f.message), ['kitchen shelves'], 'only the live recognizer words are sent');
});

// ================================================================ BF-2640-072
test('BF-2640-072: Search finds the word test across customers, jobs, appointments, Desk records, files, and notes, with links and no delete', async () => {
  const c = db.createCustomer({ name: 'Testerson Search 072', phone: '+18045550172' });
  const job = db.createJob({ customer_id: c.id, notes: 'a test job note' });
  const jobId = typeof job === 'object' ? job.id : job;
  const appt = db.createAppointment({ customer_id: c.id, type: 'Measure', scheduled_at: new Date(Date.now() + 9 * 86400000).toISOString(), duration_min: 60, notes: 'bring the test drawer' });
  const apptId = typeof appt === 'object' ? appt.id : appt;
  const rec = db.createRecord(db.ensureUser(db.defaultUsername()), { kind: 'thing', name: 'Test Car 072', is_personal: true });
  const fileId = db.createCustomerFile({ customer_id: c.id, stored_name: 's072.pdf', original_name: 'quote-072.pdf', note: 'test quote', mime_type: 'application/pdf', size: 10 });
  db.createFollowup({ customer_id: c.id, title: 'Call back about the test sample' });
  db.createForemanNote({ body: 'Bug: test the Search page' });

  const res = await srv.get('/dashboard/search?q=test');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`<a href="/dashboard/customers/${c.id}">Testerson Search 072</a>`));
  assert.match(html, new RegExp(`<a href="/dashboard/jobs/${jobId}">`));
  assert.match(html, new RegExp(`<a href="/dashboard/appointments/${apptId}/edit">`));
  assert.match(html, new RegExp(`<a href="/dashboard/desk/${rec.id}">Test Car 072</a>`));
  assert.match(html, new RegExp(`<a href="/dashboard/customers/${c.id}/files/${fileId}/view">quote-072\\.pdf</a>`));
  assert.match(html, /Next action: Call back about the test sample/);
  assert.match(html, /Foreman note: Bug: test the Search page/);
  for (const id of ['customers', 'jobs', 'appointments', 'records', 'files', 'notes']) assert.match(html, new RegExp(`id="search-${id}"`));

  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.ok(!/method="POST"|delete/i.test(main.replace(/Nothing on this page deletes anything\./, '')), 'no delete control and no form that writes');

  // A LIKE wildcard in the search is taken literally.
  const pct = await (await srv.get('/dashboard/search?q=' + encodeURIComponent('%'))).text();
  assert.match(pct, /0 hits for &ldquo;%&rdquo;/);
  // Search is in the Menu.
  assert.match(layout(), /<a href="\/dashboard\/search"[^>]*>Search<\/a>/);
});

// ================================================================ BF-2640-075
test('BF-2640-075: Files lists every visible file twenty per page, each row with a description and what it is linked to', async () => {
  const c = db.createCustomer({ name: 'Paging Customer 075' });
  for (let i = 1; i <= 25; i++) {
    db.createCustomerFile({ customer_id: c.id, stored_name: `p075-${i}.pdf`, original_name: `page075-${pad(i)}.pdf`, note: `drawer quote ${i}`, mime_type: 'application/pdf', size: 10 });
  }
  const me = db.ensureUser(db.defaultUsername());
  const rec = db.createRecord(me, { kind: 'thing', name: 'Desk Truck 075', is_business: true });
  madeDirs.add(path.join(UPLOADS, '_records', rec.id));
  db.addRecordFile(me, rec.id, { filename: 'page075-title.txt', mimeType: 'text/plain', data: Buffer.from('truck title') });

  let html = await (await srv.get('/dashboard/files/results?q=page075')).text();
  assert.match(html, /26 matches for &ldquo;page075&rdquo;/);
  assert.equal((html.match(/<tr data-file-kind=/g) || []).length, 20, 'twenty rows on page one');
  assert.match(html, /<th>File<\/th><th>Description<\/th><th>Linked to<\/th><th>Uploaded<\/th>/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, /href="\/dashboard\/files\?q=page075&amp;page=2" data-files-page="2">Next/);
  assert.match(html, /drawer quote \d+/, 'the note is the description');
  assert.match(html, new RegExp(`<a href="/dashboard/customers/${c.id}">Paging Customer 075</a>`), 'linked to its customer');

  html = await (await srv.get('/dashboard/files/results?q=page075&page=2')).text();
  assert.equal((html.match(/<tr data-file-kind=/g) || []).length, 6, 'the rest on page two');
  assert.match(html, /Page 2 of 2/);
  assert.match(html, /data-files-page="1">&lsaquo; Previous/);

  // The Desk record file is listed, linked to its Desk record.
  const all = db.listAllVisibleFiles(me, 'page075');
  const deskRow = all.find((f) => f.kind === 'record');
  assert.equal(deskRow.record_name, 'Desk Truck 075');
  const both = (await (await srv.get('/dashboard/files/results?q=page075-title')).text());
  assert.match(both, new RegExp(`<a href="/dashboard/desk/${rec.id}">Desk: Desk Truck 075</a>`));
  // A user who cannot see that Desk record never gets its file.
  const stranger = db.ensureUser('stranger-075');
  assert.ok(!db.listAllVisibleFiles(stranger, 'page075').some((f) => f.kind === 'record'));

  // Search as you type still drives the list, and page links reload only the list.
  const page = await (await srv.get('/dashboard/files')).text();
  assert.match(page, /addEventListener\('input'[\s\S]*setTimeout\(run, 150\)/);
  assert.match(page, /closest\('\[data-files-page\]'\)/);
});

// ================================================================ BF-2640-080
test('BF-2640-080: Foreman reads existing BOS appointments and never offers or books a time that has a scheduled visit', async () => {
  const pub = require('../src/routes/public');
  const assistant = require('../src/services/assistant');
  // A Wednesday about three weeks out, clear of other tests.
  const d = new Date();
  d.setDate(d.getDate() + 21);
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1);
  const day = localKey(d);
  const opts = { fromDate: day, toDate: day, count: 20 };

  const before = pub.voiceBookingSlots(opts);
  assert.equal(before.checked_existing_appointments, true);
  assert.ok(before.slots.length >= 4, 'the day has openings');
  const taken = before.slots[2].iso;
  const firstOfDay = before.slots.map((s) => s.iso).sort()[0];

  const c = db.createCustomer({ name: 'Busy Day 080', phone: '+18045550180', email: 'busy080@example.com', address: '10 Main St, Richmond, VA 23220' });
  db.createAppointment({ customer_id: c.id, type: 'Measure', scheduled_at: taken, duration_min: 60 });
  // A visit that starts before opening and runs into the first slot of the day.
  const early = new Date(new Date(firstOfDay).getTime() - 60 * 60000).toISOString();
  db.createAppointment({ customer_id: c.id, type: 'Install', scheduled_at: early, duration_min: 120 });
  // A canceled visit does not block its time.
  const cancelIso = before.slots.map((s) => s.iso).sort()[before.slots.length - 1];
  const canceled = db.createAppointment({ customer_id: c.id, type: 'Measure', scheduled_at: cancelIso, duration_min: 60 });
  db.updateAppointmentStatus(typeof canceled === 'object' ? canceled.id : canceled, 'canceled');

  const after = pub.voiceBookingSlots(opts);
  const offered = after.slots.map((s) => s.iso);
  assert.ok(!offered.includes(taken), 'the scheduled time is not offered');
  assert.ok(!offered.includes(firstOfDay), 'a visit running in from before opening blocks that slot');
  assert.ok(offered.includes(cancelIso), 'a canceled visit does not block its time');
  assert.ok(after.existing_appointments.some((a) => a.starts === taken), 'Foreman sees the real appointment list');
  assert.ok(!JSON.stringify(after.existing_appointments).includes('Busy Day 080'), 'no customer names in what a customer may hear');

  assert.equal(pub.slotIsFree(taken, 'Short Design Consultation'), false);
  assert.equal(pub.slotIsFree(cancelIso, 'Short Design Consultation'), true);
  const r = assistant.runTool('book_design_appointment', {
    confirmed: true, name: 'Second Person', phone: '804-555-0181', email: 'second080@example.com',
    address: '12 Main St, Richmond, VA 23220', scheduled_at: taken, type: 'Short Design Consultation',
  }, {});
  assert.match(r.error || '', /already has a scheduled visit/);

  // Foreman is told to read the list first and never guess a time.
  assert.match(assistant.systemPrompt({}), /before you offer Andrew or a customer any start time, call\s+list_available_slots/);
  assert.match(assistant.systemPrompt({ mode: 'voice' }), /Never offer a start time you did not get from list_available_slots/);
});

// ================================================================ BF-2640-082
test('BF-2640-082: Training is on, the Menu links to the Training page, and lessons stay L1 through L4', async () => {
  const assistant = require('../src/services/assistant');
  const names = assistant.TOOLS.map((t) => t.name);
  for (const t of ['list_sales_reps', 'create_sales_rep', 'get_training_history', 'log_training_session']) assert.ok(names.includes(t), `${t} is available`);
  assert.ok(!names.some((n) => /web_search|places/i.test(n)), 'no web search or Places');
  assert.match(assistant.systemPrompt({}), /L1 door, L2 mirroring, L3 labeling, and L4\s+implication/);

  assert.match(layout(), /<a href="\/dashboard\/training"[^>]*>Training<\/a>/);
  assert.ok(!/menu-disabled[^>]*>Training</.test(layout()));

  const rep = db.createSalesRep({ name: 'Rep Trainee 082' });
  db.createTrainingSession({ rep_id: rep.id, session_type: 'roleplay', summary: 'Practiced mirroring on a price objection.', outcome: 'good' });
  const res = await srv.get('/dashboard/training');
  assert.equal(res.status, 200);
  const html = await res.text();
  const lessons = [...html.matchAll(/data-lesson="(L\d)"/g)].map((m) => m[1]);
  assert.deepEqual(lessons, ['L1', 'L2', 'L3', 'L4']);
  assert.ok(!/data-lesson="L[5-9]"/.test(html), 'no invented lessons');
  assert.match(html, /Rep Trainee 082/);
  assert.match(html, /Practiced mirroring on a price objection\./);
});
