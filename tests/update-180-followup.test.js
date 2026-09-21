// Same-night follow-ups to 1.8.0:
//   048 - the Menu shows "BOS <version>" (from package.json) above Log out
//   033 - the assistant can set / change / clear a job's estimated install date
//         (update_job, confirm-before-write), and get_job_detail already returns it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db } = require('./helpers');
const { startServer } = require('./http-helper');
const render = require('../src/render');
const util = require('../src/util');
const assistant = require('../src/services/assistant');

const layout = (active) => render.dashboardLayout({ title: 'T', active, body: '<p>x</p>', context: {} });
// Node's ICU may put a narrow no-break space before AM/PM; compare with a plain one.
const plain = (s) => s.replace(/[  ]/g, ' ');

let app;
test.before(async () => {
  app = await startServer();
});
test.after(async () => {
  if (app) await app.stop();
});

// ---------------------------------------------------------------- 048 Version in the Menu
test('048: Menu shows "BOS <package.json version>" directly above Log out', () => {
  const pkg = require('../package.json');
  const html = layout('/dashboard');
  const at = html.indexOf('class="menu-version"');
  assert.ok(at > -1);
  assert.equal((html.match(/class="menu-version"/g) || []).length, 1);
  assert.ok(
    html.includes('<div class="menu-version">BOS ' + pkg.version + '</div><a class="menu-logout" href="/logout">Log out</a>'),
    'version line immediately precedes the Log out link'
  );
  assert.ok(at > html.lastIndexOf('menu-group-title'), 'sits in the last group, after every menu item');
  assert.ok(at < html.indexOf('href="/logout"'), 'above Log out');
});

test('048: the version is read from package.json, not hard-coded (a different version shows up)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  assert.ok(!/BOS [0-9]+[.][0-9]+/.test(src), 'no version literal in render.js');
  assert.ok(src.includes("require('../package.json').version"));

  const pkgPath = require.resolve('../package.json');
  const renderPath = require.resolve('../src/render');
  const realPkg = require.cache[pkgPath].exports;
  const realRender = require.cache[renderPath];
  try {
    require.cache[pkgPath].exports = { ...realPkg, version: '9.8.7-test' };
    delete require.cache[renderPath];
    const fresh = require('../src/render');
    const html = fresh.dashboardLayout({ title: 'T', active: '/dashboard', body: '', context: {} });
    assert.ok(html.includes('<div class="menu-version">BOS 9.8.7-test</div>'));
  } finally {
    require.cache[pkgPath].exports = realPkg;
    require.cache[renderPath] = realRender;
  }
});

test('048: every dashboard page carries it', async () => {
  const pkg = require('../package.json');
  for (const p of ['/dashboard', '/dashboard/customers', '/dashboard/files']) {
    const html = await (await app.get(p)).text();
    assert.ok(html.includes('BOS ' + pkg.version), p);
  }
});

// ---------------------------------------------------------------- 033 assistant sets the install date
const jobFor = (name) => {
  const c = db.createCustomer({ name, phone: '+18045550123', email: name.toLowerCase().replace(/ /g, '.') + '@example.com' });
  return { c, job: db.createJob({ customer_id: c.id, sold_amount: 5000 }) };
};

test('033: update_job advertises estimated_install_at and stays confirm-before-write', () => {
  const tool = assistant.TOOLS.find((t) => t.name === 'update_job');
  assert.equal(tool.input_schema.properties.estimated_install_at.type, 'string');
  assert.ok(!(tool.input_schema.required || []).includes('estimated_install_at'), 'optional');
  assert.match(tool.description, /ESTIMATED INSTALL DATE/);
  assert.match(tool.description, /explicit confirmation/);
  assert.match(tool.description, /never messages the customer/);
});

test('033: without confirmed:true nothing is written', () => {
  const { job } = jobFor('Assistant Unconfirmed');
  const r = assistant.runTool('update_job', { job_id: job.id, estimated_install_at: '2026-10-06' });
  assert.match(r.error, /Not changed/);
  assert.match(r.error, /estimated install date/);
  assert.equal(db.getJob(job.id).estimated_install_at, null);
  const r2 = assistant.runTool('update_job', { job_id: job.id, estimated_install_at: '2026-10-06', confirmed: 'yes' });
  assert.match(r2.error, /Not changed/, 'only boolean true counts');
  assert.equal(db.getJob(job.id).estimated_install_at, null);
});

test('033: confirmed -> sets it (noon-UTC calendar day), audited as the assistant, nothing else moves, nobody is messaged', () => {
  const { c, job } = jobFor('Assistant Sets Install');
  const msgs = db.listMessagesForCustomer(c.id).length;
  const r = assistant.runTool('update_job', { job_id: job.id, estimated_install_at: '2026-10-06', confirmed: true });
  assert.equal(r.ok, true);
  assert.equal(r.job.estimated_install_at, '2026-10-06T12:00:00.000Z');
  assert.match(plain(util.fmtDate(r.job.estimated_install_at)), /Oct 6, 2026/);
  assert.equal(r.job.status, 'Order Confirmed', 'status untouched');
  assert.equal(r.job.sold_amount, 5000, 'sold amount untouched');
  assert.equal(db.getJobHistory(job.id).length, 1, 'no status history row');
  assert.equal(db.listMessagesForCustomer(c.id).length, msgs, 'no customer message');
  const audit = db.listActivityForCustomer(c.id).find((a) => a.entity_id === job.id && a.field === 'estimated_install_at');
  assert.equal(audit.actor, 'assistant');
  assert.equal(audit.new_value, '2026-10-06T12:00:00.000Z');
});

test('033: change it, leave it alone (omitted / null), clear it with an empty string', () => {
  const { job } = jobFor('Assistant Changes Install');
  const set = (extra) => assistant.runTool('update_job', { job_id: job.id, confirmed: true, ...extra });
  set({ estimated_install_at: '2026-10-06' });
  assert.equal(set({ estimated_install_at: '2026-10-20' }).job.estimated_install_at, '2026-10-20T12:00:00.000Z');
  assert.equal(set({ note: 'just a note' }).job.estimated_install_at, '2026-10-20T12:00:00.000Z', 'omitted = unchanged');
  assert.equal(set({ estimated_install_at: null }).job.estimated_install_at, '2026-10-20T12:00:00.000Z', 'null = unchanged');
  assert.equal(set({ estimated_install_at: '' }).job.estimated_install_at, null, 'empty string clears');
});

test('033: a bad date is refused and the same call changes nothing else (no half-applied update)', () => {
  const { job } = jobFor('Assistant Bad Date');
  for (const bad of ['next week', '2026-02-31', '2026-13-01', '10/06/2026 maybe']) {
    const r = assistant.runTool('update_job', { job_id: job.id, confirmed: true, estimated_install_at: bad, sold_amount: 9999, status: 'Measured' });
    assert.match(r.error, /not a valid date/, bad);
  }
  const j = db.getJob(job.id);
  assert.equal(j.estimated_install_at, null);
  assert.equal(j.sold_amount, 5000, 'sold amount not applied');
  assert.equal(j.status, 'Order Confirmed', 'status not applied');
});

test('033: a valid date can ride along with a status / amount change in one confirmed call', () => {
  const { job } = jobFor('Assistant Combined');
  const r = assistant.runTool('update_job', { job_id: job.id, confirmed: true, estimated_install_at: '2026-11-03', status: 'Measured', sold_amount: 6100 });
  assert.equal(r.job.estimated_install_at, '2026-11-03T12:00:00.000Z');
  assert.equal(r.job.status, 'Measured');
  assert.equal(r.job.sold_amount, 6100);
  assert.match(assistant.runTool('update_job', { job_id: 'nope', confirmed: true, estimated_install_at: '2026-11-03' }).error, /Job not found/);
});

test('033: get_job_detail returns estimated_install_at', () => {
  const { job } = jobFor('Assistant Reads Install');
  assert.equal(assistant.runTool('get_job_detail', { job_id: job.id }).job.estimated_install_at, null);
  db.updateJobEstimatedInstall(job.id, '2026-12-01', 'user:test');
  assert.equal(assistant.runTool('get_job_detail', { job_id: job.id }).job.estimated_install_at, '2026-12-01T12:00:00.000Z');
});

test('033: the install date is strictly a real YYYY-MM-DD (no loose parsing), for the dashboard and the assistant alike', () => {
  for (const ok of ['2026-10-06', '2028-02-29', ' 2026-10-06 ']) assert.equal(util.isCalendarDate(ok), true, ok);
  for (const bad of ['10/06/2026 maybe', '10/06/2026', 'Oct 6 2026', '2026-10-06T09:30', '2026-02-31', '2027-02-29', '2026-13-01', 'next week', '', null, undefined]) {
    assert.equal(util.isCalendarDate(bad), false, String(bad));
  }
  const { job } = jobFor('Strict Date Person');
  assert.throws(() => db.updateJobEstimatedInstall(job.id, '10/06/2026', 'user:test'), /valid date/);
  assert.equal(db.getJob(job.id).estimated_install_at, null);
});

test('033: impossible calendar dates are rejected by dateInputToIso and by the job page', async () => {
  assert.equal(util.dateInputToIso('2026-02-31'), null);
  assert.equal(util.dateInputToIso('2027-02-29'), null);
  assert.equal(util.dateInputToIso('2028-02-29'), '2028-02-29T12:00:00.000Z');
  const { job } = jobFor('Job Page Bad Date');
  const r = await app.post('/dashboard/jobs/' + job.id + '/estimated-install', { estimated_install_at: '2026-02-31' });
  assert.match(decodeURIComponent(r.headers.get('location')), /[?]err=Not a valid date/);
  assert.equal(db.getJob(job.id).estimated_install_at, null);
});
