// BF-2640-085, FF-2640-021, FF-2640-022, FF-2640-023, and FF-2640-024.
// Throwaway DB and uploads folder (tests/helpers.js) and a real server on a
// random port (tests/http-helper.js) with every messaging and AI credential
// blanked, so nothing here can send a real text or email.
for (const k of ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ANTHROPIC_API_KEY']) process.env[k] = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');
const assistant = require('../src/services/assistant');
const render = require('../src/render');
const { bosDayString, nextDateString, fmtDate } = require('../src/util');

const UPLOADS = path.join(path.dirname(tmpDbPath), 'uploads');
let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(async () => {
  if (srv) await srv.stop();
});

function postMultipart(p, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, v);
  if (file) fd.append(file.field || 'file', new Blob([file.data], { type: file.type || 'application/pdf' }), file.name);
  return fetch(srv.base + p, { method: 'POST', body: fd, redirect: 'manual' });
}
const pdf = (text) => Buffer.from(`%PDF-1.4 ${text} ` + 'x'.repeat(200));
const sheetOf = (html) => html.slice(html.indexOf('id="menu-sheet"'), html.indexOf('</script>', html.indexOf('id="menu-sheet"')));

// ================================================================ BF-2640-085
test('BF-2640-085: Tomorrow opens the day page for the next day, titled Tomorrow, with the visits BOS already stored, and no list in front of it', async () => {
  const today = bosDayString();
  const tomorrow = nextDateString(today);
  const c = db.createCustomer({ name: 'Next Day Visit', phone: '+18045550861' });
  db.createAppointment({ customer_id: c.id, type: 'Consultation', scheduled_at: `${tomorrow}T15:00:00.000Z` });

  const todayHtml = await (await srv.get('/dashboard/today')).text();
  assert.match(todayHtml, /<h1 data-day-heading>Today<\/h1>/);
  assert.match(todayHtml, new RegExp(`href="/dashboard/today\\?date=${tomorrow}" data-tomorrow>Tomorrow<`), 'the Tomorrow button opens the day page');

  const menuLink = await srv.get('/dashboard/tomorrow');
  assert.equal(menuLink.status, 302);
  assert.equal(menuLink.headers.get('location'), `/dashboard/today?date=${tomorrow}`, 'the Menu link goes straight to the day page');

  const html = await (await srv.get(`/dashboard/today?date=${tomorrow}`)).text();
  assert.match(html, /<title>Tomorrow - /);
  assert.match(html, /<h1 data-day-heading>Tomorrow<\/h1>/);
  assert.ok(!/<h1[^>]*>Today<\/h1>/.test(html), 'the day page for tomorrow never says Today');
  assert.match(html, /<a href="\/dashboard\/today">Back to today<\/a>/);
  const visits = html.slice(html.indexOf('id="today-visits"'), html.indexOf('id="today-items"'));
  assert.match(visits, /Next Day Visit/);
  assert.ok(!/Open tomorrow's day page|id="tomorrow-visits"/.test(html), 'no second screen in front of the visits');
});

test('BF-2640-085: a day that is not today and not tomorrow says the date', async () => {
  const day = '2026-12-15';
  const html = await (await srv.get(`/dashboard/today?date=${day}`)).text();
  const label = fmtDate(`${day}T12:00:00.000Z`);
  assert.match(html, new RegExp(`<h1 data-day-heading>${label}</h1>`));
  assert.match(html, new RegExp(`<title>${label} - `));
  assert.match(html, /Back to today/);
});

// ================================================================ FF-2640-024
test('FF-2640-024: the phone bar is Back, Overview, Appts, Today, and Menu, and Pipeline stays in the Menu', () => {
  const html = render.dashboardLayout({ title: 'T', active: '/dashboard', body: '<p>x</p>', context: {} });
  const bottom = html.slice(html.indexOf('<nav class="bottomnav"'));
  const bar = bottom.slice(0, bottom.indexOf('</nav>'));
  const items = [...bar.matchAll(/<(a|button)\b([^>]*)>/g)].map(([, tag, attrs]) =>
    tag === 'a' ? attrs.match(/href="([^"]+)"/)[1] : (attrs.match(/aria-label="([^"]+)"/) || [])[1]);
  assert.deepEqual(items, ['Back', '/dashboard', '/dashboard/appointments', '/dashboard/today', 'Menu']);
  assert.match(bar, /<a href="\/dashboard\/today"[^>]*>Today<\/a>/);
  assert.match(sheetOf(html), /<a href="\/dashboard\/pipeline">Pipeline<\/a>/, 'Pipeline stays in the Menu');
  const onToday = render.dashboardLayout({ title: 'T', active: '/dashboard/today', body: '<p>x</p>', context: {} });
  const todayBar = onToday.slice(onToday.indexOf('<nav class="bottomnav"'));
  assert.match(todayBar.slice(0, todayBar.indexOf('</nav>')), /<a href="\/dashboard\/today" class="active" aria-current="page">Today<\/a>/);
});

// ================================================================ FF-2640-021
test('FF-2640-021: a new file has one readable name in the last-name folder, contract-2640.pdf style, with no first name', async () => {
  assert.equal(db.yearWeekTag('2026-10-02'), '2640', 'October 2, 2026 is week 40');
  const wk = db.yearWeekTag();
  const c = db.createCustomer({ name: 'Ann Walker', phone: '+18045550862', email: 'ann.walker@example.com', address: '5 Oak St, Richmond, VA 23220', notes: 'Pantry pull-outs' });
  const r = await postMultipart(`/dashboard/customers/${c.id}/files`, { note: 'signed contract' }, { data: pdf('contract'), name: 'Ann Contract.pdf' });
  assert.equal(r.status, 302);
  const [f] = db.listCustomerFiles(c.id);
  assert.equal(f.original_name, `contract-${wk}.pdf`);
  assert.equal(f.stored_name, f.original_name, 'the same name on the Files page and in the folder');
  assert.equal(f.folder, 'Walker');
  assert.ok(!/ann/i.test(f.original_name), 'no first name in the name');
  assert.ok(fs.existsSync(path.join(UPLOADS, 'Walker', `contract-${wk}.pdf`)));

  const filesPage = await (await srv.get('/dashboard/files/results')).text();
  assert.match(filesPage, new RegExp(`>contract-${wk}\\.pdf</a>`));

  const txt = fs.readFileSync(path.join(UPLOADS, 'Walker', 'customer.txt'), 'utf8');
  for (const line of ['Name: Ann Walker', 'Phone: +18045550862', 'Email: ann.walker@example.com', 'Address: 5 Oak St, Richmond, VA 23220', 'Note: Pantry pull-outs']) assert.ok(txt.includes(line), line);

  const second = db.createCustomer({ name: 'Bob Walker', phone: '+18045550863' });
  await postMultipart(`/dashboard/customers/${second.id}/files`, {}, { data: pdf('drawing'), name: 'drawing.pdf' });
  const [g] = db.listCustomerFiles(second.id);
  assert.equal(g.folder, 'Walker-2', 'a second customer with the same last name is Walker-2');
  assert.ok(fs.existsSync(path.join(UPLOADS, 'Walker-2', `drawing-${wk}.pdf`)));
});

test('FF-2640-021: a rename on the Files page renames the file, and search uses that name', async () => {
  const wk = db.yearWeekTag();
  const c = db.createCustomer({ name: 'Rita Moreno', phone: '+18045550864' });
  await postMultipart(`/dashboard/customers/${c.id}/files`, {}, { data: pdf('estimate'), name: 'estimate.pdf' });
  const [f] = db.listCustomerFiles(c.id);
  const before = db.fileBytesPath(f);
  assert.ok(fs.existsSync(before));
  const filesPage = await (await srv.get('/dashboard/files/results')).text();
  assert.match(filesPage, new RegExp(`action="/dashboard/files/${f.id}/rename"`), 'the Files page has Rename');

  const res = await srv.post(`/dashboard/files/${f.id}/rename`, { name: `quote-${wk}.pdf`, return_to: '/dashboard/files' });
  assert.equal(res.status, 302);
  const after = db.getCustomerFile(f.id);
  assert.equal(after.original_name, `quote-${wk}.pdf`);
  assert.equal(after.stored_name, after.original_name);
  assert.ok(!fs.existsSync(before), 'the old name is gone from the folder');
  assert.ok(fs.existsSync(path.join(UPLOADS, 'Moreno', `quote-${wk}.pdf`)), 'the file itself was renamed');
  assert.ok(db.searchFiles('quote').some((x) => x.id === f.id), 'search uses the new name');
});

test('FF-2640-021: old files stay as they are', async () => {
  const c = db.createCustomer({ name: 'Old File Person', phone: '+18045550865' });
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine-id-1.pdf'), pdf('old'));
  const id = db.createCustomerFile({ customer_id: c.id, stored_name: 'machine-id-1.pdf', original_name: 'old contract.pdf', mime_type: 'application/pdf', size: 10 });
  const f = db.getCustomerFile(id);
  assert.equal(f.folder, null);
  assert.equal(f.original_name, 'old contract.pdf');
  assert.equal(db.fileBytesPath(f), path.join(dir, 'machine-id-1.pdf'));
  const raw = await srv.get(`/dashboard/customers/${c.id}/files/${id}`);
  assert.equal(raw.status, 200);
});

// ================================================================ FF-2640-022
test('FF-2640-022: Documents is in the Menu near the end, and the shelf holds the insurance certificate', async () => {
  const html = await (await srv.get('/dashboard')).text();
  const sheet = sheetOf(html);
  const titles = [...sheet.matchAll(/menu-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.equal(titles[titles.length - 1], 'Documents', 'the last group, above the version line');
  const docLink = sheet.indexOf('<a href="/dashboard/documents">Documents</a>');
  assert.ok(docLink > 0 && docLink < sheet.indexOf('class="menu-version"') && sheet.indexOf('class="menu-version"') < sheet.indexOf('/logout'));

  const page = await (await srv.get('/dashboard/documents')).text();
  for (const k of ['warranty', 'product_page', 'referral', 'insurance', 'license', 'product_photo']) assert.match(page, new RegExp(`id="documents-${k}"`));
  const ins = db.listDocuments({ category: 'insurance' })[0];
  assert.equal(ins.title, 'Certificate of liability insurance');
  assert.match(ins.description, /Q61-0725519/);
  assert.match(ins.description, /Q34-0270524/);
  assert.match(ins.description, /10\/02\/2026 through 10\/02\/2027/);

  // The certificate PDF is uploaded into that row, then opens.
  const up = await postMultipart(`/dashboard/documents/${ins.id}/file`, {}, { data: pdf('certificate'), name: 'coi.pdf' });
  assert.equal(up.status, 302);
  const opened = await srv.get(`/dashboard/documents/${ins.id}/file`);
  assert.equal(opened.status, 200);
  assert.equal(Buffer.from(await opened.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('FF-2640-022: Warranty attaches the warranty certificate, a product photo uploads from the email box with its description, and send still needs a confirm', async () => {
  const warranty = db.addDocument({ category: 'warranty', title: 'Warranty certificate', filename: 'warranty.pdf', mime_type: 'application/pdf', data: pdf('warranty') });
  const c = db.createCustomer({ name: 'Email Shelf Person', phone: '+18045550866', email: 'shelf.person@example.com' });

  const compose = await (await srv.get(`/dashboard/customers/${c.id}/email`)).text();
  assert.match(compose, new RegExp(`data-canned="warranty"[^>]*data-attach-doc="${warranty.id}"[^>]*>Warranty<`));
  assert.match(compose, new RegExp(`name="doc_ids" value="${warranty.id}"`));
  assert.match(compose, /data-photo-upload>Upload and tick</);

  // The email box uploads a product photo as JSON so the typed draft stays.
  const photoRes = await postMultipart('/dashboard/documents?json=1', { category: 'product_photo', title: 'walnut drawer', description: 'Walnut drawer with soft-close slides' }, { data: Buffer.from('89504e470d0a1a0a', 'hex'), name: 'walnut.png', type: 'image/png' });
  const photo = (await photoRes.json()).document;
  assert.equal(photo.description, 'Walnut drawer with soft-close slides');

  const form = { to: c.email, subject: 'Your warranty', body: 'Hi, here is your warranty.', doc_ids: [warranty.id, photo.id] };
  const first = await srv.post(`/dashboard/customers/${c.id}/email/send`, form);
  const review = await first.text();
  assert.match(review, /Send this email\?/);
  assert.match(review, /Walnut drawer with soft-close slides/, 'the description goes with the photo');
  assert.equal(db.listMessagesForCustomer(c.id).length, 0, 'nothing sent before the confirm');
  const hash = review.match(/name="reviewed" value="([0-9a-f]{64})"/)[1];
  await srv.post(`/dashboard/customers/${c.id}/email/send`, { ...form, confirmed: '1', reviewed: hash });
  const [m] = db.listMessagesForCustomer(c.id);
  assert.ok(m, 'recorded after the confirm');
  // The real certificate on the shelf already holds the plain name, so this test copy may be "(2)".
  assert.match(m.body, /\[Attachments: [^\]]*warranty-certificate-\d{4}( \(\d+\))?\.pdf/);
  assert.match(m.body, /\[Attachments: [^\]]*walnut-drawer-\d{4}\.png/);
  assert.match(m.body, /Walnut drawer with soft-close slides/);
});

test('FF-2640-022: Foreman can tick a shelf document in the email box, and Andrew still confirms before send', async () => {
  const doc = db.addDocument({ category: 'license', title: 'Business license', filename: 'license.pdf', mime_type: 'application/pdf', data: pdf('license') });
  const c = db.createCustomer({ name: 'Foreman Shelf Person', phone: '+18045550867', email: 'foreman.shelf@example.com' });
  const list = await assistant.runTool('list_documents', {}, {});
  assert.ok(list.documents.some((d) => d.doc_id === doc.id));
  const out = await assistant.runTool('fill_email_compose', { customer_id: c.id, subject: 'License', body: 'Attached.', doc_ids: [doc.id] }, {});
  assert.deepEqual(out.filled.doc_ids, [doc.id]);
  const page = await (await srv.get(out.__navigate)).text();
  assert.match(page, new RegExp(`name="doc_ids" value="${doc.id}"[^>]* checked`));
  assert.equal(db.listMessagesForCustomer(c.id).length, 0, 'Foreman sends nothing');
});

test('FF-2640-022: the warranty certificate Andrew gave is on the Documents shelf byte for byte, and Documents opens it', async () => {
  const pdfPath = path.join(__dirname, '..', 'assets', 'documents', 'Shelves-to-Drawers-RVA-Warranty.pdf');
  const original = fs.readFileSync(pdfPath);
  assert.equal(original.subarray(0, 5).toString(), '%PDF-');
  const seeded = db.listDocuments({ category: 'warranty' }).find((d) => d.created_by === 'seed');
  assert.ok(seeded && seeded.has_file, 'BOS put the warranty certificate on the shelf on its first start');
  assert.equal(seeded.title, 'Warranty certificate');
  assert.ok(fs.readFileSync(db.documentPath(seeded)).equals(original), 'the shelf copy is the same file, not a new certificate');
  const res = await srv.get(`/dashboard/documents/${seeded.id}/file`);
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(original), 'Documents opens that file');
  assert.equal(db.listDocuments({ category: 'warranty' }).filter((d) => d.created_by === 'seed').length, 1, 'placed once');
});

// ================================================================ FF-2640-023
test('FF-2640-023: the vault holds the Clerk\'s Information System row for Andrew only, and the password is not in GitHub', async () => {
  const me = db.ensureUser(db.defaultUsername());
  const rows = db.listVaultLogins(me);
  const cis = rows.find((r) => r.site_name === "Clerk's Information System");
  assert.ok(cis);
  assert.equal(cis.url, 'https://cis.scc.virginia.gov/');
  assert.equal(cis.username, 'andrewkerwin');
  assert.equal(cis.email, 'andrew2481@aol.com');
  assert.equal(cis.password, null, 'the password is blank');
  assert.equal(db.listVaultLogins(me).filter((r) => r.site_name === cis.site_name).length, 1, 'seeded once');

  const page = await (await srv.get('/dashboard/vault')).text();
  assert.match(page, /Clerk&#39;s Information System|Clerk's Information System/);
  assert.match(page, /type="password" name="password"/, 'passwords are hidden until Show');

  const other = db.ensureUser('someone-else');
  assert.equal(db.listVaultLogins(other).length, 0, 'another login sees no vault rows');
  assert.equal(db.getVaultLogin(other, cis.id), null);
  assert.ok(!assistant.TOOLS.some((t) => /vault/i.test(t.name)), 'Foreman has no vault tool');
  const hits = db.searchEverything('andrewkerwin', me);
  assert.ok(!JSON.stringify(hits).includes(cis.id), 'the vault is not in search');

  // Nothing in the code that goes to GitHub holds the note. The note lives only
  // in data/vault-seed.local.json on the laptop (git ignores it), so this test
  // reads it from there instead of spelling it out here.
  let localNotes = [];
  try {
    localNotes = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'vault-seed.local.json'), 'utf8'))).map((v) => v.note).filter(Boolean);
  } catch {}
  for (const f of ['src/db.js', 'src/routes/dashboard.js', 'tests/update-2640-085.test.js', 'CHANGELOG.md', 'docs/tickets.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const note of localNotes) assert.ok(!text.includes(note), `${f} does not hold the vault note`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /data\/vault-seed\*\.json/);
});
