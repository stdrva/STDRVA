// BOS 1.8.0 - one section per tracking ID (046, 028, 047, 001, 022, 023, 025, 033, 034).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db } = require('./helpers');
const render = require('../src/render');
const util = require('../src/util');
const assistant = require('../src/services/assistant');

const layout = (active) => render.dashboardLayout({ title: 'T', active, body: '<p>x</p>', context: {} });
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
// Node's ICU may put a narrow no-break space before AM/PM; compare with a plain one.
const plain = (s) => s.replace(/[  ]/g, ' ');

// ---------------------------------------------------------------- 046 Chrome
test('046: top bar is the logo wordmark only - no drawer icon, no bell, no text brand', () => {
  const html = layout('/dashboard');
  const top = html.slice(html.indexOf('class="topnav"'), html.indexOf('menu-backdrop'));
  assert.match(top, /<img src="\/static\/img\/logo\.png"/);
  assert.ok(!/apple-touch-icon|favicon/.test(top), 'drawer icon must not be in the header');
  assert.ok(!/bell/i.test(top));
  assert.ok(!/The BOS/.test(top));
});

test('046: never more than four always-visible destinations (3 links + Menu), no old More / tab row', () => {
  const html = layout('/dashboard');
  const bottom = html.slice(html.indexOf('<nav class="bottomnav"'));
  const bottomEnd = bottom.slice(0, bottom.indexOf('</nav>'));
  assert.equal((bottomEnd.match(/<a /g) || []).length, 3);
  assert.equal((bottomEnd.match(/<button /g) || []).length, 1);
  assert.deepEqual(
    [...bottomEnd.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]),
    ['/dashboard', '/dashboard/appointments', '/dashboard/pipeline']
  );
  const topNav = html.slice(html.indexOf('<nav class="topnav-links"'), html.indexOf('</nav>', html.indexOf('<nav class="topnav-links"')));
  assert.equal((topNav.match(/<a /g) || []).length, 3);
  assert.equal((topNav.match(/<button /g) || []).length, 1);
  assert.ok(!/nav-more|<summary>More/.test(html), 'old More menu is gone');
  assert.ok(!/nav-more|\.nav-logout/.test(css), 'old More / logout CSS is gone');
});

test('046: Menu sheet has the exact groups and items, Training grey and not a link, Log out last and live', () => {
  const html = layout('/dashboard');
  const sheet = html.slice(html.indexOf('id="menu-sheet"'), html.indexOf('</script>', html.indexOf('id="menu-sheet"')));
  const titles = [...sheet.matchAll(/menu-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Training', 'Marketing', 'Financial', 'Customer Relations', 'Production']);

  // Split the sheet into its <div class="menu-group"> blocks; each starts with its title.
  const blocks = sheet.split(/<div class="menu-group(?: menu-group-logout)?">/).slice(1);
  const groupItems = (title) => {
    const block = blocks.find((blk) => blk.includes(`menu-group-title">${title}<`));
    return [...block.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  };
  assert.deepEqual(groupItems('Marketing'), [['/dashboard/marketing', 'Marketing'], ['/dashboard/booking-link', 'Show Prep']]);
  assert.deepEqual(groupItems('Financial'), [['/dashboard/finances', 'Bookkeeping'], ['/dashboard/kpi', 'KPI']]);
  assert.deepEqual(groupItems('Customer Relations'), [
    ['/dashboard', 'Overview'],
    ['/dashboard/customers', 'Customers'],
    ['/dashboard/pipeline', 'Pipeline'],
    ['/dashboard/appointments', 'Appointments'],
    ['/dashboard/messages', 'Messages'],
    ['/dashboard/files', 'Files'],
    ['/dashboard/files/deleted', 'Deleted Files'],
  ]);
  assert.deepEqual(groupItems('Production'), [['/dashboard/jobs', 'Jobs'], ['/dashboard/production', 'Production Queue']]);

  // Training: a grey span, not an anchor.
  assert.match(sheet, /<span class="menu-disabled" aria-disabled="true">Training<\/span>/);
  assert.equal(groupItems('Training').length, 0);
  // Log out: last thing in the sheet, a real link, never the disabled style.
  const logoutIdx = sheet.indexOf('href="/logout"');
  assert.ok(logoutIdx > sheet.lastIndexOf('menu-group-title'));
  assert.match(sheet.slice(logoutIdx - 40, logoutIdx + 60), /menu-logout/);
  assert.equal(sheet.slice(logoutIdx).includes('menu-disabled'), false);
});

test('046: Menu button is highlighted only when the current page is not one of the three primaries', () => {
  const on = (active) => /class="nav-menu-btn active"/.test(layout(active));
  assert.equal(on('/dashboard'), false);
  assert.equal(on('/dashboard/appointments'), false);
  assert.equal(on('/dashboard/pipeline'), false);
  assert.equal(on('/dashboard/kpi'), true);
  assert.equal(on('/dashboard/finances/expenses'), true);
  // and Bookkeeping is marked current inside the sheet on a finance sub-page
  assert.match(layout('/dashboard/finances/expenses'), /<a href="\/dashboard\/finances" class="active">Bookkeeping/);
});

test('046: Menu toggle is delegated (the script sits above the bottom bar, so it must not query it directly)', () => {
  const html = layout('/dashboard');
  const script = html.slice(html.indexOf("getElementById('menu-sheet')") - 200, html.indexOf('</script>', html.indexOf("getElementById('menu-sheet')")));
  assert.match(script, /document\.addEventListener\('click'/);
  assert.ok(!/toggles\.forEach\(function \(t\) \{\s*t\.addEventListener/.test(script));
});

test('046: brand colours are emerald / brass and the old green/gold are gone from shipped assets', () => {
  assert.match(css, /--brand: #2A4D3A;/i);
  assert.match(css, /--gold: #C4A35A;/i);
  assert.match(css, /--bg: #f5f5f5;/i);
  assert.match(css, /--ink: #1a1a1a;/i);
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.json'), 'utf8');
  for (const [name, text] of [['css', css], ['manifest', manifest], ['render', fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8')]]) {
    assert.ok(!/#1e3d22|#d9a628/i.test(text), `${name} still has the old green/gold`);
  }
});

test('046: header logo is 44px on phone; only logo.png is used (no invented wordmark files)', () => {
  assert.match(css, /\.brand-logo img \{ display: block; height: 44px;/);
  const imgs = fs.readdirSync(path.join(__dirname, '..', 'public', 'img')).sort();
  assert.deepEqual(imgs, ['apple-touch-icon.png', 'favicon-16.png', 'favicon-32.png', 'favicon.ico', 'logo.png', 'readme.md']);
});

// ---------------------------------------------------------------- 028 ET display
test('028: fmtDateTime is Eastern and ends with ET, whatever zone the server is in', () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(plain(util.fmtDateTime('2026-09-20T18:14:00.000Z')), 'Sep 20, 2026, 2:14 PM ET', tz); // EDT
      assert.equal(plain(util.fmtDateTime('2026-01-15T17:00:00.000Z')), 'Jan 15, 2026, 12:00 PM ET', tz); // EST
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test('028: fmtDateTime handles empty / invalid input, and stored timestamps are not rewritten', () => {
  assert.equal(util.fmtDateTime(''), '');
  assert.equal(util.fmtDateTime(null), '');
  assert.equal(util.fmtDateTime('not a date'), 'not a date');
  const iso = '2026-09-20T18:14:00.000Z';
  const c = db.createCustomer({ name: 'ET Storage Check' });
  const a = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: iso });
  assert.equal(db.getAppointment(a.id).scheduled_at, iso, 'DB keeps UTC ISO exactly as written');
});

// ---------------------------------------------------------------- 047 Assistant clock
test('047: fmtNowET matches the spec format "Sun 9/20 2:14p ET"', () => {
  assert.equal(util.fmtNowET(new Date('2026-09-20T18:14:00.000Z')), 'Sun 9/20 2:14p ET');
  assert.equal(util.fmtNowET(new Date('2026-01-05T14:05:00.000Z')), 'Mon 1/5 9:05a ET');
  assert.equal(util.fmtNowET(new Date('2026-09-21T04:00:00.000Z')), 'Mon 9/21 12:00a ET'); // midnight ET
  assert.equal(util.fmtNowET(new Date('2026-09-20T16:00:00.000Z')), 'Sun 9/20 12:00p ET'); // noon ET
});

test('047: every systemPrompt carries the clock - text, voice - and says never to read it aloud', () => {
  const now = new Date('2026-09-20T18:14:00.000Z');
  const text = assistant.systemPrompt({ now });
  const voice = assistant.systemPrompt({ mode: 'voice', now });
  for (const p of [text, voice]) {
    assert.ok(p.includes('Now: Sun 9/20 2:14p ET'));
    assert.match(p, /Never read it aloud/);
  }
  assert.ok(voice.includes('VOICE MODE'));
  // live clock when no override is given
  assert.match(assistant.systemPrompt(), /Now: \w{3} \d{1,2}\/\d{1,2} \d{1,2}:\d{2}[ap] ET/);
});

// ---------------------------------------------------------------- 001 Kill leftover Lost
// A legacy row exactly like Kelly Pierce's: written straight to SQLite, because
// nothing in the app can create a Lost lead any more.
const { DatabaseSync } = require('node:sqlite');
const { tmpDbPath } = require('./helpers');
function seedLegacyLostLead(customerId) {
  const raw = new DatabaseSync(tmpDbPath);
  const id = require('crypto').randomUUID();
  const ts = '2026-08-11T12:00:00.000Z';
  raw
    .prepare(`INSERT INTO leads (id, customer_id, stage, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, customerId, 'Lost', 'Setmore import', 'legacy row', ts, ts);
  raw.close();
  return id;
}

test('001: Lost is not a lead stage; only the three open stages + Sold remain', () => {
  assert.deepEqual(db.LEAD_STAGES, ['New Lead', 'Contacted', 'Quoted', 'Sold']);
  assert.deepEqual(db.OPEN_LEAD_STAGES, ['New Lead', 'Contacted', 'Quoted']);
});

test('001: nothing can create or set a Lost lead (db layer)', () => {
  const c = db.createCustomer({ name: 'No Lost Here' });
  assert.throws(() => db.createLead({ customer_id: c.id, stage: 'Lost' }), /Unknown lead stage/);
  const lead = db.createLead({ customer_id: c.id, stage: 'Contacted' });
  assert.throws(() => db.updateLeadStage(lead.id, 'Lost'), /Unknown lead stage/);
  assert.equal(db.getLead(lead.id).stage, 'Contacted', 'a rejected change leaves the row alone');
  assert.equal(db.updateLeadStage(lead.id, 'Quoted').stage, 'Quoted');
  assert.throws(() => db.setSalesStage(c.id, 'Lost', { actor: 'user' }));
});

test('001: assistant lead tools no longer offer Lost, reject it if sent anyway, and the prompt keeps the guardrail', () => {
  for (const name of ['create_lead', 'update_lead']) {
    const tool = assistant.TOOLS.find((t) => t.name === name);
    assert.deepEqual(tool.input_schema.properties.stage.enum, ['New Lead', 'Contacted', 'Quoted', 'Sold']);
  }
  const c = db.createCustomer({ name: 'Assistant Lost Check' });
  const created = assistant.runTool('create_lead', { customer_id: c.id, stage: 'Lost' });
  assert.match(created.error || '', /Unknown lead stage/);
  const lead = db.createLead({ customer_id: c.id });
  const updated = assistant.runTool('update_lead', { lead_id: lead.id, stage: 'Lost' });
  assert.match(updated.error || '', /Unknown lead stage/);
  assert.equal(db.getLead(lead.id).stage, 'New Lead');
  assert.match(assistant.systemPrompt(), /There is NO "Lost" and no "Inquiry" stage/);
  assert.match(assistant.TOOLS.find((t) => t.name === 'set_sales_stage').description, /NO 'Lost'/);
});

test('001: an old Lost lead row is left exactly as it is, and is never reopened by a new booking', async () => {
  const pub = require('../src/routes/public');
  const c = db.createCustomer({ name: 'Legacy Kelly', phone: '+13015550111', email: 'legacy.kelly@example.com', address: '1 Main St, Richmond, VA 23220' });
  const lostId = seedLegacyLostLead(c.id);
  const before = { ...db.getLead(lostId) };
  assert.equal(before.stage, 'Lost');

  // any weekday ~3 weeks out at 10:00 local
  const d = new Date();
  d.setDate(d.getDate() + 21);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const r = await pub.createBooking({
    name: 'Legacy Kelly',
    phone: '+13015550111',
    email: 'legacy.kelly@example.com',
    address: '1 Main St, Richmond, VA 23220',
    slotIso: d.toISOString(),
    type: 'Short Design Consultation',
    actor: 'public',
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.deepEqual({ ...db.getLead(lostId) }, before, 'the legacy Lost row is untouched (no history rewrite)');
  const mine = db.listLeads().filter((l) => l.customer_id === c.id);
  assert.equal(mine.length, 2, 'booking made a fresh lead instead of reusing the old one');
  assert.ok(mine.some((l) => l.id !== lostId && l.stage === 'Contacted'));
  // it is still readable in lists (Kelly's row does not disappear)
  assert.ok(db.listLeads().some((l) => l.id === lostId && l.stage === 'Lost'));
});

test('001: README and legacy seed script no longer advertise Lost', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!/Sold\s*→\s*Lost/.test(readme));
  assert.match(readme, /There is no "Lost" stage/);
  const seed = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'import-customers.js'), 'utf8');
  assert.ok(!/stage:\s*'Lost'/.test(seed));
});

// ---------------------------------------------------------------- 022 Booking service tap
// Run the real restore script from publicLayout against a stubbed browser.
function runPublicScrollScript({ hash, savedPos }) {
  const vm = require('node:vm');
  const html = render.publicLayout({ title: 'Book', body: '' });
  const scriptSrc = html.match(/<script>\s*\(function\(\) \{\s*\/\/ A link that carries a #fragment[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
  const calls = { scrollTo: [], intoView: [], removed: [] };
  const listeners = { window: {}, document: {} };
  const el = { scrollIntoView: (o) => calls.intoView.push(o) };
  const sandbox = {
    window: {
      location: { hash },
      scrollTo: (x, y) => calls.scrollTo.push(y),
      addEventListener: (n, f) => ((listeners.window[n] = listeners.window[n] || []).push(f)),
    },
    document: {
      getElementById: (id) => (id === 'step-contact' ? el : null),
      addEventListener: (n, f) => ((listeners.document[n] = listeners.document[n] || []).push(f)),
    },
    localStorage: {
      getItem: () => savedPos,
      removeItem: (k) => calls.removed.push(k),
    },
    decodeURIComponent,
    parseInt,
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.runInNewContext(scriptSrc, sandbox);
  for (const f of listeners.document.DOMContentLoaded || []) f();
  for (const f of listeners.window.load || []) f();
  return calls;
}

test('022: a #step-contact link is NOT overridden by the saved scroll position', () => {
  const c = runPublicScrollScript({ hash: '#step-contact', savedPos: '319' });
  assert.deepEqual(c.scrollTo, [], 'must not scrollTo the old position');
  assert.equal(c.intoView.length, 1, 'lands on the section instead');
  assert.equal(c.intoView[0].block, 'start');
  assert.deepEqual(c.removed, ['__bos_scroll'], 'stale saved position is dropped');
});

test('022: with no #fragment the saved scroll position is still restored (existing behaviour kept)', () => {
  const c = runPublicScrollScript({ hash: '', savedPos: '250' });
  assert.deepEqual(c.scrollTo, [250, 250]);
  assert.equal(c.intoView.length, 0);
});

test('022: the book page still links each service card to #step-contact', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');
  assert.match(src, /href="\/book\?\$\{keep\}#step-contact"/);
});

test('022: selected beats featured in the stylesheet (later rule + compound selector) and shows a Selected chip', () => {
  const featuredAt = css.indexOf('.type-card.featured {');
  const selectedAt = css.indexOf('.type-card.selected,\n.type-card.featured.selected');
  const selectedAtCrlf = css.indexOf('.type-card.selected,\r\n.type-card.featured.selected');
  const at = selectedAt !== -1 ? selectedAt : selectedAtCrlf;
  assert.ok(featuredAt !== -1 && at !== -1, 'both rules exist');
  assert.ok(at > featuredAt, '.selected is declared after .featured');
  assert.match(css, /\.type-card\.selected::after \{[^}]*Selected/);
  assert.match(css, /#step-contact, #step-times \{ scroll-margin-top/);
});

// ---------------------------------------------------------------- 023 Needs Attention layout
const { startServer } = require('./http-helper');
let app;
test.before(async () => {
  app = await startServer();
});
test.after(async () => {
  if (app) await app.stop();
});

// The rows of one follow-up card, in DOM order, as short tokens.
function attnStructure(cardHtml) {
  const tokens = [];
  const re = /class="(attn-what(?: overdue)?|attn-row attn-decide|attn-row attn-own)"|<label[^>]*>([^<]+)<\/label>|<input[^>]*type="(date|text)"[^>]*>|<button[^>]*>([^<]+)<\/button>/g;
  let m;
  while ((m = re.exec(cardHtml))) {
    if (m[1]) tokens.push(m[1].replace(' overdue', ''));
    else if (m[2]) tokens.push('label:' + m[2]);
    else if (m[3]) tokens.push('input:' + m[3]);
    else if (m[4]) tokens.push('button:' + m[4]);
  }
  return tokens;
}
const cardFor = (html, title) => {
  const cards = html.split('<div class="attn-item">').slice(1);
  const card = cards.find((c) => c.includes(title));
  if (!card) return card;
  // a card ends with its "Waiting on" form
  return card.slice(0, card.indexOf('</form>', card.indexOf('/waiting"')) + '</form>'.length);
};

const EXPECTED_ATTN = [
  'attn-what',
  'attn-row attn-decide', 'button:Done', 'button:Dismiss',
  'attn-row attn-own', 'label:Snooze to', 'input:date', 'button:Snooze',
  'attn-row attn-own', 'label:Waiting on', 'input:text', 'button:Save',
];

test('023: Needs Attention item = who/what/due, Done | Dismiss, "Snooze to" date, "Waiting on" text', async () => {
  const c = db.createCustomer({ name: 'Attn Layout Person' });
  const f = db.createFollowup({ customer_id: c.id, kind: 'next_action', title: 'Send the layout estimate', due_at: new Date(Date.now() - 3 * 86400000).toISOString(), created_by: 't' });
  db.setFollowupWaiting(f.id, 'Supplier quote', 't');

  const overview = await (await app.get('/dashboard')).text();
  const card = cardFor(overview, 'Send the layout estimate');
  assert.ok(card, 'follow-up shows on the Overview');
  assert.deepEqual(attnStructure(card), EXPECTED_ATTN);
  assert.match(card, /Attn Layout Person<\/a> — Send the layout estimate · 3 days overdue/);
  assert.match(card, /attn-what overdue/);
  assert.match(card, /waiting on: Supplier quote/, 'waiting-on stays visible at a glance in row 1');
  // Snooze's date lives INSIDE the snooze form; the waiting text lives INSIDE the waiting form.
  const snoozeForm = card.match(/<form[^>]*\/snooze"[\s\S]*?<\/form>/)[0];
  const waitForm = card.match(/<form[^>]*\/waiting"[\s\S]*?<\/form>/)[0];
  assert.match(snoozeForm, /type="date" name="due_at"/);
  assert.ok(!/type="text"/.test(snoozeForm));
  assert.match(waitForm, /type="text" name="waiting_on" value="Supplier quote"/);
  assert.ok(!/type="date"/.test(waitForm));
  // Overview actions come back to the Overview
  assert.equal((card.match(/name="return_to" value="\/dashboard"/g) || []).length, 4);
});

test('023: the customer page uses the same layout', async () => {
  const c = db.createCustomer({ name: 'Attn Customer Page' });
  db.createFollowup({ customer_id: c.id, kind: 'next_action', title: 'Drop off the referral cards', due_at: null, created_by: 't' });
  const html = await (await app.get(`/dashboard/customers/${c.id}`)).text();
  const card = cardFor(html, 'Drop off the referral cards');
  assert.ok(card, 'follow-up shows on the customer page');
  assert.deepEqual(attnStructure(card), EXPECTED_ATTN);
  assert.ok(!/name="return_to"/.test(card), 'customer page falls back to returning to the customer');
});

test('023: Snooze saves the picked date as that same calendar day, Waiting on saves its text', async () => {
  const c = db.createCustomer({ name: 'Attn Snooze Person' });
  const f = db.createFollowup({ customer_id: c.id, kind: 'next_action', title: 'Snooze me', due_at: null, created_by: 't' });
  let r = await app.post(`/dashboard/followups/${f.id}/snooze`, { due_at: '2026-10-05', return_to: '/dashboard' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/dashboard\?ok=/);
  assert.equal(db.getFollowup(f.id).due_at, '2026-10-05T12:00:00.000Z');
  // ...and it displays as Oct 5 in Eastern, not Oct 4
  assert.match(plain(util.fmtDateTime(db.getFollowup(f.id).due_at)), /^Oct 5, 2026/);

  r = await app.post(`/dashboard/followups/${f.id}/waiting`, { waiting_on: 'Client signature' });
  assert.equal(r.status, 302);
  assert.equal(db.getFollowup(f.id).waiting_on, 'Client signature');
  r = await app.post(`/dashboard/followups/${f.id}/close`, { status: 'dismissed' });
  assert.equal(db.getFollowup(f.id).status, 'dismissed');
});

test('023: dateInputToIso - date-only means noon UTC (same ET calendar day), junk is ignored', () => {
  assert.equal(util.dateInputToIso('2026-09-25'), '2026-09-25T12:00:00.000Z');
  assert.equal(util.dateInputToIso('2026-01-05'), '2026-01-05T12:00:00.000Z');
  assert.equal(util.dateInputToIso(''), null);
  assert.equal(util.dateInputToIso(undefined), null);
  assert.equal(util.dateInputToIso('nonsense'), null);
  assert.equal(util.dateInputToIso('2026-09-25T09:30'), new Date('2026-09-25T09:30').toISOString());
});

// ---------------------------------------------------------------- 025 Files search live
test('025: listRecentFiles is newest-first, capped at 50, skips soft-deleted, keeps unassigned (Needs Review) files', () => {
  const c = db.createCustomer({ name: 'Recent Files Customer' });
  const made = [];
  for (let i = 1; i <= 55; i++) made.push(db.createCustomerFile({ customer_id: c.id, stored_name: `r${i}.pdf`, original_name: `recent-${String(i).padStart(2, '0')}.pdf`, note: `note ${i}` }));
  const orphan = db.createCustomerFile({ customer_id: null, stored_name: 'orphan.pdf', original_name: 'orphan-needs-review.pdf', assignment_status: 'needs_review' });
  db.softDeleteCustomerFile(made[54], 'test'); // newest of the 55 - must vanish

  const recent = db.listRecentFiles();
  assert.equal(recent.length, 50);
  assert.equal(recent[0].id, orphan, 'newest first');
  assert.equal(recent[1].original_name, 'recent-54.pdf', 'soft-deleted recent-55 is skipped');
  assert.ok(!recent.some((f) => f.id === made[54]));
  assert.equal(recent[0].customer_name, null, 'unassigned files are included, with no customer');
  assert.equal(db.listRecentFiles(3).length, 3);
});

test('025: /dashboard/files/results - empty q shows recent files, q searches, HTML in q is escaped', async () => {
  let html = await (await app.get('/dashboard/files/results?q=')).text();
  assert.ok(!/<html|<body/i.test(html), 'a fragment, not a full page');
  assert.match(html, /Recent files \(newest first\)/);
  assert.equal((html.match(/<tr>(?!<th)/g) || []).length, 50, 'about 50 recent rows');
  assert.match(html, /recent-54\.pdf/);
  assert.ok(!/recent-55\.pdf/.test(html), 'soft-deleted file not listed');
  assert.match(html, /href="#needs-review">Needs review<\/a>/, 'unassigned file points at the Needs Review panel');
  assert.ok(!/customers\/null\//.test(html), 'no broken link for a file with no customer');

  // prefix matching = "as they type": "recent-3" finds recent-30..39
  const res = await app.get('/dashboard/files/results?q=' + encodeURIComponent('recent-3'));
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /\d+ matches? for &ldquo;recent-3&rdquo;/);
  assert.match(html, /recent-30\.pdf/);
  assert.ok(!/recent-41\.pdf/.test(html));

  html = await (await app.get('/dashboard/files/results?q=' + encodeURIComponent('zzz-nothing'))).text();
  assert.match(html, /No files matched for &ldquo;zzz-nothing&rdquo;/);

  html = await (await app.get('/dashboard/files/results?q=' + encodeURIComponent('<script>alert(1)</script>'))).text();
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'query is escaped');
});

test('025: Files page filters live (150ms debounce, no submit needed), keeps Needs Review, starts with recent files', async () => {
  const html = await (await app.get('/dashboard/files')).text();
  assert.match(html, /addEventListener\('input'[\s\S]*setTimeout\(run, 150\)/);
  assert.match(html, /fetch\('\/dashboard\/files\/results\?q='/);
  assert.match(html, /id="needs-review"/, 'Needs Review panel is kept');
  assert.match(html, /Needs review \(1\)/);
  assert.match(html, /Recent files \(newest first\)/, 'a first visit is not empty');
  assert.ok(!/Type something above to search/.test(html));
  // a bookmarked ?q= still server-renders its results (works without JS too)
  const q = await (await app.get('/dashboard/files?q=recent-3')).text();
  assert.match(q, /matches? for &ldquo;recent-3&rdquo;/);
  assert.match(q, /value="recent-3"/);
});

// ---------------------------------------------------------------- 033 Estimated install date
test('033: migration adds estimated_install_at to an existing jobs table and leaves its rows alone', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const legacy = path.join(os.tmpdir(), `bos-legacy-jobs-${process.pid}-${Date.now()}.sqlite3`);
  const raw = new DatabaseSync(legacy);
  raw.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, lead_id TEXT, customer_id TEXT NOT NULL, public_token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'Order Confirmed', sold_amount REAL, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO customers (id, name, created_at) VALUES ('c1', 'Old Customer', '2026-08-01T00:00:00Z');
    INSERT INTO jobs (id, customer_id, public_token, status, sold_amount, created_at, updated_at)
      VALUES ('j1', 'c1', 'tok1', 'Measured', 7365, '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z');
  `);
  raw.close();
  const script = `
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db.js'))});
    const j = db.getJob('j1');
    console.log(JSON.stringify({ status: j.status, sold: j.sold_amount, est: j.estimated_install_at, has: 'estimated_install_at' in j }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, BOS_DB_PATH: legacy }, encoding: 'utf8' });
  for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(legacy + suffix); } catch {}
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { status: 'Measured', sold: 7365, est: null, has: true });
});

test('033: a new job has no estimated install; setting, changing, clearing, and a bad date all behave', () => {
  const c = db.createCustomer({ name: 'Install Estimate Person' });
  const job = db.createJob({ customer_id: c.id, sold_amount: 5000 });
  assert.equal(job.estimated_install_at, null, 'blank is OK');

  let j = db.updateJobEstimatedInstall(job.id, '2026-10-05', 'user:test');
  assert.equal(j.estimated_install_at, '2026-10-05T12:00:00.000Z');
  assert.match(plain(util.fmtDate(j.estimated_install_at)), /Oct 5, 2026/);

  j = db.updateJobEstimatedInstall(job.id, '2026-10-19', 'user:test');
  assert.equal(j.estimated_install_at, '2026-10-19T12:00:00.000Z');
  // same value again -> no change, no extra audit row
  db.updateJobEstimatedInstall(job.id, '2026-10-19', 'user:test');
  const audit = db.listActivityForCustomer(c.id).filter((a) => a.entity_id === job.id && a.field === 'estimated_install_at');
  assert.equal(audit.length, 2, 'set + change audited, the no-op is not');
  assert.equal(audit[0].actor, 'user:test');

  assert.throws(() => db.updateJobEstimatedInstall(job.id, 'next-ish', 'user:test'), /valid date/);
  assert.equal(db.getJob(job.id).estimated_install_at, '2026-10-19T12:00:00.000Z', 'a bad date changes nothing');

  j = db.updateJobEstimatedInstall(job.id, '', 'user:test');
  assert.equal(j.estimated_install_at, null, 'blank clears it');
  assert.equal(db.getJob(job.id).sold_amount, 5000, 'nothing else on the job moved');
  assert.equal(db.updateJobEstimatedInstall('no-such-job', '2026-10-05'), null);
});

test('033: never auto-filled - job status changes (incl. Measured) leave it blank', () => {
  const c = db.createCustomer({ name: 'No Autofill Person' });
  const job = db.createJob({ customer_id: c.id });
  for (const s of ['Measuring Scheduled', 'Measured', 'In Production', 'Install Scheduled']) {
    db.updateJobStatus(job.id, s, null);
    assert.equal(db.getJob(job.id).estimated_install_at, null, `after ${s}`);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const setters = src.match(/estimated_install_at\s*=/g) || [];
  assert.equal(setters.length, 1, 'exactly one place writes the column');
});

test('033: job page shows it and lets you change / clear it; the customer status page does not expose it', async () => {
  const c = db.createCustomer({ name: 'Job Page Person' });
  const job = db.createJob({ customer_id: c.id });
  let html = await (await app.get(`/dashboard/jobs/${job.id}`)).text();
  assert.match(html, /Estimated install:<\/strong> not set/);
  assert.match(html, new RegExp(`action="/dashboard/jobs/${job.id}/estimated-install"`));

  let r = await app.post(`/dashboard/jobs/${job.id}/estimated-install`, { estimated_install_at: '2026-11-03' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\?ok=Estimated/);
  html = await (await app.get(`/dashboard/jobs/${job.id}`)).text();
  assert.match(html, /Estimated install:<\/strong> Nov 3, 2026/);
  assert.match(html, /name="estimated_install_at" value="2026-11-03"/);

  const pub = await (await app.get(`/status/${job.public_token}`)).text();
  assert.ok(!/stimated install|Nov 3, 2026/.test(pub), 'internal estimate is not on the customer page');

  r = await app.post(`/dashboard/jobs/${job.id}/estimated-install`, { estimated_install_at: 'garbage' });
  assert.match(decodeURIComponent(r.headers.get('location')), /\?err=Not a valid date/);
  assert.equal(db.getJob(job.id).estimated_install_at, '2026-11-03T12:00:00.000Z');

  r = await app.post(`/dashboard/jobs/${job.id}/estimated-install`, { estimated_install_at: '' });
  assert.equal(db.getJob(job.id).estimated_install_at, null);
  assert.equal((await app.post('/dashboard/jobs/nope/estimated-install', {})).status, 404);
});
