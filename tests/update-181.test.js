// BOS 1.8.1 - one test per ticket, each titled with its full identifier.
// Real server on a random port (tests/http-helper.js), throwaway DB and uploads
// folder, every messaging / AI credential blanked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');

const UPLOADS = path.join(path.dirname(tmpDbPath), 'uploads');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

let srv;
const madeDirs = new Set();
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
  for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- helpers ----------
function makePng(w = 4, h = 4) {
  const raw = Buffer.alloc((w * 4 + 1) * h, 0x7f);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const isPng = (buf) => buf.subarray(0, 4).toString('hex') === '89504e47';

function postMultipart(p, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  if (file) fd.append(file.field || 'file', new Blob([file.data], { type: file.type || 'image/png' }), file.name);
  return fetch(srv.base + p, { method: 'POST', body: fd, redirect: 'manual' });
}

// A customer with n real files on disk, created oldest -> newest.
function customerWithFiles(name, n) {
  const c = db.createCustomer({ name, phone: '+18045550111' });
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  madeDirs.add(dir);
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const stored = `t181-${c.id}-${i}.png`;
    fs.writeFileSync(path.join(dir, stored), makePng());
    const id = db.createCustomerFile({ customer_id: c.id, stored_name: stored, original_name: `photo-${i}.png`, mime_type: 'image/png', size: 10 });
    ids.push(id);
  }
  return { c, ids };
}
const hrefOf = (html, attr) => {
  const m = new RegExp(`<a class="btn secondary" href="([^"]+)" data-viewer-${attr}>`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
};

// ================================================================ BF-2639-064
test('BF-2639-064: a file uploaded through the assistant and filed by naming the customer opens with its real bytes', async () => {
  const c = db.createCustomer({ name: 'Leora Copeland', phone: '+18045550164' });
  madeDirs.add(path.join(UPLOADS, c.id));
  const png = makePng();
  const up = await postMultipart('/dashboard/assistant/upload', {}, { data: png, name: 'kitchen.png' });
  assert.equal(up.status, 200);
  const { file_id } = await up.json();
  assert.ok(file_id);
  // Naming the customer in the chat message files it under her (the path that used to 404).
  const chat = await srv.post('/dashboard/assistant/chat', { message: 'This is for Leora Copeland', file_id });
  assert.equal(chat.status, 200);
  const row = db.getCustomerFile(file_id);
  assert.equal(row.customer_id, c.id, 'filed under the named customer');

  // The URL the UI uses: the filename link on her record -> viewer -> raw bytes.
  const page = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.match(page, new RegExp(`/dashboard/customers/${c.id}/files/${file_id}/view`));
  const raw = await srv.get(`/dashboard/customers/${c.id}/files/${file_id}`);
  assert.equal(raw.status, 200);
  const body = Buffer.from(await raw.arrayBuffer());
  assert.ok(isPng(body), 'body starts with 89 50 4E 47');
  assert.ok(body.equals(png), 'exactly the uploaded bytes');
  assert.ok(fs.existsSync(path.join(UPLOADS, c.id, row.stored_name)), 'bytes moved to the customer folder');
});

test('BF-2639-064: a direct upload on the customer page opens with 200 and PNG bytes', async () => {
  const c = db.createCustomer({ name: 'Direct Upload Test', phone: '+18045550165' });
  madeDirs.add(path.join(UPLOADS, c.id));
  const r = await postMultipart(`/dashboard/customers/${c.id}/files`, { note: 'test' }, { data: makePng(), name: 'a.png' });
  assert.equal(r.status, 302);
  const [f] = db.listCustomerFiles(c.id);
  const raw = await srv.get(`/dashboard/customers/${c.id}/files/${f.id}`);
  assert.equal(raw.status, 200);
  assert.ok(isPng(Buffer.from(await raw.arrayBuffer())));
});

test('BF-2639-064: re-filing a file moves its bytes, and a row stranded in _unassigned/ still opens', async () => {
  const a = db.createCustomer({ name: 'Refile From', phone: '+18045550166' });
  const b = db.createCustomer({ name: 'Refile To', phone: '+18045550167' });
  const un = path.join(UPLOADS, '_unassigned');
  fs.mkdirSync(un, { recursive: true });
  madeDirs.add(path.join(UPLOADS, a.id)); madeDirs.add(path.join(UPLOADS, b.id));
  // Simulate a 1.8.0 row: customer_id set, bytes left behind in _unassigned/.
  const stored = `t181-stranded-${a.id}.png`;
  fs.writeFileSync(path.join(un, stored), makePng());
  const id = db.createCustomerFile({ customer_id: a.id, stored_name: stored, original_name: 'stranded.png', mime_type: 'image/png', size: 10 });
  const r1 = await srv.get(`/dashboard/customers/${a.id}/files/${id}`);
  assert.equal(r1.status, 200, 'stranded bytes are found and served');
  // Move to another customer via the assistant tool path (db.setFileAssignment).
  db.setFileAssignment(id, { customer_id: b.id, assignment_status: 'confirmed' });
  const r2 = await srv.get(`/dashboard/customers/${b.id}/files/${id}`);
  assert.equal(r2.status, 200);
  assert.ok(isPng(Buffer.from(await r2.arrayBuffer())));
});

test('BF-2639-064: a missing stored_name gives a normal error, and its viewer still has a Close control', async () => {
  const c = db.createCustomer({ name: 'Missing Bytes', phone: '+18045550168' });
  const id = db.createCustomerFile({ customer_id: c.id, stored_name: 'does-not-exist.png', original_name: 'gone.png', mime_type: 'image/png', size: 1 });
  const raw = await srv.get(`/dashboard/customers/${c.id}/files/${id}`);
  assert.equal(raw.status, 404);
  const view = await srv.get(`/dashboard/customers/${c.id}/files/${id}/view`);
  assert.equal(view.status, 404);
  const html = await view.text();
  assert.match(html, /data-viewer-close/);
  assert.match(html, /<!DOCTYPE html>/, 'a normal page, not a bare string');
});

test('BF-2639-064: if the bytes cannot be written, the upload fails and no row is kept', async () => {
  const c = db.createCustomer({ name: 'Write Fails', phone: '+18045550169' });
  // Make the customer's upload folder impossible to create: a plain FILE sits at that path.
  fs.mkdirSync(UPLOADS, { recursive: true });
  const blocker = path.join(UPLOADS, c.id);
  fs.writeFileSync(blocker, 'not a directory');
  madeDirs.add(blocker);
  const r = await postMultipart(`/dashboard/customers/${c.id}/files`, {}, { data: makePng(), name: 'x.png' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /err=/);
  assert.equal(db.listCustomerFiles(c.id).length, 0, 'no row kept');
});

// ================================================================ BF-2639-065
test('BF-2639-065: files tables sit in a sideways-scrolling wrapper so date and actions are reachable at 390px', async () => {
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x:\s*(auto|scroll)/);
  const { c } = customerWithFiles('Phone Table', 1);
  const cust = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.match(cust, /<div class="table-scroll"><table class="files-table"[^>]*><tr><th>File<\/th><th>Note<\/th><th>Job<\/th><th>Uploaded<\/th><th><\/th>/);
  const files = await (await srv.get('/dashboard/files/results')).text();
  assert.match(files, /<div class="table-scroll"><table class="files-table"/);
});

// ================================================================ BF-2639-069
test('BF-2639-069: the viewer has a visible Close that returns to the same customer file list, and opens in the same tab', async () => {
  const { c, ids } = customerWithFiles('Close Test', 1);
  const html = await (await srv.get(`/dashboard/customers/${c.id}/files/${ids[0]}/view`)).text();
  const m = /<a class="btn viewer-close" href="([^"]+)" data-viewer-close aria-label="Close">&#x2715; Close<\/a>/.exec(html);
  assert.ok(m, 'Close control with an X');
  const close = m[1].replace(/&amp;/g, '&');
  assert.equal(close, `/dashboard/customers/${c.id}?open=files#file-${ids[0]}`);
  // Following it leaves the viewer: the customer page, Files open, row anchored.
  const back = await (await srv.get(close.split('#')[0])).text();
  assert.match(back, /<details class="section" id="sec-files" open>/);
  assert.match(back, new RegExp(`<tr id="file-${ids[0]}">`));
  // The list no longer opens files in a new tab (the Home Screen trap).
  assert.ok(!new RegExp(`files/${ids[0]}" target="_blank"`).test(back));
  // Escape also closes.
  assert.match(html, /e\.key === 'Escape'\) window\.location\.href = /);
});

// ================================================================ FF-3926-014
test('FF-3926-014: Previous / Next walk one customer\'s files in list order and stop at the ends', async () => {
  const { c, ids } = customerWithFiles('Walk Test', 3);
  customerWithFiles('Someone Else', 2); // must never appear in the walk
  const order = db.listCustomerFiles(c.id).map((f) => f.id); // Files-panel order
  const view = async (id) => (await srv.get(`/dashboard/customers/${c.id}/files/${id}/view`)).text();
  const url = (id) => `/dashboard/customers/${c.id}/files/${id}/view`;

  const middle = await view(order[1]);
  assert.equal(hrefOf(middle, 'next'), url(order[2]), 'Next opens the third');
  assert.equal(hrefOf(middle, 'prev'), url(order[0]), 'Previous opens the first');

  const last = await view(order[2]);
  assert.equal(hrefOf(last, 'next'), null, 'Next on the last file goes nowhere');
  assert.match(last, /<span class="btn secondary disabled" aria-disabled="true" data-viewer-next>/);
  assert.equal(hrefOf(last, 'prev'), url(order[1]));

  const first = await view(order[0]);
  assert.equal(hrefOf(first, 'prev'), null, 'Previous on the first file goes nowhere (no wrap)');
  assert.ok(ids.every((id) => order.includes(id)));
  // Close works on every file in the walk.
  for (const html of [first, middle, last]) assert.match(html, /data-viewer-close/);
});

test('FF-3926-014: a neighbour with missing bytes is skipped', async () => {
  const { c } = customerWithFiles('Skip Test', 3);
  const order = db.listCustomerFiles(c.id);
  fs.unlinkSync(path.join(UPLOADS, c.id, order[1].stored_name)); // middle file's bytes gone
  const first = await (await srv.get(`/dashboard/customers/${c.id}/files/${order[0].id}/view`)).text();
  assert.equal(hrefOf(first, 'next'), `/dashboard/customers/${c.id}/files/${order[2].id}/view`);
});

// ================================================================ BF-2639-066
test('BF-2639-066: text size is pinned so a rotate cannot leave the assistant text landscape-sized', () => {
  assert.match(css, /html\s*\{\s*-webkit-text-size-adjust:\s*100%;\s*text-size-adjust:\s*100%;\s*\}/);
  assert.match(css, /\.aw-log, \.aw-bubble \{ -webkit-text-size-adjust: 100%; text-size-adjust: 100%; \}/);
  // No assistant font size is derived from the viewport width.
  const aw = css.split('\n').filter((l) => /aw-|assistant-widget/.test(l));
  assert.ok(!aw.some((l) => /font-size:[^;]*vw/.test(l)));
  assert.match(css, /BF-2639-066/, 'the rule carries a comment explaining why');
});

// ================================================================ BF-2639-049
test('BF-2639-049: Appointments page is split into upcoming (closest first) and past (newest first)', async () => {
  const c = db.createCustomer({ name: 'Appt Split', phone: '+18045550149' });
  const H = 3600000;
  const now = Date.now();
  const mk = (ms, notes) => db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: new Date(now + ms).toISOString(), duration_min: 60, notes });
  const farFuture = mk(72 * H);
  const soonFuture = mk(24 * H);
  const recentPast = mk(-24 * H);
  const oldPast = mk(-72 * H);
  const inProgress = mk(-0.5 * H); // started 30 min ago, 60-min slot -> still upcoming
  const html = await (await srv.get('/dashboard/appointments')).text();
  const up = html.slice(html.indexOf('id="appts-upcoming"'), html.indexOf('id="appts-past"'));
  const past = html.slice(html.indexOf('id="appts-past"'));
  const pos = (s, a) => s.indexOf(`data-appt="${a.id}"`);
  assert.ok(pos(up, inProgress) >= 0 && pos(up, soonFuture) > pos(up, inProgress), 'in-slot appointment is upcoming, first');
  assert.ok(pos(up, soonFuture) < pos(up, farFuture), 'sooner upcoming first');
  assert.ok(pos(past, recentPast) >= 0 && pos(past, recentPast) < pos(past, oldPast), 'more recent past first');
  assert.equal(pos(up, recentPast), -1, 'a past appointment is not in upcoming');
  assert.equal(pos(up, oldPast), -1);
  assert.match(up, /<th>Status<\/th>/);
  assert.match(html, /Upcoming appointments/);
  assert.match(html, /Past appointments/);
});

// ================================================================ BF-2639-050
test('BF-2639-050: Callback and More Info pages have #step-contact on the request panel; design pages keep it on the info step', async () => {
  for (const t of ['Callback+by+Owner', 'More+Info+by+Email']) {
    const html = await (await srv.get(`/book?type=${t}`)).text();
    assert.match(html, /<div class="panel" id="step-contact">\s*<!--[^]*?-->\s*<h3 style="margin-top:0">2\. What do you want to know\?<\/h3>/);
    assert.equal((html.match(/id="step-contact"/g) || []).length, 1);
  }
  const design = await (await srv.get('/book?type=Short+Design+Consultation')).text();
  assert.match(design, /<div class="panel" id="step-contact">\s*<h3 style="margin-top:0">2\. Your info &amp; address<\/h3>/);
});

// ================================================================ BF-2639-051
test('BF-2639-051: request pages show the five questions; /book/booked hides them only when THIS appointment has answers', async () => {
  for (const t of ['Callback+by+Owner', 'More+Info+by+Email']) {
    const html = await (await srv.get(`/book?type=${t}`)).text();
    assert.match(html, /class="wizard"/);
    assert.match(html, /Question <span id="wq-num">1<\/span> of 5/);
    assert.ok(!/action="\/book\/request"[^>]*data-autosave/.test(html), 'request form never autosaves');
  }
  const c = db.createCustomer({ name: 'Old Pets Note', phone: '+18045550151', notes: 'Pets: yes (Rex), treat OK: Yes' });
  const appt = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  let html = await (await srv.get(`/book/booked?appt=${appt.id}`)).text();
  assert.match(html, /class="wizard"/, 'an old customer note mentioning Pets: does not hide it');

  db.updateAppointment(appt.id, { notes: '[Discovery]\nRooms: Kitchen' }, { actor: 'test' });
  html = await (await srv.get(`/book/booked?appt=${appt.id}`)).text();
  assert.ok(!/class="wizard"/.test(html), 'this appointment already has answers -> omitted');
});

test('BF-2639-051: a request with wizard answers files the question and the answers on one lead', async () => {
  const r = await srv.post('/book/request', {
    type: 'Callback by Owner', name: 'Wizard Request', phone: '8045550152', question: 'How much for 4 shelves?',
    rooms: ['Kitchen', 'Garage'], has_pets: 'No', had_pullouts: 'No', notes: 'Mornings best',
  });
  assert.equal(r.status, 200);
  const cust = db.findCustomerByPhoneOrEmail(require('../src/util').normalizePhone('8045550152'), null);
  const lead = db.listLeads().find((l) => l.customer_id === cust.id);
  assert.match(lead.notes, /How much for 4 shelves\?/);
  assert.match(lead.notes, /Rooms: Kitchen, Garage/);
  assert.match(lead.notes, /Mornings best/);
});

// ================================================================ FF-3926-004
test('FF-3926-004: list_jobs returns jobs that are not Complete with estimated_install_at, and is not the production queue', () => {
  const assistant = require('../src/services/assistant');
  assert.ok(assistant.TOOLS.some((t) => t.name === 'list_jobs'));
  const c = db.createCustomer({ name: 'Jobs Tool Person', phone: '+18045550104' });
  const open = db.createJob({ customer_id: c.id, sold_amount: 4200 });
  db.updateJobEstimatedInstall(open.id, '2026-11-02', 'test');
  const done = db.createJob({ customer_id: c.id, sold_amount: 10 });
  db.updateJobStatus(done.id, 'Complete', null);
  const r = assistant.runTool('list_jobs', {});
  const row = r.jobs.find((j) => j.job_id === open.id);
  assert.ok(row);
  assert.deepEqual(
    { customer: row.customer, status: row.status, sold_amount: row.sold_amount, estimated_install_at: row.estimated_install_at },
    { customer: 'Jobs Tool Person', status: 'Order Confirmed', sold_amount: 4200, estimated_install_at: '2026-11-02' }
  );
  assert.ok(!r.jobs.some((j) => j.job_id === done.id), 'Complete jobs are left out');
  assert.ok(!('queue' in r), 'not an alias of list_production_queue');
  assert.deepEqual(assistant.runTool('navigate_to_record', { type: 'jobs' }).__navigate, '/dashboard/jobs');
  const prompt = assistant.systemPrompt({});
  assert.match(prompt, /"all jobs", "active jobs"[^]*call list_jobs/);
  assert.match(prompt, /Never answer those with list_production_queue/);
});

// ================================================================ BF-2639-053
test('BF-2639-053: a file with no customer has its filename as a link to a review page where it can be assigned', async () => {
  fs.mkdirSync(path.join(UPLOADS, '_unassigned'), { recursive: true });
  const stored = `t181-orphan-${Date.now()}.png`;
  fs.writeFileSync(path.join(UPLOADS, '_unassigned', stored), makePng());
  const id = db.createCustomerFile({ customer_id: null, stored_name: stored, original_name: 'orphan-053.png', mime_type: 'image/png', size: 10, assignment_status: 'needs_review' });
  const html = await (await srv.get('/dashboard/files/results?q=' + encodeURIComponent('orphan-053'))).text();
  assert.match(html, new RegExp(`<a href="/dashboard/files/${id}/review">orphan-053\.png</a>`));
  const review = await srv.get(`/dashboard/files/${id}/review`);
  assert.equal(review.status, 200);
  const rhtml = await review.text();
  assert.match(rhtml, new RegExp(`<img class="viewer-img" src="/dashboard/files/${id}/raw"`), 'Andrew can see the file');
  assert.match(rhtml, new RegExp(`action="/dashboard/customer-files/${id}/assign"`), 'and assign it');
  assert.match(rhtml, /data-viewer-close/);
  const raw = await srv.get(`/dashboard/files/${id}/raw`);
  assert.equal(raw.status, 200);
  assert.ok(isPng(Buffer.from(await raw.arrayBuffer())));
  // Assigning it moves the bytes, and the customer viewer then opens it (BF-2639-064 still holds).
  const c = db.createCustomer({ name: 'Orphan Owner', phone: '+18045550153' });
  madeDirs.add(path.join(UPLOADS, c.id));
  await srv.post(`/dashboard/customer-files/${id}/assign`, { customer_id: c.id });
  assert.equal((await srv.get(`/dashboard/customers/${c.id}/files/${id}`)).status, 200);
});

// ================================================================ BF-2639-054
test('BF-2639-054: the Files page has a Refresh control that keeps the current q', async () => {
  let html = await (await srv.get('/dashboard/files')).text();
  assert.match(html, /<a class="btn small secondary" id="files-refresh" data-files-refresh href="\/dashboard\/files">&#x21bb; Refresh<\/a>/);
  html = await (await srv.get('/dashboard/files?q=' + encodeURIComponent('kitchen order'))).text();
  assert.match(html, /id="files-refresh" data-files-refresh href="\/dashboard\/files\?q=kitchen%20order"/);
  assert.match(html, /refresh\.setAttribute\('href', '\/dashboard\/files' \+ \(q \? '\?q=' \+ encodeURIComponent\(q\) : ''\)\)/, 'follows live typing too');
});

// ================================================================ BF-2639-055
test('BF-2639-055: both Menu toggles show a hamburger, not the word Menu, and keep data-menu-toggle', () => {
  const render = require('../src/render');
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const toggles = [...html.matchAll(/<button[^>]*data-menu-toggle[^>]*>([^]*?)<\/button>/g)];
  assert.equal(toggles.length, 2, 'desktop top bar + phone bottom bar');
  for (const [whole, inner] of toggles) {
    assert.ok(!/Menu/.test(inner.replace(/<[^>]+>/g, '')), 'no visible word Menu');
    assert.match(inner, /<svg class="hamburger"[^>]*aria-hidden="true"[^>]*><path d="M3 6h18M3 12h18M3 18h18"/);
    assert.match(whole, /aria-label="Menu"/);
  }
});

// ================================================================ BF-2639-056
test('BF-2639-056: menu groups run Customer Relations, Financial, Production, Marketing, Training; then version; then Log out', () => {
  const render = require('../src/render');
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const sheet = html.slice(html.indexOf('id="menu-sheet"'), html.indexOf('</script>', html.indexOf('id="menu-sheet"')));
  const titles = [...sheet.matchAll(/menu-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles.slice(0, 5), ['Customer Relations', 'Financial', 'Production', 'Marketing', 'Training']);
  // BF-2640-082 turned Training on: the Training item is a real link now.
  assert.match(sheet, /<a href="\/dashboard\/training"[^>]*>Training<\/a>/);
  const version = sheet.indexOf('class="menu-version"');
  const logout = sheet.indexOf('href="/logout"');
  assert.ok(version > sheet.lastIndexOf('menu-group-title') && logout > version, 'version line after the groups, Log out last');
  assert.ok(!sheet.slice(logout).includes('menu-disabled'));
});

// ================================================================ BF-2639-058
test('BF-2639-058: the customer page has no Dormant checkbox or pill, and saving a stage leaves dormant alone', async () => {
  const c = db.createCustomer({ name: 'Dormant Hidden', phone: '+18045550158' });
  db.setCustomerDormant(c.id, true, { actor: 'test' });
  const html = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.ok(!/name="dormant"/.test(html), 'no Dormant checkbox');
  assert.ok(!/>Dormant<\/span>/.test(html), 'no Dormant pill');
  await srv.post(`/dashboard/customers/${c.id}/stage`, { sales_stage: 'Bona Fide Lead', stage_substatus: '' });
  assert.equal(db.getCustomer(c.id).dormant, 1, 'existing dormant value is not rewritten');
});

// ================================================================ BF-2639-067
test('BF-2639-067: install reminders say empty the cabinets; estimate reminders keep do-not-empty', () => {
  const automations = require('../src/services/automations');
  const c = db.createCustomer({ name: 'Reminder Person', phone: '+18045550167', email: 'rem@example.com', address: '12 Oak St, Richmond, VA 23220' });
  const at = '2026-10-09T18:00:00.000Z'; // 2:00 PM ET
  const install = db.createAppointment({ customer_id: c.id, type: 'Install', scheduled_at: at });
  const estimate = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: at });
  const link = (a) => automations.appointmentUrl(a.public_token);

  const i = automations.buildInstallReminder({ appt: install, customer: c });
  // ICU may put a narrow no-break space before PM; compare with a plain one.
  const plain = (s) => s.replace(/[  ]/g, ' ');
  assert.equal(
    plain(i.smsBody),
    [
      'Shelves to Drawers RVA — install',
      'Friday, October 9 at 2:00 PM ET',
      '12 Oak St, Richmond, VA 23220',
      'Please empty the cabinets completely and wipe them out before we arrive. If something in the back is stuck or heavy, leave it and we will help.',
      'Leave a clear walkway into the house and a small open spot to stage product. A small space is enough.',
      `Your page (details, contact us, request a new time): ${link(install)}`,
      `Or call/text Andrew: ${process.env.BUSINESS_PHONE || '(804) 839-7984'}`,
    ].join('\n')
  );
  const plainI = plain(i.smsBody);
  assert.match(plainI, /^Shelves to Drawers RVA — install\nFriday, October 9 at 2:00 PM ET\n12 Oak St, Richmond, VA 23220\n/);
  assert.match(plainI, /empty the cabinets completely/);
  assert.ok(!/do not empty/i.test(plainI + i.emailHtml));

  const e = automations.buildEstimateReminder({ appt: estimate, customer: c });
  const plainE = plain(e.smsBody);
  assert.match(plainE, /do not empty your cabinets/);
  assert.ok(!/empty the cabinets completely/.test(plainE + e.emailHtml));
  // Same date, address, public link and phone footer as the install body.
  for (const line of ['Friday, October 9 at 2:00 PM ET', '12 Oak St, Richmond, VA 23220', `Your page (details, contact us, request a new time): ${link(estimate)}`, 'Or call/text Andrew: ']) {
    assert.ok(plainE.includes(line), line);
  }
  // The appointment type chooses the body.
  assert.match(automations.buildAppointmentReminder({ appt: install, customer: c }).smsBody, /empty the cabinets completely/);
  assert.match(automations.buildAppointmentReminder({ appt: estimate, customer: c }).smsBody, /do not empty/);
  const measure = db.createAppointment({ customer_id: c.id, type: 'Measure', scheduled_at: at });
  assert.match(automations.buildAppointmentReminder({ appt: measure, customer: c }).smsBody, /^Reminder from Shelves to Drawers RVA: you have a "Measure" appointment/, 'other types keep their old body');
  // No Twilio secrets in the code.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'automations.js'), 'utf8');
  assert.ok(!/AC[0-9a-f]{32}/i.test(src));
});

// ================================================================ BF-2639-068
test('BF-2639-068: the page the reminder links to lets the customer contact Andrew and request a new time (without moving the appointment)', async () => {
  const c = db.createCustomer({ name: 'Public Page Person', phone: '+18045550168' });
  const appt = db.createAppointment({ customer_id: c.id, type: 'Install', scheduled_at: '2026-10-09T18:00:00.000Z' });
  const automations = require('../src/services/automations');
  const reminderLink = automations.buildAppointmentReminder({ appt, customer: c }).smsBody.match(/Your page[^:]*: (\S+)/)[1];
  assert.ok(reminderLink.endsWith(`/appointment/${appt.public_token}`));
  const html = await (await srv.get(`/appointment/${appt.public_token}`)).text();
  assert.match(html, /<a class="btn secondary" href="tel:\+?\d{10,11}" data-contact-andrew>/);
  assert.match(html, /<a class="btn secondary" href="sms:\+?\d{10,11}" data-contact-andrew>Text Andrew<\/a>/);
  assert.match(html, new RegExp(`href="/appointment/${appt.public_token}/change" data-request-new-time>Request a new time</a>`));

  const form = await (await srv.get(`/appointment/${appt.public_token}/change`)).text();
  assert.match(form, /name="preferred"/);
  const r = await srv.post(`/appointment/${appt.public_token}/change`, { preferred: 'Any weekday after 2pm' });
  assert.equal(r.status, 302);
  const f = db.listFollowups(c.id).find((x) => x.status === 'open' && /^Reschedule request: Install/.test(x.title));
  assert.ok(f, 'an open follow-up for Andrew');
  assert.match(f.title, /Any weekday after 2pm/);
  const after = db.getAppointment(appt.id);
  assert.equal(after.scheduled_at, '2026-10-09T18:00:00.000Z', 'stored time unchanged');
  assert.equal(after.status, 'scheduled');
});

// ================================================================ FF-3926-003
test('FF-3926-003: create_campaign reads back, writes only with confirmed:true, and never creates a missing source', () => {
  const assistant = require('../src/services/assistant');
  assert.ok(assistant.TOOLS.some((t) => t.name === 'create_campaign'));
  const src = db.createSource({ name: 'Radio 181' });
  const count = () => db.listCampaigns({ includeInactive: true }).length;
  const input = { source_id: src.id, name: 'Fall Radio Spot', tracking_phone: '804-555-0199', start_date: '2026-10-01', end_date: '2026-10-31', spend: 1250, status: 'planned' };

  const before = count();
  const preview = assistant.runTool('create_campaign', input);
  assert.equal(count(), before, 'no row without confirmed:true');
  assert.match(preview.readback, /Campaign "Fall Radio Spot" under Radio 181; status planned; tracking phone 804-555-0199; starts 2026-10-01; ends 2026-10-31; spend \$1250\.00/);

  const done = assistant.runTool('create_campaign', { ...input, confirmed: true });
  assert.equal(done.ok, true);
  const row = db.getCampaign(done.campaign.id);
  assert.deepEqual(
    [row.source_id, row.name, row.start_date, row.end_date, row.cost, row.status, row.tracking_phone],
    [src.id, 'Fall Radio Spot', '2026-10-01', '2026-10-31', 1250, 'planned', '+18045550199']
  );

  // Missing source: nothing created - no campaign and no new source.
  const sourcesBefore = db.listSources({ includeInactive: true }).length;
  const campaignsBefore = count();
  const miss = assistant.runTool('create_campaign', { source_name: 'Billboards Nobody Made', name: 'X', confirmed: true });
  assert.match(miss.error, /no marketing source named "Billboards Nobody Made"/);
  assert.equal(db.listSources({ includeInactive: true }).length, sourcesBefore);
  assert.equal(count(), campaignsBefore);

  // Nothing invented: no spend/dates given -> stored as empty.
  const bare = assistant.runTool('create_campaign', { source_name: 'radio 181', name: 'Bare', confirmed: true });
  const b = db.getCampaign(bare.campaign.id);
  assert.deepEqual([b.cost, b.start_date, b.end_date], [null, null, null]);
});

// ================================================================ FF-3926-012
function textPdf(text) {
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1'),
  ]);
}

test('FF-3926-012: one tenant, tenant_id backfilled on customers/jobs/files/users, and the records table has the required columns', () => {
  const tenants = db.db.prepare('SELECT * FROM tenants').all().filter((t) => t.id !== 'tenant-other');
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].id, db.DEFAULT_TENANT_ID);
  for (const t of ['customers', 'jobs', 'customer_files', 'users']) {
    const cols = db.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols.includes('tenant_id'), `${t}.tenant_id`);
  }
  const c = db.createCustomer({ name: 'Tenant Backfill', phone: '+18045550112' });
  assert.equal(db.db.prepare('SELECT tenant_id FROM customers WHERE id = ?').get(c.id).tenant_id, db.DEFAULT_TENANT_ID);
  const cols = db.db.prepare('PRAGMA table_info(records)').all().map((x) => x.name);
  for (const k of ['id', 'tenant_id', 'owner_user_id', 'kind', 'name', 'is_business', 'is_personal', 'phone', 'email', 'address', 'notes', 'created_at', 'updated_at', 'deleted_at']) {
    assert.ok(cols.includes(k), `records.${k}`);
  }
  for (const t of ['record_categories', 'record_category_map', 'record_tags', 'record_shares', 'record_files']) {
    assert.ok(db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), t);
  }
});

test('FF-3926-012: the repository seeds no records - a fresh clone starts with zero', () => {
  // The only INSERT INTO records anywhere in src/ or scripts/ is inside createRecord.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const roots = ['src', 'scripts'].map((d) => path.join(__dirname, '..', d)).filter((d) => fs.existsSync(d));
  const files = roots.flatMap(walk).filter((f) => /\.(js|sql|json)$/.test(f));
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/INSERT INTO records\b/g)) {
      const fnStart = src.lastIndexOf('\nfunction ', m.index);
      hits.push(`${path.basename(f)}:${src.slice(fnStart + 10, src.indexOf('(', fnStart))}`);
    }
  }
  assert.deepEqual(hits, ['db.js:createRecord']);
  // A brand-new database - what a second company's clone gets - has no records.
  const { spawnSync } = require('child_process');
  const os = require('os');
  const fresh = path.join(os.tmpdir(), `bos-clone-${process.pid}-${Date.now()}.sqlite3`);
  const out = spawnSync(
    process.execPath,
    ['-e', "const d=require('./src/db');process.stdout.write(d.db.prepare('SELECT COUNT(*) n FROM records').get().n+','+d.db.prepare('SELECT COUNT(*) n FROM tenants').get().n)"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, BOS_DB_PATH: fresh }, encoding: 'utf8' }
  );
  for (const s of ['', '-wal', '-shm']) fs.rmSync(fresh + s, { force: true });
  assert.equal(out.stdout, '0,1', out.stderr);
});

// FF-2640-016 renamed Desk to Contacts and BF-2640-083 / FF-2640-015 / FF-2640-020
// added the Today group (Today, Tomorrow, Lists) above it.
test('FF-3926-012: Contacts (once Desk) sits in its own Menu group directly above the BOS version line', () => {
  const render = require('../src/render');
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const sheet = html.slice(html.indexOf('id="menu-sheet"'), html.indexOf('</script>', html.indexOf('id="menu-sheet"')));
  const titles = [...sheet.matchAll(/menu-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Customer Relations', 'Financial', 'Production', 'Marketing', 'Training', 'Today', 'Contacts']);
  const contacts = sheet.indexOf('href="/dashboard/contacts"');
  assert.ok(contacts > sheet.indexOf('menu-group-title">Today<') && contacts < sheet.indexOf('class="menu-version"'));
  assert.ok(!/>Desk</.test(sheet), 'the Menu does not say Desk');
});

// FF-2640-016: the page is Contacts now. Old /dashboard/desk links still work
// (a GET is sent on with 302, a POST with 307), and a car is not a contact.
test('FF-3926-012: the Contacts page creates, lists, filters, searches and opens records, and a record file opens', async () => {
  const old = await srv.post('/dashboard/desk', { kind: 'person', name: 'Old Link Person' });
  assert.equal(old.status, 307);
  assert.equal(old.headers.get('location'), '/dashboard/contacts');
  const oldGet = await srv.get('/dashboard/desk?f=mine');
  assert.equal(oldGet.status, 302);
  assert.equal(oldGet.headers.get('location'), '/dashboard/contacts?f=mine');

  const r = await srv.post('/dashboard/contacts', { kind: 'person', name: 'Sparky Desk Electric', is_business: '1', phone: '804-555-0122', categories: 'Electrician, Contractors', notes: 'Did the panel in 2025' });
  assert.equal(r.status, 302);
  const recUrl = r.headers.get('location').split('?')[0];
  const recId = recUrl.split('/').pop();
  await srv.post('/dashboard/contacts', { kind: 'person', name: 'Desk Test Friend', is_personal: '1', categories: 'Friends' });
  await srv.post('/dashboard/contacts', { kind: 'thing', name: 'Desk Test Car', is_personal: '1', categories: 'Cars' });

  const list = async (qs) => (await srv.get('/dashboard/contacts' + qs)).text();
  let html = await list('');
  assert.match(html, /<h1>Contacts<\/h1>/);
  assert.match(html, /Sparky Desk Electric/);
  assert.ok(!/Desk Test Car/.test(html), 'a car is not a contact');
  for (const f of ['all', 'mine', 'lead', 'personal', 'vendor', 'business']) assert.match(html, new RegExp(`data-desk-filter="${f}"`));
  assert.match(html, /name="q"/);
  assert.match(html, /<select id="desk-cat" name="cat">/);
  html = await list('?f=business');
  assert.ok(/Sparky Desk Electric/.test(html) && !/Desk Test Friend/.test(html));
  html = await list('?f=personal');
  assert.ok(!/Sparky Desk Electric/.test(html) && /Desk Test Friend/.test(html));
  html = await list('?cat=electrician');
  assert.ok(/Sparky Desk Electric/.test(html) && !/Desk Test Friend/.test(html));
  html = await list('?q=panel');
  assert.ok(/Sparky Desk Electric/.test(html) && !/Desk Test Friend/.test(html));
  html = await (await srv.get(recUrl)).text();
  assert.match(html, /<h1>Sparky Desk Electric<\/h1>/);

  // Attach a file through the same multipart path and open it.
  madeDirs.add(path.join(UPLOADS, '_records', recId));
  const up = await postMultipart(`/dashboard/contacts/${recId}/files`, {}, { data: textPdf('Warranty through 2027'), name: 'warranty.pdf', type: 'application/pdf' });
  assert.equal(up.status, 302);
  const [f] = db.listRecordFiles(recId);
  assert.match(f.extracted_text, /Warranty through 2027/);
  const view = await (await srv.get(`/dashboard/contacts/${recId}/files/${f.id}/view`)).text();
  assert.match(view, /data-viewer-close/);
  const raw = await srv.get(`/dashboard/contacts/${recId}/files/${f.id}`);
  assert.equal(raw.status, 200);
  assert.equal(Buffer.from(await raw.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  // BF-2640-075 changed this: the Files page lists every file the signed-in user
  // may see, so the record owner's file is listed and linked to its contact.
  // A user who cannot see the record never gets the file (update-2640-fix.test.js).
  const filesHtml = await (await srv.get('/dashboard/files/results')).text();
  assert.match(filesHtml, new RegExp(`<a href="/dashboard/contacts/${recId}">Contact: Sparky Desk Electric</a>`));
});

test('FF-3926-012: a share cannot cross tenants', () => {
  const owner = db.ensureUser('share-owner');
  db.db.prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES ('tenant-other', 'Other Co', ?)`).run(new Date().toISOString());
  const outsider = db.ensureUser('outsider', { tenant_id: 'tenant-other' });
  const colleague = db.ensureUser('colleague');
  const rec = db.createRecord(owner, { kind: 'person', name: 'Cross Tenant Test', is_business: true });
  const bad = db.shareRecord(owner, rec.id, outsider.id);
  assert.match(bad.error, /only be shared inside its own company/);
  assert.equal(db.getRecordFor(outsider, rec.id), null);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM record_shares WHERE record_id = ?').get(rec.id).n, 0);
  assert.equal(db.shareRecord(owner, rec.id, colleague.id).ok, true);
  assert.ok(db.getRecordFor(colleague, rec.id));
});

// ================================================================ FF-3926-013
test("FF-3926-013: a second user cannot fetch the first user's personal record (db and assistant)", () => {
  const assistant = require('../src/services/assistant');
  const first = db.ensureUser('first-user');
  const second = db.ensureUser('second-user');
  const rec = db.createRecord(first, { kind: 'person', name: 'Private Person 013', is_personal: true, notes: 'personal' });
  assert.ok(db.getRecordFor(first, rec.id));
  assert.equal(db.getRecordFor(second, rec.id), null);
  assert.match(assistant.runTool('get_record', { record_id: rec.id }, { username: 'second-user' }).error, /not found/);
  assert.equal(assistant.runTool('search_records', { query: 'Private Person 013' }, { username: 'second-user' }).count, 0);
  assert.equal(assistant.runTool('get_record', { record_id: rec.id }, { username: 'first-user' }).record.name, 'Private Person 013');
  // Shared -> visible, but read-only.
  db.shareRecord(first, rec.id, second.id);
  assert.ok(db.getRecordFor(second, rec.id));
  assert.match(assistant.runTool('update_record', { record_id: rec.id, notes: 'x', confirmed: true }, { username: 'second-user' }).error, /only its owner can edit/);
});

test('FF-3926-013: "how many electricians" counts only my Electrician records plus ones shared with me', () => {
  const assistant = require('../src/services/assistant');
  const me = db.ensureUser('cat-me');
  const other = db.ensureUser('cat-other');
  db.createRecord(me, { kind: 'person', name: 'Mine Electric A', categories: ['Electrician'] });
  db.createRecord(me, { kind: 'person', name: 'Mine Electric B', categories: ['electrician'] });
  db.createRecord(me, { kind: 'person', name: 'Mine Accountant', categories: ['Accountant'] });
  const theirsShared = db.createRecord(other, { kind: 'person', name: 'Their Electric Shared', is_business: true, categories: ['Electrician'] });
  db.createRecord(other, { kind: 'person', name: 'Their Electric Private', categories: ['Electrician'] });
  db.shareRecord(other, theirsShared.id, me.id);
  const r = assistant.runTool('list_records_by_category', { category: 'Electrician' }, { username: 'cat-me' });
  assert.equal(r.count, 3);
  assert.deepEqual(r.records.map((x) => x.name).sort(), ['Mine Electric A', 'Mine Electric B', 'Their Electric Shared']);
  assert.match(assistant.systemPrompt({}), /"How many electricians do I\s+have" -> list_records_by_category/);
});

test('FF-3926-013: create_record without confirmed:true inserts nothing; with it, one row', () => {
  const assistant = require('../src/services/assistant');
  const n = () => db.db.prepare('SELECT COUNT(*) n FROM records').get().n;
  const before = n();
  const preview = assistant.runTool('create_record', { kind: 'person', name: 'Unconfirmed Accountant', categories: ['Accountant'] }, { username: 'first-user' });
  assert.equal(n(), before);
  assert.match(preview.readback, /Person; "Unconfirmed Accountant"; categories: Accountant/);
  const done = assistant.runTool('create_record', { kind: 'person', name: 'Unconfirmed Accountant', categories: ['Accountant'], confirmed: true }, { username: 'first-user' });
  assert.equal(done.ok, true);
  assert.equal(n(), before + 1);
  const upd = assistant.runTool('update_record', { record_id: done.record.record_id, notes: 'CPA' }, { username: 'first-user' });
  assert.match(upd.error, /Not changed yet/);
  assert.equal(db.getRecordFor(db.ensureUser('first-user'), done.record.record_id).notes, null);
});

test('FF-3926-013: "which cars have FSD" matches notes and PDF text, never a photo with no text', () => {
  const assistant = require('../src/services/assistant');
  const me = db.ensureUser('car-owner');
  const withPdf = db.createRecord(me, { kind: 'thing', name: 'Blue Model Y', is_personal: true, categories: ['Cars'] });
  const photoOnly = db.createRecord(me, { kind: 'thing', name: 'Red Model 3', is_personal: true, categories: ['Cars'] });
  db.createRecord(me, { kind: 'thing', name: 'White Cybertruck', is_personal: true, categories: ['Cars'], notes: 'Has FSD transfer' });
  for (const r of [withPdf, photoOnly]) madeDirs.add(path.join(UPLOADS, '_records', r.id));
  db.addRecordFile(me, withPdf.id, { filename: 'window-sticker.pdf', mimeType: 'application/pdf', data: textPdf('Full Self-Driving Capability (FSD) included') });
  db.addRecordFile(me, photoOnly.id, { filename: 'car.png', mimeType: 'image/png', data: makePng() });
  const res = assistant.runTool('search_records', { query: 'FSD', category: 'Cars' }, { username: 'car-owner' });
  const names = res.records.map((r) => r.name).sort();
  assert.deepEqual(names, ['Blue Model Y', 'White Cybertruck']);
  assert.deepEqual(res.records.find((r) => r.name === 'Blue Model Y').matched_in, ['file: window-sticker.pdf']);
  assert.deepEqual(res.records.find((r) => r.name === 'White Cybertruck').matched_in, ['record']);
  assert.equal(db.listRecordFiles(photoOnly.id)[0].extracted_text, null, 'the photo yields no text');
  assert.ok(!names.includes('Red Model 3'));
});

// ================================================================ BF-2640-081
test('BF-2640-081: phone bar is Back, Overview, Appts, Pipeline, Menu; desktop top bar has no Back', () => {
  const render = require('../src/render');
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const bottom = html.slice(html.indexOf('<nav class="bottomnav"'));
  const bar = bottom.slice(0, bottom.indexOf('</nav>'));
  const items = [...bar.matchAll(/<(a|button)\b([^>]*)>/g)].map(([, tag, attrs]) =>
    tag === 'a' ? attrs.match(/href="([^"]+)"/)[1] : (attrs.match(/aria-label="([^"]+)"/) || [])[1]);
  assert.deepEqual(items, ['Back', '/dashboard', '/dashboard/appointments', '/dashboard/pipeline', 'Menu']);
  assert.match(bar, /data-dash-back[^>]*>[^]*<span>Back<\/span>/);
  const top = html.slice(html.indexOf('<nav class="topnav-links"'), html.indexOf('</nav>', html.indexOf('<nav class="topnav-links"')));
  assert.ok(!/data-dash-back|Back/.test(top), 'no Back on the desktop top bar');
});

test('BF-2640-081: Back walks an in-app /dashboard history and does nothing on the first page of the visit', () => {
  const render = require('../src/render');
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const start = html.indexOf('<script>', html.indexOf('<nav class="bottomnav"'));
  const code = html.slice(start + '<script>'.length, html.indexOf('</script>', start));

  // Minimal browser stand-ins: one sessionStorage per visit, a location, click and input listeners.
  function visit(store, url) {
    const [pathname, q] = url.split('?');
    const listeners = {};
    const loc = { pathname, search: q ? '?' + q : '', href: url };
    const document = { addEventListener: (ev, fn) => { listeners[ev] = fn; } };
    const sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
    new Function('location', 'document', 'sessionStorage', 'confirm', code)(loc, document, sessionStorage, () => false);
    const backBtn = { closest: (sel) => (sel === '[data-dash-back]' ? {} : null) };
    return {
      loc,
      back() { listeners.click({ target: backBtn }); return loc.href === url ? null : loc.href; },
      type() { listeners.input({ target: { closest: () => ({}) } }); },
    };
  }
  const store = {};
  assert.equal(visit(store, '/dashboard').back(), null, 'first dashboard page of the visit: Back does nothing');
  visit(store, '/dashboard/customers');
  const page = visit(store, '/dashboard/customers/7?tab=files');
  assert.equal(page.back(), '/dashboard/customers');
  assert.equal(visit(store, '/dashboard/customers').back(), '/dashboard');
  assert.equal(visit(store, '/dashboard').back(), null, 'back at the start of the visit');

  // Pages outside /dashboard (login, public booking) are never recorded.
  const s2 = {};
  visit(s2, '/login');
  visit(s2, '/book');
  assert.equal(visit(s2, '/dashboard/pipeline').back(), null);

  // Typed changes on the current page are not dropped without asking (confirm answers No here).
  const s3 = {};
  visit(s3, '/dashboard');
  const form = visit(s3, '/dashboard/customers/7');
  form.type();
  assert.equal(form.back(), null, 'declined confirm keeps Andrew on the form');
  assert.ok(!/\.back\(\)|history\.go/.test(code), 'Back never uses browser history, which can hold login or public pages');
});
