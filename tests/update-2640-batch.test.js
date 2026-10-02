// BF-2640-079, BF-2640-077, BF-2640-071, BF-2640-076 - one block per ticket,
// each test titled with its full ticket name. Real server on a random port
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

function postMultipart(p, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  if (file) fd.append(file.field || 'file', new Blob([file.data], { type: file.type || 'image/jpeg' }), file.name);
  return fetch(srv.base + p, { method: 'POST', body: fd, redirect: 'manual' });
}
const section = (html, id) => {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `missing #${id}`);
  const next = html.indexOf('<div class="panel"', start);
  return html.slice(start, next < 0 ? undefined : next);
};

// ================================================================ BF-2640-079
test('BF-2640-079: a canceled visit whose slot has not ended is not in Upcoming', async () => {
  const kept = db.createCustomer({ name: 'Upcoming Kept 2640', phone: '+18045550179' });
  const gone = db.createCustomer({ name: 'Canceled Gone 2640', phone: '+18045550180' });
  const soon = new Date(Date.now() + 3 * 86400000).toISOString();
  db.createAppointment({ customer_id: kept.id, type: 'Measure', scheduled_at: soon, duration_min: 60 });
  const canceledId = db.createAppointment({ customer_id: gone.id, type: 'Measure', scheduled_at: soon, duration_min: 60 });
  db.updateAppointmentStatus(typeof canceledId === 'object' ? canceledId.id : canceledId, 'canceled');

  const html = await (await srv.get('/dashboard/appointments')).text();
  const upcoming = section(html, 'appts-upcoming');
  assert.match(upcoming, /Upcoming appointments/);
  assert.ok(upcoming.includes('Upcoming Kept 2640'), 'the scheduled visit is in Upcoming');
  assert.ok(!upcoming.includes('Canceled Gone 2640'), 'the canceled visit is not in Upcoming');
  // The customer record still lists the canceled visit.
  const cust = await (await srv.get(`/dashboard/customers/${gone.id}`)).text();
  assert.match(cust, /canceled/);
});

// ================================================================ BF-2640-077
test('BF-2640-077: a job row on the Jobs page opens that customer main record; Edit still opens the job', async () => {
  const c = db.createCustomer({ name: 'Job Row 2640', phone: '+18045550177' });
  const made = db.createJob({ customer_id: c.id, sold_amount: 1234 });
  const jobId = typeof made === 'object' ? made.id : made;
  const html = await (await srv.get('/dashboard/jobs')).text();
  const rowStart = html.indexOf(`<tr data-job="${jobId}">`);
  assert.ok(rowStart >= 0, 'the job has its own row');
  const row = html.slice(rowStart, html.indexOf('</tr>', rowStart));
  const toCustomer = [...row.matchAll(new RegExp(`<a href="/dashboard/customers/${c.id}"([^>]*)>([^<]*)</a>`, 'g'))];
  assert.ok(toCustomer.length > 1, 'more than the customer name links to the customer');
  assert.ok(
    toCustomer.some(([, attrs]) => /data-job-open/.test(attrs)),
    'the job status / row identity links to the customer main record'
  );
  assert.match(row, new RegExp(`href="/dashboard/jobs/${jobId}"[^>]*>Edit<`));
});

// ================================================================ BF-2640-071
test('BF-2640-071: generic phone photo names become i001.jpg, i002.jpg; real names stay; numbers never repeat', async () => {
  const c = db.createCustomer({ name: 'Phone Photo 2640', phone: '+18045550171' });
  madeDirs.add(path.join(UPLOADS, c.id));
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x41), Buffer.from([0xff, 0xd9])]);
  for (const name of ['image.jpg', 'image.JPG', 'kitchen.jpg']) {
    const r = await postMultipart(`/dashboard/customers/${c.id}/files`, {}, { data: jpg, name });
    assert.equal(r.status, 302);
  }
  const names = () => db.db.prepare(`SELECT original_name, stored_name FROM customer_files WHERE customer_id = ? ORDER BY created_at, rowid`).all(c.id);
  assert.deepEqual(names().map((f) => f.original_name), ['i001.jpg', 'i002.jpg', 'kitchen.jpg']);

  // Other real names are never renamed.
  for (const real of ['IMG_1234.jpg', 'image.png', 'sale-packet-signed-2026-09-29.png', 'photos/kitchen.jpg']) {
    assert.equal(db.phonePhotoName(real), real);
  }

  // A row saved before BF-2640-071 is renamed once on startup from the same
  // counter, without moving bytes or changing stored_name; the counter survives
  // the restart and never hands i001.jpg out twice.
  const oldId = db.createCustomerFile({ customer_id: c.id, stored_name: 'old-2640.jpg', original_name: 'IMAGE.jpeg', mime_type: 'image/jpeg', size: 10 });
  await srv.stop();
  srv = await startServer();
  const old = db.db.prepare(`SELECT original_name, stored_name FROM customer_files WHERE id = ?`).get(oldId);
  assert.equal(old.original_name, 'i003.jpg');
  assert.equal(old.stored_name, 'old-2640.jpg');
  assert.equal(db.phonePhotoName('image.jpeg'), 'i004.jpg');
  const all = db.db.prepare(`SELECT original_name FROM customer_files WHERE original_name LIKE 'i0%.jpg'`).all().map((r) => r.original_name);
  assert.equal(all.filter((n) => n === 'i001.jpg').length, 1, 'i001.jpg is handed out once');
  assert.equal(new Set(all).size, all.length, 'no number is reused');
});

// ================================================================ BF-2640-076
test('BF-2640-076: Foreman saves raw notes and Andrew downloads them from Desk, newest first', async () => {
  const assistant = require('../src/services/assistant');
  const tool = assistant.TOOLS.find((t) => t.name === 'save_raw_note');
  assert.ok(tool, 'save_raw_note is a Foreman tool');
  assert.deepEqual(tool.input_schema.required, ['body']);
  assert.match(tool.description, /raw bug or feature note/);
  assert.match(tool.description, /must not invent a BF- name/);
  assert.match(tool.description, /must not treat the note as done work/);

  const first = await assistant.runTool('save_raw_note', { body: 'Bug: the Pipeline page jumps when I scroll.' }, {});
  assert.equal(first.note.body, 'Bug: the Pipeline page jumps when I scroll.');
  assert.match(first.read_back, /Pipeline page jumps/);
  await new Promise((r) => setTimeout(r, 5));
  await assistant.runTool('save_raw_note', { body: 'Feature: let me print a job sheet.' }, {});
  const bodies = db.listForemanNotes().map((n) => n.body);
  assert.deepEqual(bodies, ['Feature: let me print a job sheet.', 'Bug: the Pipeline page jumps when I scroll.']);

  const desk = await (await srv.get('/dashboard/contacts')).text();
  // FF-2640-016: Desk is called Contacts now; the download button moved with it.
  assert.match(desk, /href="\/dashboard\/contacts\/foreman-notes"[^>]*>Download Foreman notes</);

  const dl = await srv.get('/dashboard/contacts/foreman-notes');
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="foreman-notes\.txt"/);
  assert.match(dl.headers.get('content-type'), /^text\/plain/);
  const txt = await dl.text();
  const a = txt.indexOf('Feature: let me print a job sheet.');
  const b = txt.indexOf('Bug: the Pipeline page jumps when I scroll.');
  assert.ok(a >= 0 && b > a, 'both notes, newest first');
  assert.match(txt, /\d{4}-\d{2}-\d{2}T/, 'each note carries its created_at stamp');
  assert.ok(!fs.existsSync(path.join(UPLOADS, 'BF-2640-076')), 'no folder named after the ticket');
});
