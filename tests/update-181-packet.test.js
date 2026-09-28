// BOS 1.8.1 - BF-2639-060: the sale packet leaves the job at Order Confirmed;
// only booking a Measure moves it to Measuring Scheduled. Same real-server path
// as tests/update-180-packet.test.js (the on-device sign route).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, tmpDbPath } = require('./helpers');
const { startServer } = require('./http-helper');

const UPLOADS = path.join(path.dirname(tmpDbPath), 'uploads');
const cleanup = [];
let app;
test.before(async () => {
  app = await startServer();
});
test.after(async () => {
  if (app) await app.stop();
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

function makePng(w = 60, h = 40) {
  // varied pixels, so the PNG stays above the sign route's 200-byte minimum
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = (x * 7) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = ((x + y) * 3) & 255; raw[o + 3] = 255; }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function customerWithFile(name) {
  const c = db.createCustomer({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, phone: '+18045550160' });
  db.createLead({ customer_id: c.id, stage: 'Quoted', estimate_value: 5000 });
  const dir = path.join(UPLOADS, c.id);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  fs.writeFileSync(path.join(dir, 'packet-doc.pdf'), Buffer.from('%PDF-1.4 test'));
  const fileId = db.createCustomerFile({ customer_id: c.id, stored_name: 'packet-doc.pdf', original_name: 'packet-doc.pdf', mime_type: 'application/pdf', size: 13 });
  return { c, fileId };
}
const openFollowups = (cid, title) => db.listFollowups(cid).filter((f) => f.status === 'open' && f.title === title);

test('BF-2639-060: completing the sale packet leaves the job at Order Confirmed and adds a Schedule measure follow-up', async () => {
  const { c, fileId } = customerWithFile('Packet 181 Person');
  const res = await app.post(`/dashboard/customers/${c.id}/sale-packet/sign`, {
    name: 'Packet 181 Person',
    data_url: 'data:image/png;base64,' + makePng().toString('base64'),
    file_ids: [fileId],
    notify_customer: false,
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(db.getCustomer(c.id).sales_stage, 'Sold', 'still marks the customer Sold');
  const job = db.listJobs().find((j) => j.customer_id === c.id);
  assert.ok(job, 'still ensures a job exists');
  assert.equal(job.status, 'Order Confirmed');
  assert.deepEqual(db.getJobHistory(job.id).map((h) => h.status), ['Order Confirmed']);
  assert.equal(openFollowups(c.id, 'Schedule measure').length, 1);
  assert.match(decodeURIComponent(out.redirect), /job at Order Confirmed/);
  assert.equal(db.listMessagesForCustomer(c.id).length, 0, 'the notify box stays off unless ticked');
});

test('BF-2639-060: booking a Measure appointment for that job moves it to Measuring Scheduled', async () => {
  const { c } = customerWithFile('Measure Booker');
  const r = db.completeSalePacket(c.id, { actor: 'test', via: 'emailed' });
  assert.equal(r.job.status, 'Order Confirmed');
  const post = await app.post('/dashboard/appointments', {
    customer_id: c.id,
    type: 'Measure',
    scheduled_at: '2026-10-20T10:00',
    duration_min: '60',
    return_to: `/dashboard/customers/${c.id}`,
  });
  assert.equal(post.status, 302);
  assert.equal(db.getJob(r.job.id).status, 'Measuring Scheduled');
});

test('BF-2639-060: the packet and a Measure booking never move a job backward', async () => {
  const { c } = customerWithFile('Later Status Person');
  const job = db.createJob({ customer_id: c.id, sold_amount: 100 });
  db.updateJobStatus(job.id, 'In Production', null);
  db.completeSalePacket(c.id, { actor: 'test' });
  assert.equal(db.getJob(job.id).status, 'In Production', 'packet leaves a later status alone');
  db.createAppointment({ customer_id: c.id, type: 'Measure', scheduled_at: new Date(Date.now() + 86400000).toISOString(), created_by: 'test' });
  assert.equal(db.getJob(job.id).status, 'In Production', 'a Measure booking never regresses it');
  // A non-Measure booking does not touch the job at all.
  const { c: c2 } = customerWithFile('Design Only Person');
  const r2 = db.completeSalePacket(c2.id, { actor: 'test' });
  db.createAppointment({ customer_id: c2.id, type: 'Design Review', scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(db.getJob(r2.job.id).status, 'Order Confirmed');
});
