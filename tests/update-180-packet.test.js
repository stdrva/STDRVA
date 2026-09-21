// BOS 1.8.0 - 034 Sale packet (+ the Measure appointment type it introduces).
//
// Real server, real HTTP, real SMTP conversation: the email tests point the server
// at a tiny fake SMTP server on localhost (SMTP_HOST/SMTP_PORT), so attachments and
// the confirm gate are exercised end to end without ever touching Gmail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');
const util = require('../src/util');

const UPLOADS = path.join(path.dirname(tmpDbPath), 'uploads');
const cleanup = [];
test.after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- helpers ----------
function makePng(w = 60, h = 40) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = (x * 7) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = ((x + y) * 3) & 255; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pngDataUrl = () => 'data:image/png;base64,' + makePng().toString('base64');

// A customer with a lead (estimate value), an email, a phone, and real files on disk.
function makeCustomer(name, { email = `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, files = 2, leadStage = 'Quoted' } = {}) {
  const c = db.createCustomer({ name, email, phone: '+18045550100' });
  const lead = db.createLead({ customer_id: c.id, stage: leadStage, estimate_value: 7365 });
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  const made = [];
  for (let i = 1; i <= files; i++) {
    const stored = `stored-${i}.pdf`;
    const content = Buffer.from(`PDFDATA-${name}-${i}-` + 'x'.repeat(200));
    fs.writeFileSync(path.join(dir, stored), content);
    const id = db.createCustomerFile({ customer_id: c.id, stored_name: stored, original_name: `doc-${i}.pdf`, mime_type: 'application/pdf', size: content.length });
    made.push({ id, content, name: `doc-${i}.pdf` });
  }
  return { c, lead, files: made };
}
const messageCount = (id) => db.listMessagesForCustomer(id).length;
const openFollowups = (id, title) => db.listFollowups(id).filter((f) => f.title === title);

function startFakeSmtp({ rejectRcpt = false } = {}) {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '', inData = false, from = '', rcpt = [];
    sock.write('220 fake.local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) break;
          messages.push({ from, to: rcpt, data: buf.slice(0, end) });
          buf = buf.slice(end + 5); inData = false;
          sock.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-fake.local\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (up.startsWith('AUTH')) sock.write('235 2.7.0 ok\r\n');
        else if (up.startsWith('MAIL FROM')) { from = line; rcpt = []; sock.write('250 ok\r\n'); }
        else if (up.startsWith('RCPT TO')) { if (rejectRcpt) sock.write('550 5.1.1 no such user\r\n'); else { rcpt.push(line); sock.write('250 ok\r\n'); } }
        else if (up === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else if (up === 'RSET' || up === 'NOOP') sock.write('250 ok\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, close: () => new Promise((r) => server.close(r)) })));
}

let app; // no email credentials: "not configured"
test.before(async () => {
  app = await startServer();
});
test.after(async () => {
  if (app) await app.stop();
});

// ---------------------------------------------------------------- completion logic
test('034: completeSalePacket -> Sold, job at Measuring Scheduled, "Schedule measure" follow-up, and sends NOTHING', () => {
  const { c, lead } = makeCustomer('Packet Complete Person');
  const before = messageCount(c.id);
  const r = db.completeSalePacket(c.id, { actor: 'user:test', via: 'signed on device' });

  assert.equal(r.stage_changed, true);
  assert.equal(db.getCustomer(c.id).sales_stage, 'Sold');
  assert.equal(db.getLead(lead.id).stage, 'Sold', 'the legacy lead follows');
  assert.equal(r.job_created, true);
  assert.equal(r.job.status, 'Measuring Scheduled');
  assert.equal(r.job.sold_amount, 7365, 'job takes the lead estimate as its sold amount');
  assert.equal(r.job.lead_id, lead.id);
  assert.deepEqual(db.getJobHistory(r.job.id).map((h) => h.status), ['Order Confirmed', 'Measuring Scheduled']);
  assert.equal(r.job.estimated_install_at, null);

  const f = openFollowups(c.id, 'Schedule measure');
  assert.equal(f.length, 1);
  assert.equal(r.followup_created, true);
  assert.equal(f[0].due_at, `${util.etDateString()}T12:00:00.000Z`, 'due today (Eastern)');
  assert.equal(f[0].status, 'open');

  assert.equal(messageCount(c.id), before, 'no text/email was logged or sent by completing');
  const audit = db.listActivityForCustomer(c.id).map((a) => a.field);
  assert.ok(audit.includes('sale_packet_completed') && audit.includes('sales_stage'));
});

test('034: completing twice changes nothing the second time (one job, one follow-up, no repeat history)', () => {
  const { c } = makeCustomer('Packet Twice Person');
  const a = db.completeSalePacket(c.id, { actor: 't', via: 'emailed' });
  const b = db.completeSalePacket(c.id, { actor: 't', via: 'emailed' });
  assert.deepEqual([b.stage_changed, b.job_created, b.job_status_changed, b.followup_created], [false, false, false, false]);
  assert.equal(b.job.id, a.job.id);
  assert.equal(db.listJobs().filter((j) => j.customer_id === c.id).length, 1);
  assert.equal(db.getJobHistory(a.job.id).length, 2);
  assert.equal(openFollowups(c.id, 'Schedule measure').length, 1);
});

test('034: an existing job is reused and advanced; a job further along is never moved backward; a finished job gets a new one', () => {
  // Order Confirmed -> Measuring Scheduled, same job
  const one = makeCustomer('Packet Existing Job');
  const j1 = db.createJob({ customer_id: one.c.id, sold_amount: 100 });
  const r1 = db.completeSalePacket(one.c.id, { actor: 't' });
  assert.equal(r1.job.id, j1.id);
  assert.equal(r1.job_created, false);
  assert.equal(r1.job.status, 'Measuring Scheduled');

  // Measured stays Measured
  const two = makeCustomer('Packet Advanced Job');
  const j2 = db.createJob({ customer_id: two.c.id });
  db.updateJobStatus(j2.id, 'Measured', null);
  const r2 = db.completeSalePacket(two.c.id, { actor: 't' });
  assert.equal(r2.job_status_changed, false);
  assert.equal(db.getJob(j2.id).status, 'Measured', 'never regresses');

  // Complete -> a fresh job for the new sale
  const three = makeCustomer('Packet Repeat Buyer');
  const j3 = db.createJob({ customer_id: three.c.id });
  db.updateJobStatus(j3.id, 'Complete', null);
  const r3 = db.completeSalePacket(three.c.id, { actor: 't' });
  assert.equal(r3.job_created, true);
  assert.notEqual(r3.job.id, j3.id);
  assert.equal(db.getJob(j3.id).status, 'Complete', 'the finished job is untouched');
});

test('034: completeSalePacket rejects an unknown customer without touching anything', () => {
  assert.throws(() => db.completeSalePacket('no-such-customer', {}), /Customer not found/);
});

// ---------------------------------------------------------------- Measure type
test('034: Measure is an appointment type but internal-only: hidden on /book, even by URL', async () => {
  assert.ok(db.APPT_TYPES.includes('Measure'));
  assert.ok(db.INTERNAL_APPT_TYPES.includes('Measure') && db.INTERNAL_APPT_TYPES.includes('Install'));

  for (const url of ['/book', '/book?type=Measure', '/book?type=Install']) {
    const html = await (await app.get(url)).text();
    assert.ok(!/type-name">Measure</.test(html), `${url}: no Measure card`);
    assert.ok(!/type-name">Install</.test(html), `${url}: no Install card`);
    assert.match(html, /type-card featured selected"[^>]*>\s*<span class="type-name">Short Design Consultation/, `${url}: falls back to the first public type`);
  }
  assert.match(await (await app.get('/book')).text(), /type-name">Short Design Consultation/);
  // the dashboard (Andrew) can still schedule one
  const dash = await (await app.get('/dashboard/appointments')).text();
  assert.match(dash, /<option value="Measure">Measure<\/option>/);
});

test('034: a Measure appointment is never a design appointment - no stage bump, no KPI change, no consultant credit', async () => {
  const c = db.createCustomer({ name: 'Measure Not Design' });
  assert.equal(db.getCustomer(c.id).sales_stage, 'Bona Fide Lead');
  const kpiBefore = JSON.stringify(db.kpiFunnel());

  const when = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16);
  const r = await app.post('/dashboard/appointments', { customer_id: c.id, type: 'Measure', scheduled_at: when, duration_min: '60' });
  assert.equal(r.status, 302);
  const appt = db.listAppointmentsForCustomer(c.id).find((a) => a.type === 'Measure');
  assert.ok(appt, 'the Measure appointment was created');
  assert.equal(db.getCustomer(c.id).sales_stage, 'Bona Fide Lead', 'creating it does not move the sales stage');

  db.updateAppointmentStatus(appt.id, 'completed');
  assert.equal(db.getCustomer(c.id).sales_stage, 'Bona Fide Lead', 'completing it does not either');
  assert.equal(JSON.stringify(db.kpiFunnel()), kpiBefore, 'KPI funnel is unchanged');

  // consultant scoreboard counts design bookings only
  const con = db.upsertConsultantByName('Measure Test Consultant');
  const c2 = db.createCustomer({ name: 'Consultant Measure Customer' });
  db.createAppointment({ customer_id: c2.id, type: 'Short Design Consultation', scheduled_at: new Date(Date.now() + 9 * 86400000).toISOString(), consultant_id: con.id });
  db.createAppointment({ customer_id: c2.id, type: 'Measure', scheduled_at: new Date(Date.now() + 12 * 86400000).toISOString(), consultant_id: con.id });
  const row = db.consultantScoreboard().find((x) => x.id === con.id || x.name === con.name);
  assert.equal(row.appointments_booked, 1, 'the Measure appointment is not counted');
});

// ---------------------------------------------------------------- sign on this device
const signBody = (over = {}) => JSON.stringify({ name: 'Pat Signer', data_url: pngDataUrl(), notify_customer: false, ...over });
const postJson = (server, p, obj) =>
  fetch(server.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });

test('034: sign on this device saves a NEW file (name + ET + file list), leaves originals alone, completes the sale, sends nothing', async () => {
  const { c, files } = makeCustomer('Sign Device Person');
  const before = messageCount(c.id);
  const beforeFiles = db.listCustomerFiles(c.id).length;

  const res = await postJson(app, `/dashboard/customers/${c.id}/sale-packet/sign`, {
    name: 'Sign Device Person',
    data_url: pngDataUrl(),
    file_ids: [files[0].id, files[1].id],
    notify_customer: false,
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.match(decodeURIComponent(out.redirect), /Customer marked Sold · job created · job status Measuring Scheduled · "Schedule measure" follow-up added · no message sent to the customer/);

  const all = db.listCustomerFiles(c.id);
  assert.equal(all.length, beforeFiles + 1, 'exactly one NEW file');
  const signed = all.find((f) => f.original_name.startsWith('sale-packet-signed-'));
  assert.equal(signed.original_name, `sale-packet-signed-sign-device-person-${util.etDateString()}.png`);
  assert.equal(signed.mime_type, 'image/png');
  assert.match(signed.note, /signed on this device by Sign Device Person, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}[\s ][AP]M ET/);
  const listed = signed.note.split('Files: ')[1].split(', ').sort();
  assert.deepEqual(listed, ['doc-1.pdf', 'doc-2.pdf'], 'the note lists the packet files');
  const onDisk = fs.readFileSync(path.join(UPLOADS, c.id, signed.stored_name));
  assert.equal(onDisk.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG is on disk');
  for (const f of files) assert.deepEqual(fs.readFileSync(path.join(UPLOADS, c.id, 'stored-' + f.name.match(/\d/)[0] + '.pdf')), f.content, 'original files untouched');

  const job = db.listJobs().find((j) => j.customer_id === c.id);
  assert.equal(signed.job_id, job.id, 'tagged to the job');
  assert.equal(job.status, 'Measuring Scheduled');
  assert.equal(db.getCustomer(c.id).sales_stage, 'Sold');
  assert.equal(openFollowups(c.id, 'Schedule measure').length, 1);
  assert.equal(messageCount(c.id), before, 'NO customer text/email (onJobCreated did not fire)');
  assert.ok(db.listActivityForCustomer(c.id).some((a) => a.field === 'sale_packet_signed'));
});

test('034: onJobCreated fires only when notify_customer is ticked', async () => {
  const { c, files } = makeCustomer('Sign Notify Person');
  const before = messageCount(c.id);
  const res = await postJson(app, `/dashboard/customers/${c.id}/sale-packet/sign`, { name: 'Sign Notify Person', data_url: pngDataUrl(), file_ids: [files[0].id], notify_customer: true });
  assert.equal((await res.json()).ok, true);
  const msgs = db.listMessagesForCustomer(c.id);
  assert.ok(msgs.length > before, 'ticking the box does send (or, with no keys, log) the order-confirmed message');
  assert.ok(msgs.some((m) => /order .*confirmed|Your order/i.test(m.body || m.subject || '')));
});

test('034: sign rejects a missing name, no files, someone else\'s / deleted files, and a bogus image - changing nothing', async () => {
  const { c, files } = makeCustomer('Sign Reject Person');
  const other = makeCustomer('Sign Reject Other');
  const url = `/dashboard/customers/${c.id}/sale-packet/sign`;
  const beforeFiles = db.listCustomerFiles(c.id).length;
  const bad = async (body, re) => {
    const res = await postJson(app, url, body);
    const out = await res.json();
    assert.equal(res.status, 400, JSON.stringify(out));
    assert.equal(out.ok, false);
    assert.match(out.error, re);
  };
  await bad({ name: '   ', data_url: pngDataUrl(), file_ids: [files[0].id] }, /printed name/);
  await bad({ name: 'X', data_url: pngDataUrl(), file_ids: [] }, /at least one file/);
  await bad({ name: 'X', data_url: pngDataUrl(), file_ids: [other.files[0].id] }, /at least one file/); // another customer's file
  db.softDeleteCustomerFile(files[1].id, 'test');
  await bad({ name: 'X', data_url: pngDataUrl(), file_ids: [files[1].id] }, /at least one file/); // deleted
  await bad({ name: 'X', data_url: 'data:image/png;base64,AAAA', file_ids: [files[0].id] }, /not valid/);
  await bad({ name: 'X', data_url: 'data:image/jpeg;base64,' + makePng().toString('base64'), file_ids: [files[0].id] }, /not valid/);
  await bad({ name: 'X', data_url: 'not a data url', file_ids: [files[0].id] }, /not valid/);
  assert.equal(db.listCustomerFiles(c.id).length, beforeFiles - 1 /* the one soft-deleted above */, 'nothing new saved');
  assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
  assert.equal(db.listJobs().filter((j) => j.customer_id === c.id).length, 0);
  assert.equal(openFollowups(c.id, 'Schedule measure').length, 0);
  assert.equal((await postJson(app, '/dashboard/customers/nope/sale-packet/sign', { name: 'X' })).status, 404);
});

// ---------------------------------------------------------------- the page
test('034: packet page = file checklist, "after it\'s complete" (notify OFF by default), email + sign sections, ET signing time', async () => {
  const { c } = makeCustomer('Packet Page Person');
  const html = await (await app.get(`/dashboard/customers/${c.id}/sale-packet`)).text();
  assert.equal((html.match(/<input type="checkbox" name="file_ids"/g) || []).length, 2, 'a checkbox per file');
  assert.match(html, /name="notify_customer" value="1" style="width:auto;margin-top:4px"> <span>Also text\/email the customer their "order confirmed" link/);
  assert.ok(!/<input type="checkbox" name="notify_customer"[^>]*checked/.test(html), 'unticked by default');
  assert.match(html, /No text or email goes to the customer<\/strong> unless you tick this/);
  assert.match(html, /3a\. Email the selected files/);
  assert.match(html, /3b\. Sign on this device/);
  assert.match(html, /timeZone: 'America\/New_York'/);
  assert.match(html, /not DocuSign/);
  assert.ok(!/DocuSign is/.test(html));
  // linked from the customer page
  assert.match(await (await app.get(`/dashboard/customers/${c.id}`)).text(), new RegExp(`href="/dashboard/customers/${c.id}/sale-packet">Sale packet<`));
  assert.equal((await app.get('/dashboard/customers/nope/sale-packet')).status, 404);
});

// ---------------------------------------------------------------- email selected
test('034: email step 1 is only a confirm screen - it sends nothing and changes nothing', async () => {
  const { c, files } = makeCustomer('Email Review Person');
  const before = messageCount(c.id);
  const res = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/review`, { file_ids: [files[0].id, files[1].id] });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Confirm email to Email Review Person/);
  assert.match(html, /Nothing has been sent yet/);
  assert.match(html, /email\.review\.person@example\.com/);
  assert.match(html, /doc-1\.pdf/); assert.match(html, /doc-2\.pdf/);
  assert.match(html, /<input type="hidden" name="confirmed" value="1">/);
  assert.match(html, /Send email and complete sale/);
  assert.ok(!/name="notify_customer"[^>]*checked/.test(html));
  assert.equal(messageCount(c.id), before);
  assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
  assert.equal(db.listJobs().filter((j) => j.customer_id === c.id).length, 0);

  // the notify choice made on the packet page carries into the confirm screen
  const carried = await (await app.post(`/dashboard/customers/${c.id}/sale-packet/email/review`, { file_ids: files[0].id, notify_customer: '1' })).text();
  assert.match(carried, /name="notify_customer" value="1" style="width:auto;margin-top:4px" checked>/);
});

test('034: email review refuses: no files, no valid email, too big, unknown customer', async () => {
  const { c, files } = makeCustomer('Email Refuse Person');
  const loc = async (r) => decodeURIComponent(r.headers.get('location'));
  let r = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/review`, {});
  assert.match(await loc(r), /sale-packet\?err=Tick at least one file/);

  const noEmail = makeCustomer('Email Missing Person', { email: '' });
  r = await app.post(`/dashboard/customers/${noEmail.c.id}/sale-packet/email/review`, { file_ids: noEmail.files[0].id });
  assert.match(await loc(r), /No valid email on file/);

  const big = db.createCustomerFile({ customer_id: c.id, stored_name: 'big.pdf', original_name: 'huge.pdf', mime_type: 'application/pdf', size: 19 * 1024 * 1024 });
  r = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/review`, { file_ids: [files[0].id, big] });
  assert.match(await loc(r), /too big to email/);

  assert.equal((await app.post('/dashboard/customers/nope/sale-packet/email/review', {})).status, 404);
});

test('034: email send without the confirm flag does nothing', async () => {
  const { c, files } = makeCustomer('Email Unconfirmed Person');
  const before = messageCount(c.id);
  const r = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { file_ids: files[0].id, subject: 'S', body: 'B' }); // no confirmed=1
  assert.match(decodeURIComponent(r.headers.get('location')), /Not sent - review and confirm/);
  const r2 = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { confirmed: '0', file_ids: files[0].id, subject: 'S', body: 'B' });
  assert.match(decodeURIComponent(r2.headers.get('location')), /Not sent/);
  assert.equal(messageCount(c.id), before);
  assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
});

test('034: if the email cannot be sent (not configured), the sale is NOT completed', async () => {
  const { c, files } = makeCustomer('Email Unconfigured Person');
  const r = await app.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { confirmed: '1', file_ids: files[0].id, subject: 'Docs', body: 'Here you go' });
  const loc = decodeURIComponent(r.headers.get('location'));
  assert.match(loc, /sale-packet\?err=The email was NOT sent \(email isn't set up on this server\)\. Nothing was changed/);
  assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
  assert.equal(db.listJobs().filter((j) => j.customer_id === c.id).length, 0);
  assert.equal(openFollowups(c.id, 'Schedule measure').length, 0);
});

async function withSmtp(opts, fn) {
  const smtp = await startFakeSmtp(opts);
  const server = await startServer({ GMAIL_USER: 'bos@test.local', GMAIL_APP_PASSWORD: 'app-password', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port) });
  try {
    await fn(server, smtp);
  } finally {
    await server.stop();
    await smtp.close();
  }
}

test('034: confirmed email sends the selected files as attachments, then completes the sale - and still sends no order-confirmed message', async () => {
  await withSmtp({}, async (server, smtp) => {
    const { c, files } = makeCustomer('Email Send Person');
    const r = await server.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, {
      confirmed: '1',
      file_ids: [files[0].id, files[1].id],
      subject: 'Your project documents',
      body: 'Hi Email,\n\nAttached are your docs.',
    });
    assert.equal(r.status, 302, server.log());
    const loc = decodeURIComponent(r.headers.get('location'));
    assert.match(loc, new RegExp(`^/dashboard/customers/${c.id}\\?ok=Packet emailed to email\\.send\\.person@example\\.com\\. Customer marked Sold`));
    assert.match(loc, /no message sent to the customer/);

    assert.equal(smtp.messages.length, 1, 'exactly one email went out');
    const m = smtp.messages[0];
    assert.match(m.to.join(' '), /email\.send\.person@example\.com/);
    assert.match(m.data, /Subject: Your project documents/);
    const flat = m.data.replace(/\r\n/g, '');
    for (const f of files) {
      assert.match(m.data, new RegExp(`filename="?${f.name.replace('.', '\\.')}"?`), `${f.name} attached`);
      assert.ok(flat.includes(f.content.toString('base64').slice(0, 60)), `${f.name} bytes are in the message`);
    }
    assert.match(m.data, /Attached are your docs\./);

    // sale completed, and the ONLY message logged to the customer is the packet email itself
    assert.equal(db.getCustomer(c.id).sales_stage, 'Sold');
    const job = db.listJobs().find((j) => j.customer_id === c.id);
    assert.equal(job.status, 'Measuring Scheduled');
    assert.equal(openFollowups(c.id, 'Schedule measure').length, 1);
    const msgs = db.listMessagesForCustomer(c.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].channel, 'email');
    assert.equal(msgs[0].status, 'sent');
    assert.match(msgs[0].body, /\[Attachments: doc-\d\.pdf, doc-\d\.pdf\]/);
    assert.ok(msgs[0].body.includes('doc-1.pdf') && msgs[0].body.includes('doc-2.pdf'));
    assert.ok(db.listActivityForCustomer(c.id).some((a) => a.field === 'sale_packet_emailed'));
  });
});

test('034: confirmed email + notify ticked also sends the order-confirmed message', async () => {
  await withSmtp({}, async (server, smtp) => {
    const { c, files } = makeCustomer('Email Notify Person');
    const r = await server.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { confirmed: '1', file_ids: files[0].id, subject: 'Docs', body: 'Here', notify_customer: '1' });
    assert.equal(r.status, 302, server.log());
    assert.match(decodeURIComponent(r.headers.get('location')), /order-confirmed message sent to the customer/);
    assert.ok(smtp.messages.length >= 2, 'the packet email AND the order-confirmed email');
    assert.ok(smtp.messages.some((m) => /order is confirmed|Your order/i.test(m.data)));
  });
});

test('034: if the mail server refuses the message, nothing is completed', async () => {
  await withSmtp({ rejectRcpt: true }, async (server, smtp) => {
    const { c, files } = makeCustomer('Email Rejected Person');
    const r = await server.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { confirmed: '1', file_ids: files[0].id, subject: 'Docs', body: 'Here' });
    assert.match(decodeURIComponent(r.headers.get('location')), /The email was NOT sent .*Nothing was changed - the customer is not marked Sold/);
    assert.equal(smtp.messages.length, 0);
    assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
    assert.equal(db.listJobs().filter((j) => j.customer_id === c.id).length, 0);
    assert.equal(openFollowups(c.id, 'Schedule measure').length, 0);
    const logged = db.listMessagesForCustomer(c.id);
    assert.equal(logged.length, 1);
    assert.match(logged[0].status, /^failed/);
  });
});

test('034: a missing file on disk stops the email before anything is sent', async () => {
  await withSmtp({}, async (server, smtp) => {
    const { c, files } = makeCustomer('Email Missing File Person');
    fs.unlinkSync(path.join(UPLOADS, c.id, 'stored-1.pdf'));
    const r = await server.post(`/dashboard/customers/${c.id}/sale-packet/email/send`, { confirmed: '1', file_ids: files[0].id, subject: 'Docs', body: 'Here' });
    assert.match(decodeURIComponent(r.headers.get('location')), /"doc-1\.pdf" is missing from disk\. Nothing was sent\./);
    assert.equal(smtp.messages.length, 0);
    assert.notEqual(db.getCustomer(c.id).sales_stage, 'Sold');
  });
});
