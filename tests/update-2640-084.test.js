// BF-2640-083 day boundary, BF-2640-084, FF-2640-015, FF-2640-016, FF-2640-017,
// FF-2640-018, FF-2640-019, and FF-2640-020. Throwaway DB (tests/helpers.js)
// and a real server on a random port (tests/http-helper.js) with every messaging
// and AI credential blanked. This process blanks the same credentials before
// anything is required, so nothing here can send a real text or email.
for (const k of ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ANTHROPIC_API_KEY']) process.env[k] = '';
process.env.OWNER_NOTIFY_EMAIL = 'andrew.invite@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');
const assistant = require('../src/services/assistant');
const automations = require('../src/services/automations');
const signature = require('../src/services/signature');
const pub = require('../src/routes/public');
const { bosDayString, nextDateString } = require('../src/util');

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

// A customer file with real bytes on disk.
function makeFile(c, name, { mime = 'application/pdf', bytes } = {}) {
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  madeDirs.add(dir);
  const content = bytes || Buffer.from(`%PDF-1.4 ${name} ` + 'x'.repeat(100));
  const stored = `t084-${Math.random().toString(36).slice(2)}${path.extname(name)}`;
  fs.writeFileSync(path.join(dir, stored), content);
  return db.getCustomerFile(db.createCustomerFile({ customer_id: c.id, stored_name: stored, original_name: name, mime_type: mime, size: content.length }));
}
// A 1x1 PNG, enough for the viewer and the Sign page.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const sheetOf = (html) => html.slice(html.indexOf('id="menu-sheet"'), html.indexOf('</script>', html.indexOf('id="menu-sheet"')));

// ================================================================ BF-2640-083 day boundary
test('BF-2640-083: a routine check at 1:00 AM Eastern is stored on the previous date, and 5:00 AM starts the new date unchecked', () => {
  const meds = db.listRoutine('morning', '2026-03-10').find((r) => r.title === 'Take meds');
  const evening = db.listRoutine('evening', '2026-03-10')[0];
  // 2026-10-02 05:00Z is 1:00 AM EDT on Friday October 2.
  assert.equal(bosDayString(new Date('2026-10-02T05:00:00Z')), '2026-10-01');
  assert.equal(bosDayString(new Date('2026-10-02T08:59:00Z')), '2026-10-01', '4:59 AM is still the day that just ended');
  assert.equal(bosDayString(new Date('2026-10-02T09:00:00Z')), '2026-10-02', '5:00 AM starts the new date');

  db.setRoutineCheck(evening.id, null, true, 'test', { at: new Date('2026-10-02T05:00:00Z') });
  const stored = db.db.prepare(`SELECT date FROM routine_checks WHERE routine_item_id = ?`).all(evening.id).map((r) => r.date);
  assert.deepEqual(stored, ['2026-10-01'], 'the 1:00 AM evening check is on the previous date');

  db.setRoutineCheck(meds.id, '2026-10-01', true, 'test');
  assert.equal(db.listRoutine('morning', '2026-10-01').find((r) => r.id === meds.id).checked, true, 'the morning check stays on that date');
  assert.equal(db.listRoutine('morning', '2026-10-02').find((r) => r.id === meds.id).checked, false, 'the new date starts unchecked');
  assert.equal(db.listRoutine('evening', '2026-10-02').find((r) => r.id === evening.id).checked, false);
});

test('BF-2640-083: Today shows the BOS day, and a visit at 2:00 AM Eastern belongs to the day before', () => {
  const c = db.createCustomer({ name: 'Late Night Visit', phone: '+18045550841' });
  db.createAppointment({ customer_id: c.id, type: 'Consultation', scheduled_at: '2026-11-11T07:00:00.000Z' }); // 2:00 AM EST Nov 11
  assert.ok(db.visitsOnDay('2026-11-10').some((a) => a.customer_id === c.id));
  assert.ok(!db.visitsOnDay('2026-11-11').some((a) => a.customer_id === c.id));
});

// ================================================================ BF-2640-084
test('BF-2640-084: the contract signature target is the signature box, and the drawing signature target is near the edge of the page', () => {
  const page = { width: 1000, height: 1400 };
  const box = { x: 120, y: 1180, w: 300, h: 70 };
  const contract = signature.signaturePlacement('contract', page, box);
  assert.equal(contract.target, 'signature_box');
  assert.deepEqual([contract.x, contract.y, contract.w, contract.h], [120, 1180, 300, 70], 'the signature fills the box Andrew marked, nowhere else');
  assert.ok(signature.signaturePlacement('contract', page, null).error, 'no box marked, no placement');

  const drawing = signature.signaturePlacement('drawing', page);
  assert.equal(drawing.target, 'page_edge');
  const margin = Math.min(page.width, page.height) * 0.05;
  assert.ok(page.width - (drawing.x + drawing.w) <= margin, 'near the right edge');
  assert.ok(page.height - (drawing.y + drawing.h) <= margin, 'near the bottom edge');
  assert.ok(drawing.x >= 0 && drawing.y >= 0, 'still on the page');
  assert.equal(signature.SIGNATURE_TARGETS.contract.label, 'in the signature box');
  assert.equal(signature.SIGNATURE_TARGETS.drawing.label, 'near the edge of the page');
});

test('BF-2640-084: the file Andrew is viewing has Delete and Sign, and Sign saves only at the locked spot', async () => {
  const c = db.createCustomer({ name: 'Sign Viewer Person', phone: '+18045550842' });
  const img = makeFile(c, 'kitchen drawing.png', { mime: 'image/png', bytes: PNG });
  const pdf = makeFile(c, 'contract.pdf');

  const view = await (await srv.get(`/dashboard/customers/${c.id}/files/${img.id}/view`)).text();
  assert.match(view, new RegExp(`action="/dashboard/customers/${c.id}/files/${img.id}/delete"><button[^>]*data-file-delete`));
  assert.match(view, new RegExp(`href="/dashboard/customers/${c.id}/files/${img.id}/sign" data-file-sign>Sign<`));
  const pdfView = await (await srv.get(`/dashboard/customers/${c.id}/files/${pdf.id}/view`)).text();
  assert.match(pdfView, /data-file-delete/, 'Delete is on a PDF too');

  const customerPage = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.match(customerPage, new RegExp(`/files/${img.id}/sign">Sign</a>`), 'Sign stays on the customer files list');
  assert.match(customerPage, new RegExp(`/files/${img.id}/delete"><button[^>]*>Delete</button>`), 'Delete stays on the customer files list');

  const signPage = await (await srv.get(`/dashboard/customers/${c.id}/files/${img.id}/sign`)).text();
  assert.match(signPage, /data-sign-target="page_edge"/, 'a drawing starts with the near-the-edge target');
  assert.match(signPage, /value="contract"[^>]*> Sales contract: the signature goes in the signature box/);
  const contractSign = await (await srv.get(`/dashboard/customers/${c.id}/files/${img.id}/sign?kind=contract`)).text();
  assert.match(contractSign, /data-sign-target="signature_box"/);

  const dataUrl = 'data:image/png;base64,' + PNG.toString('base64');
  const post = (body) => fetch(srv.base + `/dashboard/customers/${c.id}/files/${img.id}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const page = { width: 800, height: 600 };
  const wrong = await post({ data_url: dataUrl, kind: 'drawing', page, placement: { target: 'signature_box', x: 1, y: 1, w: 10, h: 10 } });
  assert.equal(wrong.status, 400, 'a drawing signature anywhere but near the edge is refused');
  const noBox = await post({ data_url: dataUrl, kind: 'contract', page, placement: null });
  assert.equal(noBox.status, 400, 'a contract signature needs the signature box');
  const ok = await post({ data_url: dataUrl, kind: 'drawing', page, placement: signature.signaturePlacement('drawing', page) });
  const out = await ok.json();
  assert.equal(out.ok, true);
  assert.match(db.getCustomerFile(out.file_id).note, /near the edge of the page/);
  assert.ok(db.getCustomerFile(img.id), 'the original is kept');
});

test('BF-2640-084: a soft-deleted file can be restored from Deleted Files', async () => {
  const c = db.createCustomer({ name: 'Restore File Person', phone: '+18045550843' });
  const f = makeFile(c, 'measure.pdf');
  const del = await srv.post(`/dashboard/customers/${c.id}/files/${f.id}/delete`);
  assert.equal(del.status, 302);
  assert.ok(db.getCustomerFile(f.id).deleted_at, 'soft-deleted');
  assert.ok(fs.existsSync(db.fileBytesPath(db.getCustomerFile(f.id))), 'the bytes stay on disk');
  const deletedPage = await (await srv.get('/dashboard/files/deleted')).text();
  assert.match(deletedPage, new RegExp(`/dashboard/files/${f.id}/restore`));
  await srv.post(`/dashboard/files/${f.id}/restore`);
  assert.equal(db.getCustomerFile(f.id).deleted_at, null, 'restored');
  assert.ok(db.listCustomerFiles(c.id).some((x) => x.id === f.id));
});

// ================================================================ FF-2640-015 / FF-2640-016 / FF-2640-020 Menu
test('FF-2640-015 FF-2640-016 FF-2640-020: Menu contains Contacts and Tomorrow, plus Today and Lists, and never says Desk', async () => {
  const sheet = sheetOf(await (await srv.get('/dashboard')).text());
  assert.match(sheet, /<a href="\/dashboard\/contacts">Contacts<\/a>/);
  assert.match(sheet, /<a href="\/dashboard\/tomorrow">Tomorrow<\/a>/);
  assert.match(sheet, /<a href="\/dashboard\/today">Today<\/a>/);
  assert.match(sheet, /<a href="\/dashboard\/lists">Lists<\/a>/);
  assert.ok(!/>Desk</.test(sheet));
  assert.ok(sheet.includes(`BOS ${require('../package.json').version}`), 'the Menu reads the version in package.json');
});

// ================================================================ FF-2640-015
// BF-2640-085 replaced the separate Tomorrow list with the day page for tomorrow.
test('FF-2640-015: Today has a Tomorrow button that opens the day page for tomorrow with the visits BOS already stored', async () => {
  const tomorrow = nextDateString(bosDayString());
  const today = await (await srv.get('/dashboard/today')).text();
  assert.match(today, new RegExp(`href="/dashboard/today\\?date=${tomorrow}" data-tomorrow>Tomorrow<`));
  const c = db.createCustomer({ name: 'Tomorrow Visit Person', phone: '+18045550844' });
  db.createAppointment({ customer_id: c.id, type: 'Consultation', scheduled_at: `${tomorrow}T15:00:00.000Z` });
  const other = db.createCustomer({ name: 'Today Only Person', phone: '+18045550845' });
  db.createAppointment({ customer_id: other.id, type: 'Consultation', scheduled_at: `${bosDayString()}T15:00:00.000Z` });
  const html = await (await srv.get(`/dashboard/today?date=${tomorrow}`)).text();
  const panel = html.slice(html.indexOf('id="today-visits"'), html.indexOf('id="today-items"'));
  assert.match(panel, /Tomorrow Visit Person/);
  assert.ok(!/Today Only Person/.test(panel));
});

// ================================================================ FF-2640-016
test('FF-2640-016: Contacts says Contacts, a contact needs no name, marks filter the page, and old Desk links still work', async () => {
  const me = db.ensureUser(db.defaultUsername());
  const phoneOnly = db.createRecord(me, { phone: '+18045550846', is_vendor: true });
  assert.equal(phoneOnly.name, '');
  assert.equal(phoneOnly.label, '+18045550846');
  db.createRecord(me, { name: 'Mark Both Person', is_lead: true, is_personal: true });
  db.createRecord(me, { name: 'Mark Lead Only', is_lead: true });
  assert.throws(() => db.createRecord(me, {}), /needs at least/);

  const list = async (qs) => (await srv.get('/dashboard/contacts' + qs)).text();
  let html = await list('');
  assert.match(html, /<h1>Contacts<\/h1>/);
  assert.ok(!/<h1>Desk<\/h1>/.test(html));
  html = await list('?f=lead');
  assert.ok(/Mark Both Person/.test(html) && /Mark Lead Only/.test(html) && !/\+18045550846|804\) 555-0846/.test(html));
  html = await list('?f=personal');
  assert.ok(/Mark Both Person/.test(html) && !/Mark Lead Only/.test(html), 'more than one mark is allowed');
  html = await list('?f=vendor');
  assert.match(html, new RegExp(`/dashboard/contacts/${phoneOnly.id}`));

  const old = await srv.get(`/dashboard/desk/${phoneOnly.id}`);
  assert.equal(old.status, 302);
  assert.equal(old.headers.get('location'), `/dashboard/contacts/${phoneOnly.id}`);

  const createTool = assistant.TOOLS.find((t) => t.name === 'create_record');
  assert.ok(createTool.input_schema.properties.is_vendor && createTool.input_schema.properties.is_lead);
  assert.match(createTool.description, /contact/);
  assert.ok(!/Desk/.test(createTool.description));
  assert.match(assistant.systemPrompt({}), /Say Contacts/);
});

// ================================================================ FF-2640-017
test('FF-2640-017: a same-name second file does not keep the exact same visible name, and both files stay', async () => {
  const c = db.createCustomer({ name: 'Clash File Person', phone: '+18045550847' });
  const first = makeFile(c, 'plan.pdf');
  const second = makeFile(c, 'plan.pdf');
  assert.equal(first.original_name, 'plan.pdf');
  assert.notEqual(second.original_name, 'plan.pdf');
  assert.equal(second.original_name, 'plan (2).pdf');
  assert.equal(second.name_clash_of, 'plan.pdf', 'the clash is flagged');
  assert.equal(db.listCustomerFiles(c.id).length, 2);
  const page = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.match(page, /data-name-clash/);
});

test('FF-2640-017: BOS renames, copies, moves, and soft-deletes a file without overwriting one', async () => {
  const c = db.createCustomer({ name: 'Tools File Person', phone: '+18045550848' });
  const other = db.createCustomer({ name: 'Tools Other Person', phone: '+18045550849' });
  const a = makeFile(c, 'a.pdf');
  makeFile(c, 'b.pdf');
  await srv.post(`/dashboard/customers/${c.id}/files/${a.id}/rename`, { name: 'b.pdf' });
  assert.equal(db.getCustomerFile(a.id).original_name, 'b (2).pdf', 'a rename onto a taken name is changed slightly');

  const copyRes = await srv.post(`/dashboard/customers/${c.id}/files/${a.id}/copy`);
  assert.equal(copyRes.status, 302);
  // FF-2640-021: a copy is a new file, so it gets a readable name.
  const copies = db.listCustomerFiles(c.id).filter((f) => f.note === 'Copy of "b (2).pdf"');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].original_name, `b-2-${db.yearWeekTag()}.pdf`);
  assert.notEqual(copies[0].original_name, db.getCustomerFile(a.id).original_name);
  assert.ok(fs.existsSync(db.fileBytesPath(copies[0])), 'the copy has its own bytes on disk');

  await srv.post(`/dashboard/customers/${c.id}/files/${a.id}/move`, { customer_id: other.id });
  assert.equal(db.getCustomerFile(a.id).customer_id, other.id);
  assert.ok(fs.existsSync(db.fileBytesPath(db.getCustomerFile(a.id))), 'the bytes moved with the file');
});

test('FF-2640-017: Foreman renames, copies, and soft-deletes a file only after Andrew says yes', async () => {
  const c = db.createCustomer({ name: 'Foreman File Person', phone: '+18045550850' });
  const f = makeFile(c, 'quote.pdf');
  for (const name of ['rename_file', 'copy_file', 'delete_file', 'move_file_to_customer']) assert.ok(assistant.TOOLS.some((t) => t.name === name), name);

  const noRename = await assistant.runTool('rename_file', { file_id: f.id, new_name: 'final quote.pdf' }, {});
  assert.ok(noRename.error && noRename.readback);
  assert.equal(db.getCustomerFile(f.id).original_name, 'quote.pdf');
  const renamed = await assistant.runTool('rename_file', { file_id: f.id, new_name: 'final quote.pdf', confirmed: true }, {});
  assert.equal(renamed.name, 'final quote.pdf');

  const noCopy = await assistant.runTool('copy_file', { file_id: f.id }, {});
  assert.ok(noCopy.error);
  assert.equal(db.listCustomerFiles(c.id).length, 1);
  const copy = await assistant.runTool('copy_file', { file_id: f.id, confirmed: true }, {});
  assert.equal(copy.ok, true);
  assert.equal(copy.name, `final-quote-${db.yearWeekTag()}.pdf`, 'a copy is a new file with a readable name');
  assert.notEqual(copy.name, 'final quote.pdf');

  const noDelete = await assistant.runTool('delete_file', { file_id: f.id }, {});
  assert.ok(noDelete.error);
  assert.equal(db.getCustomerFile(f.id).deleted_at, null);
  await assistant.runTool('delete_file', { file_id: f.id, confirmed: true }, {});
  assert.ok(db.getCustomerFile(f.id).deleted_at, 'soft-deleted');
  assert.ok(db.listDeletedFiles().some((x) => x.id === f.id), 'restorable from Deleted Files');
});

// ================================================================ FF-2640-018
function weekdaySlot(daysOut) {
  const d = new Date();
  d.setDate(d.getDate() + daysOut);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

test('FF-2640-018: a booking source writes an attribution when a source is chosen', async () => {
  const src = db.createSource({ name: 'Yard Sign 018' });
  const r = await pub.createBooking({
    name: 'Heard Source Person',
    phone: '+18045550851',
    email: 'heard.source@example.com',
    address: '1 Main St, Richmond, VA 23220',
    slotIso: weekdaySlot(30),
    type: 'Short Design Consultation',
    sourceId: src.id,
    actor: 'public',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const attr = db.getCustomerAttribution(r.customer.id);
  assert.ok(attr.original, 'an attribution was written');
  assert.equal(attr.original.source_id, src.id, 'the chosen source is the first attribution');

  const none = await pub.createBooking({
    name: 'No Source Person',
    phone: '+18045550852',
    email: 'no.source@example.com',
    address: '2 Main St, Richmond, VA 23220',
    slotIso: weekdaySlot(32),
    type: 'Short Design Consultation',
    actor: 'public',
  });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.equal(db.getCustomerAttribution(none.customer.id).original, null, 'no choice writes nothing');
});

test('FF-2640-018: the book form asks how they heard, using the marketing sources BOS already has', async () => {
  db.createSource({ name: 'Neighbor Referral 018' });
  const qs = new URLSearchParams({ type: 'Short Design Consultation', name: 'Form Person', phone: '804-555-0853', email: 'form.person@example.com', address: '3 Main St, Richmond, VA 23220', slot: weekdaySlot(34) });
  const html = await (await srv.get(`/book/review?${qs}`)).text();
  assert.match(html, /How did you hear about us\?/);
  assert.match(html, /<select id="heard-source" name="heard_source_id">/);
  assert.match(html, />Neighbor Referral 018</);
});

// ================================================================ FF-2640-019
test('FF-2640-019: after BOS writes a scheduled visit, an invite email with a .ics file goes to the customer and to Andrew', async () => {
  const c = db.createCustomer({ name: 'Invite Person', phone: '+18045550854', email: 'invite.person@example.com', address: '9 Elm St, Richmond, VA 23220' });
  const appt = db.createAppointment({ customer_id: c.id, type: 'Consultation', scheduled_at: '2026-12-01T15:00:00.000Z', duration_min: 90 });
  const ics = automations.buildVisitIcs(appt, c);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261201T150000Z/);
  assert.match(ics, /DTEND:20261201T163000Z/);
  assert.match(ics, /LOCATION:9 Elm St\\, Richmond\\, VA 23220/);
  assert.match(ics, /END:VCALENDAR\r\n$/);

  await automations.sendCalendarInvites(appt, c);
  const msgs = db.listAllMessages({ limit: 1000 }).filter((m) => /^Calendar invite:/.test(m.subject || ''));
  const toCustomer = msgs.find((m) => m.to_address === 'invite.person@example.com');
  const toAndrew = msgs.find((m) => m.to_address === 'andrew.invite@example.com');
  assert.ok(toCustomer && toAndrew, 'one invite email to the customer and one to Andrew');
  for (const m of [toCustomer, toAndrew]) {
    assert.equal(m.channel, 'email');
    assert.match(m.subject, /^Calendar invite:/);
    assert.match(m.body, /\[Attachments: visit\.ics\]/);
  }

  // The dashboard path that writes a scheduled visit sends the invites too.
  const d = db.createCustomer({ name: 'Dashboard Invite Person', phone: '+18045550855', email: 'dash.invite@example.com' });
  await srv.post('/dashboard/appointments', { customer_id: d.id, type: 'Consultation', scheduled_at: '2026-12-02T15:00:00.000Z' });
  assert.ok(db.listMessagesForCustomer(d.id).some((m) => /^Calendar invite:/.test(m.subject || '') && /visit\.ics/.test(m.body)));
});

// ================================================================ FF-2640-020
test('FF-2640-020: Andrew adds a row to the grocery list, the project list, and the vehicle list, and a vehicle is not a contact', async () => {
  const html = await (await srv.get('/dashboard/lists')).text();
  for (const k of ['grocery', 'project', 'vehicle']) assert.match(html, new RegExp(`id="list-${k}"`));
  assert.match(html, /Budget stays in <a href="\/dashboard\/finances">Bookkeeping<\/a>/);
  await srv.post('/dashboard/lists/grocery', { title: 'Milk' });
  await srv.post('/dashboard/lists/project', { title: 'Garage shelves' });
  await srv.post('/dashboard/lists/vehicle', { title: 'Work van', notes: 'Oil change due' });
  assert.deepEqual(db.listListRows('grocery').map((r) => r.title), ['Milk']);
  assert.deepEqual(db.listListRows('project').map((r) => r.title), ['Garage shelves']);
  assert.deepEqual(db.listListRows('vehicle').map((r) => r.title), ['Work van']);
  const after = await (await srv.get('/dashboard/lists')).text();
  assert.match(after, /Work van/);
  const contacts = await (await srv.get('/dashboard/contacts')).text();
  assert.ok(!/Work van/.test(contacts), 'a vehicle is not a contact');
  const bad = await srv.post('/dashboard/lists/budget', { title: 'x' });
  assert.match(bad.headers.get('location'), /err=/, 'there is no budget list');
});
