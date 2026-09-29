// BF-2640-078 Email compose. Real server on a random port (tests/http-helper.js),
// throwaway DB and uploads folder, every messaging / AI credential blanked. The
// send tests point a second server at a tiny fake SMTP server on localhost
// (SMTP_HOST / SMTP_PORT), so attachments and the confirm step are exercised end
// to end without ever touching Gmail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
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

// ---------- helpers ----------
// A customer with an email and real PDF files on disk.
function makeCustomer(name, n = 2) {
  const c = db.createCustomer({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, phone: '+18045550178' });
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  madeDirs.add(dir);
  const files = [];
  for (let i = 1; i <= n; i++) {
    const content = Buffer.from(`%PDF-1.4 ${name} doc ${i} ` + 'x'.repeat(200));
    const stored = `e078-${c.id}-${i}.pdf`;
    fs.writeFileSync(path.join(dir, stored), content);
    const id = db.createCustomerFile({ customer_id: c.id, stored_name: stored, original_name: `doc-${i}.pdf`, mime_type: 'application/pdf', size: content.length });
    files.push({ id, content, name: `doc-${i}.pdf` });
  }
  return { c, files };
}
const scriptWith = (html, marker) => {
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `missing ${marker}`);
  const start = html.lastIndexOf('<script>', at) + '<script>'.length;
  return html.slice(start, html.indexOf('</script>', at));
};
const reviewedHash = (html) => (html.match(/name="reviewed" value="([0-9a-f]{64})"/) || [])[1];

function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '', inData = false, rcpt = [];
    sock.write('220 fake.local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) break;
          messages.push({ to: rcpt, data: buf.slice(0, end) });
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
        else if (up.startsWith('MAIL FROM')) { rcpt = []; sock.write('250 ok\r\n'); }
        else if (up.startsWith('RCPT TO')) { rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, close: () => new Promise((r) => server.close(r)) })));
}
async function withSmtp(fn) {
  const smtp = await startFakeSmtp();
  const server = await startServer({ GMAIL_USER: 'bos@test.local', GMAIL_APP_PASSWORD: 'app-password', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port) });
  try {
    await fn(server, smtp);
  } finally {
    await server.stop();
    await smtp.close();
  }
}

// ================================================================ BF-2640-078
test('BF-2640-078: Email on a customer opens a compose window with To, Subject, Body, that customer files, Warranty, Referral, Send and Close', async () => {
  const { c, files } = makeCustomer('Compose Open Person');
  const other = makeCustomer('Compose Other Person', 1);
  const owner = db.ensureUser('compose-desk-owner');
  const rec = db.createRecord(owner, { kind: 'thing', name: 'Compose Desk Car', is_personal: true });

  const page = await (await srv.get(`/dashboard/customers/${c.id}`)).text();
  assert.match(page, new RegExp(`<a class="qa" href="/dashboard/customers/${c.id}/email"[^>]*>✉️<span>Email</span>`));

  const res = await srv.get(`/dashboard/customers/${c.id}/email`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`<form class="panel" id="email-compose" method="POST" action="/dashboard/customers/${c.id}/email/send">`));
  assert.match(html, /name="to" value="compose\.open\.person@example\.com"/, 'To starts as the customer email');
  assert.match(html, /id="compose-subject" name="subject"/);
  assert.match(html, /<textarea id="compose-body" name="body"/);
  for (const f of files) assert.match(html, new RegExp(`name="file_ids" value="${f.id}"`));
  assert.ok(!html.includes(other.files[0].id), 'another customer file is never offered');
  assert.ok(!html.includes(rec.id) && !/Compose Desk Car/.test(html), 'Desk record files are never offered');
  assert.match(html, /data-canned="warranty"[^>]*>Warranty</);
  assert.match(html, /data-canned="referral"[^>]*>Referral</);
  assert.match(html, /data-compose-send>Send</);
  assert.match(html, new RegExp(`href="/dashboard/customers/${c.id}" data-compose-close>Close<`), 'Close is a plain link that sends nothing');
  assert.ok(!/<img[^>]+\.pdf|thumbnail/i.test(html), 'no PDF thumbnails');
});

test('BF-2640-078: Send does not fire without confirm, and a change after the confirm step needs a new confirm', async () => {
  await withSmtp(async (server, smtp) => {
    const { c, files } = makeCustomer('Compose Confirm Person');
    const form = { to: c.email, subject: 'Your drawings', body: 'Hi,\n\nHere are your drawings.', file_ids: [files[0].id] };

    const first = await server.post(`/dashboard/customers/${c.id}/email/send`, form);
    assert.equal(first.status, 200, 'Send shows the confirm step, not a redirect');
    const review = await first.text();
    assert.match(review, /Send this email\?/);
    assert.match(review, /data-compose-confirm>Yes, send</);
    assert.match(review, /Here are your drawings\./, 'the typed body is still in the window');
    assert.equal(smtp.messages.length, 0, 'nothing sent without confirm');
    assert.equal(db.listMessagesForCustomer(c.id).length, 0, 'nothing recorded without confirm');

    // confirmed=1 but the body changed after the review: shown for review again, not sent.
    const changed = await server.post(`/dashboard/customers/${c.id}/email/send`, { ...form, body: 'Changed after review.', confirmed: '1', reviewed: reviewedHash(review) });
    assert.equal(changed.status, 200);
    assert.match(await changed.text(), /Send this email\?/);
    // confirmed=1 with no review at all: not sent.
    const noReview = await server.post(`/dashboard/customers/${c.id}/email/send`, { ...form, confirmed: '1' });
    assert.equal(noReview.status, 200);
    assert.equal(smtp.messages.length, 0);
    assert.equal(db.listMessagesForCustomer(c.id).length, 0);
  });
});

test('BF-2640-078: a ticked customer file is attached on send and the message is stored on the customer', async () => {
  await withSmtp(async (server, smtp) => {
    const { c, files } = makeCustomer('Compose Attach Person');
    const other = makeCustomer('Compose Stranger Person', 1);
    const form = { to: c.email, subject: 'Your quote', body: 'Hi,\n\nYour quote is attached.', file_ids: [files[1].id, other.files[0].id] };
    const review = await (await server.post(`/dashboard/customers/${c.id}/email/send`, form)).text();
    assert.ok(!review.includes(`value="${other.files[0].id}" style="width:auto" checked`), 'a file from another customer is dropped');

    const r = await server.post(`/dashboard/customers/${c.id}/email/send`, { ...form, confirmed: '1', reviewed: reviewedHash(review) });
    assert.equal(r.status, 302, server.log());
    assert.match(decodeURIComponent(r.headers.get('location')), new RegExp(`^/dashboard/customers/${c.id}\\?ok=Email sent to compose\\.attach\\.person@example\\.com with 1 attachment\\.`));

    assert.equal(smtp.messages.length, 1, 'exactly one email went out');
    const m = smtp.messages[0];
    assert.match(m.to.join(' '), /compose\.attach\.person@example\.com/);
    assert.match(m.data, /Subject: Your quote/);
    assert.match(m.data, /filename="?doc-2\.pdf"?/, 'the ticked file is attached');
    assert.ok(m.data.replace(/\r\n/g, '').includes(files[1].content.toString('base64').slice(0, 60)), 'its bytes are in the message');
    assert.ok(!/doc-1\.pdf/.test(m.data), 'an unticked file is not attached');
    assert.ok(!m.data.replace(/\r\n/g, '').includes(other.files[0].content.toString('base64').slice(0, 60)), 'another customer file is never attached');

    const msgs = db.listMessagesForCustomer(c.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].channel, 'email');
    assert.equal(msgs[0].status, 'sent');
    assert.match(msgs[0].body, /Your quote is attached\./);
    assert.match(msgs[0].body, /\[Attachments: doc-2\.pdf\]/);
  });
});

test('BF-2640-078: the floating preview is fileViewerBody with Add this file to Email, which ticks the file, closes the preview, and keeps the typed body', async () => {
  const { c, files } = makeCustomer('Compose Preview Person', 3);

  // The preview: the same viewer (Previous, Next, Close, PDF in the browser viewer), no dashboard chrome.
  const v = await srv.get(`/dashboard/customers/${c.id}/files/${files[1].id}/view?embed=email`);
  assert.equal(v.status, 200);
  const viewer = await v.text();
  assert.match(viewer, /<body class="viewer-embed">/);
  assert.ok(!/class="bottomnav"|id="assistant-widget"/.test(viewer), 'no dashboard chrome inside the preview');
  assert.match(viewer, /class="viewer-bar"/);
  // Previous / Next walk that customer's files in Files-list order (newest first).
  const order = db.listCustomerFiles(c.id).map((f) => f.id);
  const at = order.indexOf(files[1].id);
  assert.match(viewer, new RegExp(`href="/dashboard/customers/${c.id}/files/${order[at - 1]}/view\\?embed=email" data-viewer-prev`));
  assert.match(viewer, new RegExp(`href="/dashboard/customers/${c.id}/files/${order[at + 1]}/view\\?embed=email" data-viewer-next`));
  assert.match(viewer, /<iframe class="viewer-pdf"/, 'the PDF opens in the browser PDF viewer, which keeps its zoom');
  assert.match(viewer, new RegExp(`data-email-attach="${files[1].id}">Add this file to Email<`));
  // The plain viewer has no Add this file to Email.
  assert.ok(!/Add this file to Email/.test(await (await srv.get(`/dashboard/customers/${c.id}/files/${files[1].id}/view`)).text()));

  // Inside the preview: Add this file to Email tells the compose page which file.
  const sent = [];
  const listeners = {};
  const win = { addEventListener: (t, fn) => (listeners[t] = fn) };
  win.parent = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
  new Function('window', 'location', scriptWith(viewer, 'data-email-attach]'))(win, { origin: 'http://bos.test' });
  const addBtn = { getAttribute: () => files[1].id };
  listeners.click({ target: { closest: (s) => (s === '[data-email-attach]' ? addBtn : null) }, preventDefault() {}, stopImmediatePropagation() {} });
  assert.deepEqual(sent, [{ msg: { bosEmail: 'attach', fileId: files[1].id }, origin: 'http://bos.test' }]);

  // On the compose page: that message ticks the file, closes the preview, and leaves the typed body alone.
  const compose = await (await srv.get(`/dashboard/customers/${c.id}/email`)).text();
  const boxes = Object.fromEntries(files.map((f) => [f.id, { checked: false, dispatchEvent() {} }]));
  const typed = 'Hi,\n\nI typed this before opening the preview.';
  const bodyEl = { value: typed, focus() {}, dispatchEvent() {} };
  const box = { hidden: false };
  const frame = { src: 'x', removeAttribute(a) { if (a === 'src') this.src = ''; } };
  const formEl = {
    addEventListener() {},
    querySelector: (sel) => boxes[(sel.match(/value="([^"]+)"/) || [])[1]] || null,
  };
  const els = { 'email-compose': formEl, 'compose-body': bodyEl, 'email-preview': box, 'email-preview-frame': frame };
  const page = {};
  const doc = { getElementById: (id) => els[id] || null, addEventListener: (t, fn) => (page['doc:' + t] = fn) };
  const w = { addEventListener: (t, fn) => (page['win:' + t] = fn) };
  new Function('document', 'window', 'location', 'Event', scriptWith(compose, "getElementById('email-compose')"))(doc, w, { origin: 'http://bos.test' }, class { constructor(t) { this.type = t; } });
  page['win:message']({ origin: 'http://bos.test', data: { bosEmail: 'attach', fileId: files[1].id } });
  assert.equal(boxes[files[1].id].checked, true, 'the file is ticked on the compose list');
  assert.equal(boxes[files[0].id].checked, false);
  assert.equal(box.hidden, true, 'the preview closed');
  assert.equal(bodyEl.value, typed, 'the typed body is still present');
  // A message from another origin is ignored.
  page['win:message']({ origin: 'http://evil.test', data: { bosEmail: 'attach', fileId: files[0].id } });
  assert.equal(boxes[files[0].id].checked, false);

  // The Warranty canned note inserts into the body and keeps what was typed.
  const warranty = compose.match(/data-canned="warranty" data-canned-text="([^"]+)"/)[1];
  page['doc:click']({ target: { closest: (s) => (s === '[data-canned]' ? { getAttribute: () => warranty } : null) } });
  assert.ok(bodyEl.value.startsWith(typed) && bodyEl.value.endsWith(warranty), 'canned note appended after the typed body');
});

test('BF-2640-078: Foreman fills the compose window and sends nothing', async () => {
  const assistant = require('../src/services/assistant');
  const { c, files } = makeCustomer('Compose Foreman Person');
  const other = makeCustomer('Compose Foreman Other', 1);
  const r = await assistant.runTool(
    'fill_email_compose',
    { customer_id: c.id, subject: 'Warranty visit', body: 'Hi, here is your install photo.', file_ids: [files[0].id, other.files[0].id] },
    {}
  );
  assert.equal(r.ok, true);
  assert.match(r.__navigate, new RegExp(`^/dashboard/customers/${c.id}/email\\?draft=`));
  assert.deepEqual(r.filled.file_ids, [files[0].id]);
  assert.deepEqual(r.skipped_file_ids, [other.files[0].id]);
  assert.match(r.note, /Nothing was sent/);
  assert.equal(db.listMessagesForCustomer(c.id).length, 0);

  const html = await (await srv.get(r.__navigate)).text();
  assert.match(html, /name="to" value="compose\.foreman\.person@example\.com"/);
  assert.match(html, /name="subject" value="Warranty visit"/);
  assert.match(html, /Hi, here is your install photo\./);
  assert.match(html, new RegExp(`value="${files[0].id}" style="width:auto" checked`));
  assert.ok(!/Send this email\?/.test(html), 'Foreman does not skip Andrew\'s confirm');
  assert.ok(!fs.existsSync(path.join(UPLOADS, 'BF-2640-078')), 'no folder named after the ticket');
});
