const fs = require('fs');
const path = require('path');
const db = require('../db');
const { dashboardLayout, flashFromQuery, quickActions, section, backLink, phone } = require('../render');
const {
  escapeHtml,
  fmtMoney,
  fmtDate,
  fmtDateTime,
  fmtRelativeDue,
  normalizePhone,
  formatPhone,
  telHref,
  newId,
} = require('../util');
const automations = require('../services/automations');
const assistant = require('../services/assistant');
const sms = require('../services/sms');
const email = require('../services/email');

// Who's making this change - for the activity log. Session middleware sets
// req.authUser; assistant calls pass their own actor directly to db.*.
function actorOf(req) {
  return `user:${(req && req.authUser) || 'andrew'}`;
}

// Derives the "what needs attention" list for a customer from open follow-ups,
// past-due appointments, and attention sub-statuses. Pure read - it never
// changes state. Returns [{ text, overdue, href? }].
function attentionForCustomer(c) {
  const items = [];
  for (const f of db.listFollowups(c.id)) {
    const overdue = f.due_at && new Date(f.due_at) < new Date();
    items.push({
      text: `${f.title}${f.due_at ? ' — ' + fmtRelativeDue(f.due_at) : ''}`,
      overdue: !!overdue,
      followupId: f.id,
    });
  }
  const appts = db.listAppointmentsForCustomer(c.id);
  for (const a of appts) {
    if (a.status === 'scheduled' && new Date(a.scheduled_at) < new Date()) {
      items.push({ text: `Missed appointment: ${a.type} on ${fmtDateTime(a.scheduled_at)} — needs complete / reschedule / cancel`, overdue: true, apptId: a.id });
    }
  }
  const sub = (c.stage_substatus || '').toLowerCase();
  if (sub.includes('overdue') || sub.includes('missed') || sub.includes('reschedule')) {
    items.push({ text: `Stage flag: ${c.stage_substatus}`, overdue: true });
  } else if (sub.includes('due')) {
    items.push({ text: `Stage flag: ${c.stage_substatus}`, overdue: false });
  }
  return items;
}

function attentionBanner(items) {
  if (!items.length) return '';
  return `<div class="attention">
    <h3>Needs attention</h3>
    <ul>${items.map((i) => `<li class="${i.overdue ? 'overdue' : ''}">${escapeHtml(i.text)}</li>`).join('')}</ul>
  </div>`;
}

// Uploaded customer files (photos, measurement docs, contracts) live on the
// persistent disk under data/uploads/<customer_id>/<generated-name> - never
// under a web-servable static path, since these are private records only
// reachable through the authenticated download route below.
const UPLOADS_DIR = path.join(db.DATA_DIR, 'uploads');
function customerUploadsDir(customerId) {
  const dir = path.join(UPLOADS_DIR, customerId || '_unassigned');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Writes an uploaded file (from router's multipart parser - { filename,
// mimeType, data: Buffer }) to disk under the owning customer's folder and
// records it in customer_files, optionally tagged to a job. Returns the new
// file id. Shared by the customer Files panel, the job Files panel, and the
// Assistant chat upload.
function saveUpload({ customer_id, job_id, upload, note, assignment_status, suggested_customer_id }) {
  const ext = path.extname(upload.filename || '') || '';
  const storedName = `${newId()}${ext}`;
  fs.writeFileSync(path.join(customerUploadsDir(customer_id), storedName), upload.data);
  return db.createCustomerFile({
    customer_id,
    job_id: job_id || null,
    stored_name: storedName,
    original_name: upload.filename || storedName,
    mime_type: upload.mimeType || null,
    size: upload.data.length,
    note: note || null,
    assignment_status,
    suggested_customer_id,
  });
}


// Renders a <select name="category"> populated from that category's editable
// option list (see /dashboard/settings/product-options), plus a blank
// "-- none --" first choice since these specs are all optional.
function optionSelect(category, selected) {
  const opts = db.listProductOptions(category);
  return `<select name="${category}">
    <option value="">-- none --</option>
    ${opts.map((o) => `<option value="${escapeHtml(o.code)}" ${o.code === selected ? 'selected' : ''}>${escapeHtml(o.label || o.code)}</option>`).join('')}
  </select>`;
}

function register(router, requireAuth) {
  // ---------- Overview ----------
  router.get('/dashboard', requireAuth, (req, res) => {
    const customers = db.listCustomers();
    const jobs = db.listJobs();
    const activeJobs = jobs.filter((j) => j.status !== 'Complete');
    const openOpps = customers.filter((c) => c.sales_stage && c.sales_stage !== 'Sold' && c.sales_stage !== 'Closed / We Declined Customer');
    const upcoming = db.listAppointments({ upcomingOnly: true }).slice(0, 6);
    const incomeMonth = db.totalIncomeThisMonth();
    const incomeTotal = db.totalIncome();
    const expenseMonth = db.totalExpensesThisMonth();
    const expenseTotal = db.totalExpenses();
    const needsReview = db.listUncategorizedExpenses().length;

    // Attention: open follow-ups (overdue first) + missed appointments.
    const openF = db.listOpenFollowups();
    const missed = db.listPastUncompletedAppointments();
    const attn = [
      ...openF.map((f) => ({
        overdue: f.due_at && new Date(f.due_at) < new Date(),
        html: `<a href="/dashboard/customers/${f.customer_id}">${escapeHtml(f.customer_name)}</a> — ${escapeHtml(f.title)}${f.due_at ? ' · ' + escapeHtml(fmtRelativeDue(f.due_at)) : ''}`,
      })),
      ...missed.map((a) => ({
        overdue: true,
        html: `<a href="/dashboard/customers/${a.customer_id}">${escapeHtml(a.customer_name)}</a> — missed ${escapeHtml(a.type)} ${fmtDateTime(a.scheduled_at)} · <a href="/dashboard/appointments/${a.id}/edit">resolve</a>`,
      })),
    ].sort((x, y) => (y.overdue ? 1 : 0) - (x.overdue ? 1 : 0));

    const body = `
      <h1>Overview</h1>
      <p class="subtitle">${escapeHtml(require('../render').BUSINESS_NAME)} at a glance</p>
      <div class="grid cols-4">
        <div class="stat"><div class="num">${customers.length}</div><div class="label">Customers</div></div>
        <div class="stat"><div class="num">${openOpps.length}</div><div class="label">Open opportunities</div></div>
        <div class="stat"><div class="num">${activeJobs.length}</div><div class="label">Active jobs</div></div>
        <div class="stat"><div class="num">${fmtMoney(incomeMonth - expenseMonth)}</div><div class="label">Net this month</div></div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Needs attention ${attn.length ? `<span class="badge">${attn.length}</span>` : ''}</h2>
        ${
          attn.length
            ? `<ul style="margin:0;padding-left:18px">${attn
                .slice(0, 25)
                .map((i) => `<li class="${i.overdue ? 'overdue' : ''}" style="margin:4px 0">${i.html}</li>`)
                .join('')}</ul>`
            : '<p class="attention-none">Nothing needs action right now.</p>'
        }
        ${needsReview ? `<p class="subtitle" style="margin-top:10px">${needsReview} expense${needsReview > 1 ? 's' : ''} need categorizing — <a href="/dashboard/finances/review">review</a>.</p>` : ''}
      </div>

      <div class="grid cols-2">
        <div class="panel">
          <h2 style="margin-top:0">Upcoming appointments</h2>
          ${
            upcoming.length
              ? `<table><tr><th>When</th><th>Customer</th><th>Type</th></tr>${upcoming
                  .map(
                    (a) =>
                      `<tr><td>${fmtDateTime(a.scheduled_at)}</td><td><a href="/dashboard/customers/${a.customer_id}">${escapeHtml(a.customer_name)}</a></td><td>${escapeHtml(a.type)}</td></tr>`
                  )
                  .join('')}</table>`
              : `<p class="subtitle">None scheduled. <a href="/dashboard/appointments">Add one</a> or share your <a href="/dashboard/booking-link">booking link</a>.</p>`
          }
        </div>
        <div class="panel">
          <h2 style="margin-top:0">Recent activity</h2>
          ${(() => {
            const acts = db.listRecentActivity(10);
            return acts.length
              ? `<table><tr><th>When</th><th>Customer</th><th>What</th></tr>${acts
                  .map(
                    (a) =>
                      `<tr><td>${fmtDateTime(a.created_at)}</td><td>${a.customer_id ? `<a href="/dashboard/customers/${a.customer_id}">${escapeHtml(a.customer_name || '')}</a>` : ''}</td><td>${escapeHtml(a.field || a.entity_type)}${a.new_value ? ': ' + escapeHtml(String(a.new_value).slice(0, 40)) : ''}</td></tr>`
                  )
                  .join('')}</table>`
              : '<p class="subtitle">No activity yet.</p>';
          })()}
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Lifetime</h2>
        <p style="font-size:1.4rem;font-weight:700;margin:0">${fmtMoney(incomeTotal - expenseTotal)} net &nbsp; <span style="font-size:0.9rem;font-weight:400;color:var(--muted)">(${fmtMoney(incomeTotal)} income &minus; ${fmtMoney(expenseTotal)} expenses)</span></p>
        <p class="subtitle" style="margin-bottom:0">See <a href="/dashboard/finances">Bookkeeping</a> for income, expenses, and P&amp;L / cash flow / tax reports.</p>
      </div>
    `;
    res.send(dashboardLayout({ title: 'Overview', active: '/dashboard', body, flash: flashFromQuery(req.query) }));
  });

  // ---------- Customers ----------
  router.get('/dashboard/customers', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    let customers = db.listCustomers();
    if (q) {
      customers = customers.filter((c) =>
        [c.name, c.phone, c.email, c.address].filter(Boolean).some((f) => String(f).toLowerCase().includes(q))
      );
    }
    const body = `
      <h1>Customers</h1>
      <div class="panel">
        <form method="GET" action="/dashboard/customers" style="margin-bottom:14px">
          <div style="display:flex;gap:8px">
            <input type="search" name="q" value="${escapeHtml(req.query.q || '')}" placeholder="Search name, phone, email, address">
            <button class="btn secondary" type="submit">Search</button>
          </div>
        </form>
        <details ${q ? '' : ''}>
          <summary style="cursor:pointer;font-weight:700">Add a customer</summary>
          <form method="POST" action="/dashboard/customers" style="margin-top:10px">
            <div class="grid cols-2">
              <div><label>Name *</label><input type="text" name="name" required></div>
              <div><label>Phone</label><input type="tel" name="phone" placeholder="(804) 555-0100"></div>
              <div><label>Email</label><input type="email" name="email"></div>
              <div><label>Address</label><input type="text" name="address"></div>
              <div><label>Source</label><select name="source_id"><option value="">— none —</option>${db.listSources().map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></div>
              <div><label>Campaign</label><select name="campaign_id"><option value="">— none —</option>${db.listCampaigns().map((mc) => `<option value="${mc.id}">${escapeHtml(mc.source_name || '')} — ${escapeHtml(mc.name)}</option>`).join('')}</select></div>
            </div>
            <label>Notes</label><textarea name="notes"></textarea>
            <div style="margin-top:12px"><button class="btn" type="submit">Add customer</button></div>
          </form>
        </details>
      </div>
      <div class="panel">
        <div style="overflow-x:auto"><table>
          <tr><th>Name</th><th>Stage</th><th>Phone</th><th>Email</th><th>Added</th></tr>
          ${customers
            .map(
              (c) =>
                `<tr>
                  <td><a href="/dashboard/customers/${c.id}">${escapeHtml(c.name)}</a>${c.dormant ? ' <span class="badge">dormant</span>' : ''}</td>
                  <td>${escapeHtml(c.sales_stage || '')}${c.stage_substatus ? `<div class="subtitle" style="margin:0">${escapeHtml(c.stage_substatus)}</div>` : ''}</td>
                  <td>${c.phone ? `<a href="tel:${escapeHtml(telHref(c.phone))}">${phone(c.phone)}</a>` : ''}</td>
                  <td>${escapeHtml(c.email || '')}</td>
                  <td>${fmtDate(c.first_contact_at || c.created_at)}</td>
                </tr>`
            )
            .join('')}
        </table></div>
        ${customers.length === 0 ? '<p class="subtitle">No customers found.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Customers', active: '/dashboard/customers', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/customers', requireAuth, (req, res) => {
    const { name, phone: ph, email: em, address, notes, source_id, campaign_id } = req.body;
    if (!name) return res.redirect('/dashboard/customers?err=Name is required');
    const c = db.createCustomer({
      name,
      phone: normalizePhone(ph),
      email: em,
      address,
      notes,
      source_id: source_id || null,
      campaign_id: campaign_id || null,
      actor: actorOf(req),
    });
    res.redirect(`/dashboard/customers/${c.id}?ok=Customer added`);
  });

  router.get('/dashboard/customers/:id', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const jobs = db.listJobs().filter((j) => j.customer_id === c.id);
    const activeJobs = jobs.filter((j) => j.status !== 'Complete');
    const appts = db.listAppointmentsForCustomer(c.id);
    const messages = db.listMessagesForCustomer(c.id).slice().reverse();
    const files = db.listCustomerFiles(c.id);
    const followups = db.listFollowups(c.id, { includeClosed: true });
    const openFollowups = followups.filter((f) => f.status === 'open');
    const attribution = db.getCustomerAttribution(c.id);
    const activity = db.listActivityForCustomer(c.id, 60);
    const stageHistory = db.getCustomerStageHistory(c.id);
    const attention = attentionForCustomer(c);
    const sources = db.listSources();
    const campaigns = db.listCampaigns();
    const stage = c.sales_stage || 'Bona Fide Lead';
    const subOptions = db.STAGE_SUBSTATUSES[stage] || [];
    const smsOn = sms.twilioConfigured();
    const emailOn = email.emailConfigured();

    const stageForm = `
      <form method="POST" action="/dashboard/customers/${c.id}/stage" class="stage-form">
        <div class="grid cols-2">
          <div>
            <label>Sales stage (KPI)</label>
            <select name="sales_stage">
              ${db.SALES_STAGES.map((s) => `<option value="${escapeHtml(s)}" ${s === stage ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Attention sub-status</label>
            <select name="stage_substatus">
              <option value="">— none —</option>
              ${subOptions.map((s) => `<option value="${escapeHtml(s)}" ${s === c.stage_substatus ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
            </select>
          </div>
        </div>
        <label class="check" style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <input type="checkbox" name="dormant" value="1" style="width:auto" ${c.dormant ? 'checked' : ''}> Dormant / waiting indefinitely (still active, not lost)
        </label>
        <div style="margin-top:10px"><button class="btn" type="submit">Update stage</button></div>
      </form>`;

    const nextActionForm = `
      <form method="POST" action="/dashboard/customers/${c.id}/followups" style="margin-top:8px">
        <div class="grid cols-2">
          <div><label>Next action *</label><input type="text" name="title" placeholder="Send estimate, call back, drop off referrals..." required></div>
          <div><label>Due</label><input type="datetime-local" name="due_at"></div>
        </div>
        <input type="hidden" name="kind" value="next_action">
        <div style="margin-top:8px"><button class="btn secondary" type="submit">Add follow-up</button></div>
      </form>`;

    const openFollowupList = openFollowups.length
      ? `<ul style="margin:8px 0 0;padding-left:0;list-style:none">${openFollowups
          .map(
            (f) => `<li style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">
              <span class="${f.due_at && new Date(f.due_at) < new Date() ? 'overdue' : ''}">${escapeHtml(f.title)}${f.due_at ? ' · ' + escapeHtml(fmtRelativeDue(f.due_at)) : ''}</span>
              <span style="white-space:nowrap">
                <form class="inline" method="POST" action="/dashboard/followups/${f.id}/close"><input type="hidden" name="status" value="done"><button class="btn small" type="submit">Done</button></form>
                <form class="inline" method="POST" action="/dashboard/followups/${f.id}/close"><input type="hidden" name="status" value="dismissed"><button class="btn small secondary" type="submit">Dismiss</button></form>
              </span>
            </li>`
          )
          .join('')}</ul>`
      : '<p class="subtitle" style="margin:8px 0 0">No open follow-ups.</p>';

    const jobsBlock = activeJobs.length
      ? activeJobs
          .map(
            (j) => `<div class="panel" style="margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
                <div><strong><a href="/dashboard/jobs/${j.id}">Job — ${escapeHtml(j.status)}</a></strong>
                  <div class="subtitle" style="margin:0">${j.sold_amount ? fmtMoney(j.sold_amount) : 'amount not set'} · balance ${fmtMoney(db.getJobBalance(j.id) || 0)}</div></div>
                <a class="btn small secondary" href="/status/${j.public_token}" target="_blank">Customer link</a>
              </div>
            </div>`
          )
          .join('')
      : '';

    const body = `
      ${backLink('/dashboard/customers', 'All customers')}
      <div class="cust-header">
        <h1>${escapeHtml(c.name)}</h1>
        <div class="cust-contact">
          ${c.phone ? `📞 <a href="tel:${escapeHtml(telHref(c.phone))}">${phone(c.phone)}</a>` : '<span class="subtitle">no phone</span>'}
          ${c.email ? ` &nbsp;·&nbsp; ✉️ <a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : ''}
          ${c.address ? `<br>📍 <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(c.address)}">${escapeHtml(c.address)}</a>` : ''}
          <br><span class="subtitle">Customer since ${fmtDate(c.first_contact_at || c.created_at)}</span>
        </div>
        <div class="stage-line">
          <span class="stage-pill">${escapeHtml(stage)}</span>
          ${c.stage_substatus ? `<span class="substatus-pill">${escapeHtml(c.stage_substatus)}</span>` : ''}
          ${c.dormant ? `<span class="substatus-pill" style="background:#eee;color:#555">Dormant</span>` : ''}
        </div>
        ${quickActions(c)}
      </div>

      ${attentionBanner(attention)}
      ${jobsBlock}

      <div class="panel">
        <h2 style="margin-top:0">Opportunity</h2>
        ${stageForm}
        <h3>Next actions / follow-ups</h3>
        ${openFollowupList}
        ${nextActionForm}
      </div>

      ${section(
        'message',
        'Text / Email',
        `<p id="send-text"></p>
         ${!smsOn ? '<div class="msg err" style="margin:0 0 10px">Texting NOT CONFIGURED — set TWILIO_* env vars. Messages below are recorded but not delivered.</div>' : ''}
         ${!emailOn ? '<div class="msg err" style="margin:0 0 10px">Email NOT CONFIGURED — set GMAIL_USER / GMAIL_APP_PASSWORD. Messages below are recorded but not delivered.</div>' : ''}
         <form method="POST" action="/dashboard/customers/${c.id}/message">
           <label>Channel</label>
           <select name="channel">
             <option value="sms" ${c.phone ? '' : 'disabled'}>Text (SMS)${c.phone ? '' : ' — no phone on file'}</option>
             <option value="email" ${c.email ? '' : 'disabled'}>Email${c.email ? '' : ' — no email on file'}</option>
           </select>
           <label>Message</label>
           <textarea name="body" id="send-email" placeholder="Type a message…" required></textarea>
           <div style="margin-top:10px"><button class="btn" type="submit">Send &amp; record</button></div>
         </form>
         <h3>Communication history</h3>
         ${
           messages.length
             ? `<table><tr><th>When</th><th>Ch.</th><th>Dir.</th><th>Message</th><th>Delivery</th></tr>${messages
                 .map(
                   (m) =>
                     `<tr><td>${fmtDateTime(m.created_at)}</td><td>${escapeHtml(m.channel)}</td><td>${escapeHtml(m.direction)}</td><td>${escapeHtml((m.body || '').slice(0, 120))}</td><td>${escapeHtml(m.status || '')}</td></tr>`
                 )
                 .join('')}</table>`
             : '<p class="subtitle">No messages yet.</p>'
         }`,
        { count: messages.length }
      )}

      ${section(
        'appts',
        'Appointments',
        `<form method="POST" action="/dashboard/appointments" style="margin-bottom:12px">
           <input type="hidden" name="customer_id" value="${c.id}">
           <input type="hidden" name="return_to" value="/dashboard/customers/${c.id}">
           <div class="grid cols-2">
             <div><label>Type</label><select name="type">${db.APPT_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select></div>
             <div><label>Date &amp; time *</label><input type="datetime-local" name="scheduled_at" required></div>
             <div><label>Duration (min)</label><input type="number" name="duration_min" value="60"></div>
             <div><label>Notes</label><input type="text" name="notes"></div>
           </div>
           <div style="margin-top:8px"><button class="btn secondary" type="submit">Schedule</button></div>
         </form>
         ${
           appts.length
             ? `<table><tr><th>When</th><th>Type</th><th>Status</th><th></th></tr>${appts
                 .map((a) => {
                   const missed = a.status === 'scheduled' && new Date(a.scheduled_at) < new Date();
                   return `<tr>
                     <td class="${missed ? 'overdue' : ''}">${fmtDateTime(a.scheduled_at)}${missed ? ' (missed)' : ''}</td>
                     <td>${escapeHtml(a.type)}</td>
                     <td>${escapeHtml(a.status)}</td>
                     <td style="white-space:nowrap">
                       ${
                         a.status === 'scheduled'
                           ? `<a class="btn small secondary" href="/dashboard/appointments/${a.id}/edit">Edit / reschedule</a>
                              <form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="completed"><input type="hidden" name="return_to" value="/dashboard/customers/${c.id}"><button class="btn small" type="submit">Complete</button></form>
                              <form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="canceled"><input type="hidden" name="return_to" value="/dashboard/customers/${c.id}"><button class="btn small danger" type="submit">Cancel</button></form>`
                           : ''
                       }
                     </td>
                   </tr>`;
                 })
                 .join('')}</table>`
             : '<p class="subtitle">None yet.</p>'
         }`,
        { count: appts.length, open: attention.some((a) => a.apptId) }
      )}

      ${section(
        'files',
        'Files',
        `<form method="POST" action="/dashboard/customers/${c.id}/files" enctype="multipart/form-data">
           <div class="grid cols-3">
             <div><label>File</label><input type="file" name="file" required></div>
             <div><label>Note</label><input type="text" name="note" placeholder="e.g. kitchen measurements"></div>
             <div><label>Job (optional)</label><select name="job_id"><option value="">— not job-specific —</option>${jobs
               .map((j) => `<option value="${j.id}">${escapeHtml(j.status)}${j.sold_amount ? ' · ' + fmtMoney(j.sold_amount) : ''}</option>`)
               .join('')}</select></div>
           </div>
           <div style="margin-top:10px"><button class="btn secondary" type="submit">Upload</button></div>
         </form>
         ${
           files.length
             ? `<table style="margin-top:12px"><tr><th>File</th><th>Note</th><th>Job</th><th>Uploaded</th><th></th></tr>${files
                 .map(
                   (f) => `<tr>
                     <td><a href="/dashboard/customers/${c.id}/files/${f.id}" target="_blank">${escapeHtml(f.original_name)}</a>${f.extraction_status === 'done' ? ' <span class="badge">indexed</span>' : ''}</td>
                     <td>${escapeHtml(f.note || '')}</td>
                     <td>${f.job_id ? `<a href="/dashboard/jobs/${f.job_id}">${escapeHtml(f.job_status || 'job')}</a>` : ''}</td>
                     <td>${fmtDate(f.created_at)}</td>
                     <td style="white-space:nowrap">
                       ${(f.mime_type || '').startsWith('image/') ? `<a class="btn small secondary" href="/dashboard/customers/${c.id}/files/${f.id}/sign">Sign</a> ` : ''}
                       <form class="inline" method="POST" action="/dashboard/customers/${c.id}/files/${f.id}/delete"><button class="btn small warn" type="submit" title="Recoverable - restore from Deleted Files">Delete</button></form>
                     </td>
                   </tr>`
                 )
                 .join('')}</table>
                 <p class="subtitle" style="margin-top:8px">Deleting is recoverable — find it under <a href="/dashboard/files/deleted">Deleted Files</a>.</p>`
             : '<p class="subtitle">No files yet.</p>'
         }`,
        { count: files.length }
      )}

      ${section(
        'marketing',
        'Marketing source / attribution',
        `${
          c.consultant_id
            ? `<p class="subtitle">Home Show consultant: <strong>${escapeHtml((db.getConsultant(c.consultant_id) || {}).name || '')}</strong> — credited with this lead${
                db.listAppointmentsForCustomer(c.id).some((a) => a.consultant_id === c.consultant_id) ? ' and a booked appointment' : ''
              }.</p>`
            : ''
        }
         <p class="subtitle">Original: <strong>${escapeHtml(
          attribution.original ? attribution.original.campaign_name || attribution.original.source_name || 'set' : 'not attributed'
        )}</strong>${
          attribution.original ? ` (${fmtDate(attribution.original.created_at)})` : ''
        } — the first attribution is preserved and never overwritten.</p>
         <form method="POST" action="/dashboard/customers/${c.id}/attribution">
           <div class="grid cols-2">
             <div><label>Source</label><select name="source_id"><option value="">— none —</option>${sources
               .map((s) => `<option value="${s.id}" ${s.id === c.source_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
               .join('')}</select></div>
             <div><label>Campaign</label><select name="campaign_id"><option value="">— none —</option>${campaigns
               .map((mc) => `<option value="${mc.id}" ${mc.id === c.campaign_id ? 'selected' : ''}>${escapeHtml(mc.source_name || '')} — ${escapeHtml(mc.name)}</option>`)
               .join('')}</select></div>
           </div>
           <label>Why (re-attribution reason)</label><input type="text" name="note" placeholder="e.g. confirmed came from Home Show, not Google">
           <div style="margin-top:8px"><button class="btn secondary" type="submit">Set / re-attribute</button></div>
         </form>
         ${
           attribution.history.length > 1
             ? `<h3>Attribution history</h3><table><tr><th>When</th><th>To</th><th>By</th><th>Why</th></tr>${attribution.history
                 .map(
                   (h) =>
                     `<tr><td>${fmtDate(h.created_at)}</td><td>${escapeHtml(h.campaign_name || h.source_name || h.tracking_phone || '—')}</td><td>${escapeHtml(h.actor)}</td><td>${escapeHtml(h.note || '')}</td></tr>`
                 )
                 .join('')}</table>`
             : ''
         }`
      )}

      ${section(
        'contact',
        'Contact details &amp; notes',
        `<form method="POST" action="/dashboard/customers/${c.id}">
           <input type="hidden" name="return_to" value="/dashboard/customers/${c.id}">
           <div class="grid cols-2">
             <div><label>Name *</label><input type="text" name="name" value="${escapeHtml(c.name)}" required></div>
             <div><label>Phone</label><input type="tel" name="phone" value="${escapeHtml(c.phone ? formatPhone(c.phone) : '')}"></div>
             <div><label>Email</label><input type="email" name="email" value="${escapeHtml(c.email || '')}"></div>
             <div><label>Address</label><input type="text" name="address" value="${escapeHtml(c.address || '')}"></div>
           </div>
           <label>Notes</label><textarea name="notes" rows="4">${escapeHtml(c.notes || '')}</textarea>
           <div style="margin-top:10px"><button class="btn" type="submit">Save</button></div>
         </form>`
      )}

      ${section(
        'history',
        'History',
        `<h3>Stage / status changes</h3>
         ${
           stageHistory.length
             ? `<ul class="timeline">${stageHistory
                 .map(
                   (h) =>
                     `<li class="done"><div class="status">${escapeHtml(h.field)}: ${escapeHtml(h.old_value || '—')} → ${escapeHtml(h.new_value || '—')}</div><div class="when">${fmtDateTime(h.created_at)} · ${escapeHtml(h.actor)}${h.note ? ' · ' + escapeHtml(h.note) : ''}</div></li>`
                 )
                 .join('')}</ul>`
             : '<p class="subtitle">No stage changes recorded yet.</p>'
         }
         <h3>All activity</h3>
         <table><tr><th>When</th><th>What</th><th>By</th></tr>${activity
           .map(
             (a) =>
               `<tr><td>${fmtDateTime(a.created_at)}</td><td>${escapeHtml(a.field || a.entity_type)}${a.new_value ? ': ' + escapeHtml(String(a.new_value).slice(0, 60)) : ''}</td><td>${escapeHtml(a.actor)}</td></tr>`
           )
           .join('')}</table>
         <h3>Closed follow-ups</h3>
         ${
           followups.filter((f) => f.status !== 'open').length
             ? `<table><tr><th>Title</th><th>Status</th><th>Closed</th></tr>${followups
                 .filter((f) => f.status !== 'open')
                 .map((f) => `<tr><td>${escapeHtml(f.title)}</td><td>${escapeHtml(f.status)}</td><td>${fmtDate(f.completed_at)}</td></tr>`)
                 .join('')}</table>`
             : '<p class="subtitle">None.</p>'
         }`
      )}
    `;
    res.send(dashboardLayout({ title: c.name, active: '/dashboard/customers', body, flash: flashFromQuery(req.query), context: { customerId: c.id, customerName: c.name } }));
  });

  router.post('/dashboard/customers/:id', requireAuth, (req, res) => {
    const { name, phone: ph, email: em, address, notes } = req.body;
    db.updateCustomer(req.params.id, { name, phone: normalizePhone(ph), email: em, address, notes }, { actor: actorOf(req) });
    res.redirect(`${req.body.return_to || `/dashboard/customers/${req.params.id}`}?ok=Saved`);
  });

  // ---------- Customer: sales stage / attention ----------
  router.post('/dashboard/customers/:id/stage', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const { sales_stage, stage_substatus, dormant } = req.body;
    try {
      db.setSalesStage(c.id, sales_stage, { substatus: stage_substatus || null, actor: actorOf(req) });
      db.setCustomerDormant(c.id, !!dormant, { actor: actorOf(req) });
    } catch (e) {
      return res.redirect(`/dashboard/customers/${c.id}?err=${encodeURIComponent(e.message)}`);
    }
    res.redirect(`/dashboard/customers/${c.id}?ok=Stage updated`);
  });

  // ---------- Follow-ups ----------
  router.post('/dashboard/customers/:id/followups', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const { title, detail, due_at, kind } = req.body;
    if (!title) return res.redirect(`/dashboard/customers/${c.id}?err=A follow-up needs a title`);
    db.createFollowup({
      customer_id: c.id,
      kind: kind || 'next_action',
      title,
      detail,
      due_at: due_at ? new Date(due_at).toISOString() : null,
      created_by: actorOf(req),
    });
    res.redirect(`/dashboard/customers/${c.id}?ok=Follow-up added`);
  });

  router.post('/dashboard/followups/:id/close', requireAuth, (req, res) => {
    const f = db.getFollowup(req.params.id);
    if (!f) return res.status(404).send('Not found');
    const status = req.body.status === 'dismissed' ? 'dismissed' : 'done';
    db.closeFollowup(f.id, status, actorOf(req));
    res.redirect(`${req.body.return_to || `/dashboard/customers/${f.customer_id}`}?ok=Follow-up ${status}`);
  });

  // ---------- Marketing attribution (append-only) ----------
  router.post('/dashboard/customers/:id/attribution', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const { source_id, campaign_id, note } = req.body;
    db.setCustomerAttribution({
      customer_id: c.id,
      source_id: source_id || null,
      campaign_id: campaign_id || null,
      note: note || null,
      actor: actorOf(req),
    });
    res.redirect(`/dashboard/customers/${c.id}?ok=Attribution updated`);
  });

  // ---------- Customer files (photos, measurement docs, contracts) ----------
  router.post('/dashboard/customers/:id/files', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const upload = (req.files || []).find((f) => f.fieldname === 'file');
    if (!upload || !upload.filename) {
      return res.redirect(`/dashboard/customers/${c.id}?err=Choose a file first`);
    }
    let jobId = req.body.job_id || null;
    if (jobId) {
      const job = db.getJob(jobId);
      if (!job || job.customer_id !== c.id) jobId = null;
    }
    saveUpload({ customer_id: c.id, job_id: jobId, upload, note: req.body.note || null });
    res.redirect(`/dashboard/customers/${c.id}?ok=File uploaded`);
  });

  router.get('/dashboard/customers/:id/files/:fileId', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.fileId);
    if (!f || f.customer_id !== req.params.id) return res.status(404).send('File not found');
    const filePath = path.join(customerUploadsDir(f.customer_id), f.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');
    res.writeHead(200, {
      'Content-Type': f.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${f.original_name.replace(/"/g, '')}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  });

  // SOFT delete - the bytes stay on disk and the row is retained; the file is
  // just hidden and pulled from search. Recoverable from /dashboard/files/deleted.
  router.post('/dashboard/customers/:id/files/:fileId/delete', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.fileId);
    if (f && f.customer_id === req.params.id) db.softDeleteCustomerFile(f.id, actorOf(req));
    res.redirect(`/dashboard/customers/${req.params.id}?ok=File moved to Deleted Files (recoverable)`);
  });

  // ---------- Deleted files: recover or permanently purge ----------
  router.get('/dashboard/files/deleted', requireAuth, (req, res) => {
    const deleted = db.listDeletedFiles();
    const body = `
      ${backLink('/dashboard/files', 'Back to Files')}
      <h1>Deleted Files</h1>
      <p class="subtitle">Files removed with Delete land here and can be restored. Permanently deleting also erases the file from disk and cannot be undone.</p>
      <div class="panel">
        ${
          deleted.length
            ? `<table><tr><th>File</th><th>Customer</th><th>Deleted</th><th>By</th><th></th></tr>${deleted
                .map(
                  (f) => `<tr>
                    <td>${escapeHtml(f.original_name)}</td>
                    <td>${f.customer_id ? `<a href="/dashboard/customers/${f.customer_id}">${escapeHtml(f.customer_name || '')}</a>` : ''}</td>
                    <td>${fmtDateTime(f.deleted_at)}</td>
                    <td>${escapeHtml(f.deleted_by || '')}</td>
                    <td style="white-space:nowrap">
                      <form class="inline" method="POST" action="/dashboard/files/${f.id}/restore"><button class="btn small" type="submit">Restore</button></form>
                      <form class="inline" method="POST" action="/dashboard/files/${f.id}/purge" onsubmit="return confirm('Permanently delete this file? This cannot be undone.')"><button class="btn small danger" type="submit">Delete permanently</button></form>
                    </td>
                  </tr>`
                )
                .join('')}</table>`
            : '<p class="subtitle">No deleted files.</p>'
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Deleted Files', active: '/dashboard/files/deleted', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/files/:fileId/restore', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.fileId);
    if (f) db.restoreCustomerFile(f.id, actorOf(req));
    res.redirect('/dashboard/files/deleted?ok=File restored');
  });

  router.post('/dashboard/files/:fileId/purge', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.fileId);
    if (f && f.deleted_at) {
      const filePath = path.join(customerUploadsDir(f.customer_id), f.stored_name);
      fs.existsSync(filePath) && fs.unlinkSync(filePath);
      db.deleteCustomerFile(f.id);
      db.logActivity({ entity_type: 'file', entity_id: f.id, customer_id: f.customer_id, field: 'purged', new_value: f.original_name, actor: actorOf(req) });
    }
    res.redirect('/dashboard/files/deleted?ok=File permanently deleted');
  });

  // ---------- Sign a drawing/photo (e.g. "sign the measure drawing") ----------
  // Draws a free-hand signature on top of an existing image file and saves
  // the result as a NEW file (the original stays untouched). Not a legal
  // e-signature system - for actual contracts, keep using DocuSign and
  // upload the signed PDF via the regular file upload above.
  router.get('/dashboard/customers/:id/files/:fileId/sign', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    const f = db.getCustomerFile(req.params.fileId);
    if (!c || !f || f.customer_id !== c.id) return res.status(404).send('File not found');
    if (!(f.mime_type || '').startsWith('image/')) return res.status(400).send('Only image files can be signed');

    const body = `
      ${backLink(`/dashboard/customers/${c.id}`, 'Cancel — back to customer, nothing saved')}
      <h1>Sign: ${escapeHtml(f.original_name)}</h1>
      <p class="subtitle">Draw a signature on top of the image below, then save. This creates a NEW file - the original is kept untouched. Cancel any time; nothing is saved until you press "Save signed copy".</p>
      <div class="panel">
        <canvas id="sign-canvas" style="max-width:100%;border:1px solid var(--line);touch-action:none;cursor:crosshair;display:block"></canvas>
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" type="button" id="sign-save">Save signed copy</button>
          <button class="btn secondary" type="button" id="sign-clear">Clear drawing</button>
          <a class="btn secondary" href="/dashboard/customers/${c.id}">Cancel</a>
        </div>
        <p id="sign-status" class="subtitle" style="margin-top:8px"></p>
      </div>
      <script>
      (function () {
        var canvas = document.getElementById('sign-canvas');
        var ctx = canvas.getContext('2d');
        var img = new Image();
        var drawing = false;
        var last = null;

        img.onload = function () {
          var maxW = Math.min(800, img.width);
          var scale = maxW / img.width;
          canvas.width = maxW;
          canvas.height = img.height * scale;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = '/dashboard/customers/${c.id}/files/${f.id}';

        function posFromEvent(e) {
          var rect = canvas.getBoundingClientRect();
          var point = e.touches ? e.touches[0] : e;
          return {
            x: (point.clientX - rect.left) * (canvas.width / rect.width),
            y: (point.clientY - rect.top) * (canvas.height / rect.height),
          };
        }
        function start(e) { e.preventDefault(); drawing = true; last = posFromEvent(e); }
        function move(e) {
          if (!drawing) return;
          e.preventDefault();
          var p = posFromEvent(e);
          ctx.strokeStyle = '#1e3d22';
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last = p;
        }
        function end() { drawing = false; }

        canvas.addEventListener('mousedown', start);
        canvas.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        canvas.addEventListener('touchstart', start);
        canvas.addEventListener('touchmove', move);
        canvas.addEventListener('touchend', end);

        document.getElementById('sign-clear').addEventListener('click', function () {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        });

        document.getElementById('sign-save').addEventListener('click', function () {
          var status = document.getElementById('sign-status');
          status.textContent = 'Saving...';
          fetch('/dashboard/customers/${c.id}/files/${f.id}/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_url: canvas.toDataURL('image/png') }),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.ok) {
                window.location.href = '/dashboard/customers/${c.id}?ok=Signed copy saved';
              } else {
                status.textContent = data.error || 'Something went wrong saving.';
              }
            })
            .catch(function () { status.textContent = 'Something went wrong saving.'; });
        });
      })();
      </script>
    `;
    res.send(dashboardLayout({ title: 'Sign file', active: '/dashboard/customers', body }));
  });

  router.post('/dashboard/customers/:id/files/:fileId/sign', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    const original = db.getCustomerFile(req.params.fileId);
    if (!c || !original || original.customer_id !== c.id) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }
    const match = /^data:image\/png;base64,(.+)$/.exec(req.body.data_url || '');
    if (!match) return res.status(400).json({ ok: false, error: 'No signature data received' });

    const buffer = Buffer.from(match[1], 'base64');
    const storedName = `${newId()}.png`;
    fs.writeFileSync(path.join(customerUploadsDir(c.id), storedName), buffer);
    const fileId = db.createCustomerFile({
      customer_id: c.id,
      job_id: original.job_id || null,
      stored_name: storedName,
      original_name: `signed-${original.original_name.replace(/\.[^.]+$/, '')}.png`,
      mime_type: 'image/png',
      size: buffer.length,
      note: `Signed copy of "${original.original_name}"`,
    });
    db.logActivity({
      entity_type: 'file',
      entity_id: fileId,
      customer_id: c.id,
      field: 'signed_copy_created',
      new_value: original.original_name,
      actor: actorOf(req),
    });
    res.json({ ok: true });
  });

  router.post('/dashboard/customers/:id/message', requireAuth, async (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const { channel, body } = req.body;
    if (!body || !body.trim()) return res.redirect(`/dashboard/customers/${c.id}?err=Message is empty`);
    let result;
    if (channel === 'email') {
      result = await email.sendEmail({
        to: c.email,
        subject: `Message from ${require('../render').BUSINESS_NAME}`,
        html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
        customer_id: c.id,
        logMessage: db.logMessage,
      });
    } else {
      result = await sms.sendSms({ to: c.phone, body, customer_id: c.id, logMessage: db.logMessage });
    }
    db.logActivity({
      entity_type: 'message',
      entity_id: c.id,
      customer_id: c.id,
      field: channel === 'email' ? 'email_sent' : 'text_sent',
      new_value: (body || '').slice(0, 80),
      note: result && result.ok ? 'delivered' : result && result.reason ? `not delivered (${result.reason})` : 'not delivered',
      actor: actorOf(req),
    });
    // Honest confirmation: only say "sent" when the provider confirmed it.
    const msg =
      result && result.ok
        ? 'Message sent and recorded.'
        : result && result.reason === 'not_configured'
          ? `Recorded, NOT delivered — ${channel === 'email' ? 'email' : 'texting'} is not configured.`
          : result && result.reason === 'no_phone_number'
            ? 'Recorded, NOT delivered — no valid phone number on file.'
            : result && result.reason === 'no_email_address'
              ? 'Recorded, NOT delivered — no valid email on file.'
              : 'Recorded, NOT delivered — the provider rejected it (see server log).';
    res.redirect(`/dashboard/customers/${c.id}?${result && result.ok ? 'ok' : 'err'}=${encodeURIComponent(msg)}`);
  });

  // ---------- Pipeline (customer-centric sales stages) ----------
  router.get('/dashboard/funnel', requireAuth, (req, res) => res.redirect('/dashboard/pipeline'));

  router.get('/dashboard/pipeline', requireAuth, (req, res) => {
    const customers = db.listCustomers().filter((c) => (req.query.dormant === '1' ? true : !c.dormant));
    const byStage = {};
    for (const s of db.SALES_STAGES) byStage[s] = [];
    for (const c of customers) (byStage[c.sales_stage] || (byStage['Bona Fide Lead'] = byStage['Bona Fide Lead'] || [])).push(c);
    const openF = db.listOpenFollowups();
    const followupCount = {};
    for (const f of openF) followupCount[f.customer_id] = (followupCount[f.customer_id] || 0) + 1;

    const cols = db.SALES_STAGES.map((stage) => {
      const inStage = byStage[stage] || [];
      return `<div class="funnel-col">
        <h3>${escapeHtml(stage)} <span class="badge">${inStage.length}</span></h3>
        ${inStage
          .map(
            (c) => `<div class="lead-card">
              <div class="name"><a href="/dashboard/customers/${c.id}">${escapeHtml(c.name)}</a></div>
              <div class="meta">${c.stage_substatus ? escapeHtml(c.stage_substatus) : (c.phone ? phone(c.phone) : 'no phone')}${followupCount[c.id] ? ` · ${followupCount[c.id]} follow-up${followupCount[c.id] > 1 ? 's' : ''}` : ''}</div>
              <form method="POST" action="/dashboard/customers/${c.id}/stage">
                <input type="hidden" name="stage_substatus" value="${escapeHtml(c.stage_substatus || '')}">
                <input type="hidden" name="dormant" value="${c.dormant ? '1' : ''}">
                <select name="sales_stage" onchange="this.form.submit()">
                  ${db.SALES_STAGES.map((s) => `<option value="${escapeHtml(s)}" ${s === c.sales_stage ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
              </form>
            </div>`
          )
          .join('')}
      </div>`;
    }).join('');

    const body = `
      <h1>Pipeline</h1>
      <p class="subtitle">Where every opportunity stands. Sub-statuses (e.g. "Estimate Overdue") are set on the customer page and flag what needs action — they don't move the KPI stage.
        ${req.query.dormant === '1' ? '<a href="/dashboard/pipeline">Hide dormant</a>' : '<a href="/dashboard/pipeline?dormant=1">Show dormant too</a>'}</p>
      <div class="panel">
        <h2 style="margin-top:0">New customer / lead</h2>
        <form method="POST" action="/dashboard/leads/quick">
          <div class="grid cols-3">
            <div><label>Name *</label><input type="text" name="name" required></div>
            <div><label>Phone</label><input type="tel" name="phone"></div>
            <div><label>Email</label><input type="email" name="email"></div>
            <div><label>Source</label><select name="source_id"><option value="">— none —</option>${db.listSources().map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></div>
            <div><label>Campaign</label><select name="campaign_id"><option value="">— none —</option>${db.listCampaigns().map((mc) => `<option value="${mc.id}">${escapeHtml(mc.source_name || '')} — ${escapeHtml(mc.name)}</option>`).join('')}</select></div>
            <div><label>Notes</label><input type="text" name="notes"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Add</button></div>
        </form>
      </div>
      <div class="funnel">${cols}</div>
    `;
    res.send(dashboardLayout({ title: 'Pipeline', active: '/dashboard/pipeline', body, flash: flashFromQuery(req.query) }));
  });

  // ---------- KPI ----------
  router.get('/dashboard/kpi', requireAuth, (req, res) => {
    const now = new Date();
    const def = { start: `${now.getFullYear()}-01-01`, end: now.toISOString().slice(0, 10) };
    const startStr = req.query.start || def.start;
    const endStr = req.query.end || def.end;
    const start = `${startStr}T00:00:00.000Z`;
    const end = `${endStr}T23:59:59.999Z`;
    const k = db.kpiFunnel({ start, end });
    const camp = db.kpiByCampaign({ start, end });
    const scoreboard = db.consultantScoreboard({ start, end });

    const steps = [
      ['Bona Fide Leads', k.counts.bona_fide_leads, null],
      ['Design Appointments Set', k.counts.design_appointments_set, k.conversion.lead_to_appointment],
      ['Design Appointments Completed', k.counts.design_appointments_completed, k.conversion.appointment_to_completed],
      ['Estimates Presented', k.counts.estimates_presented, k.conversion.completed_to_estimate],
      ['Sales', k.counts.sales, k.conversion.estimate_to_sale],
    ];

    const body = `
      <h1>KPI</h1>
      <p class="subtitle">Cohort = customers whose first contact date falls in the window. Every conversion rate below shows its exact numerator / denominator so the meaning can't drift.</p>
      <div class="panel">
        <form method="GET" action="/dashboard/kpi">
          <div class="grid cols-3">
            <div><label>From</label><input type="date" name="start" value="${startStr}"></div>
            <div><label>To</label><input type="date" name="end" value="${endStr}"></div>
            <div style="align-self:end"><button class="btn secondary" type="submit">Update</button></div>
          </div>
        </form>
      </div>

      <h2>Primary funnel</h2>
      <div class="kpi-funnel">
        ${steps
          .map(
            ([name, num, conv]) => `<div class="kpi-step">
              <div><div class="k-name">${escapeHtml(name)}</div>${
                conv && conv.rate !== null
                  ? `<div class="denominator-note">${conv.rate}% of ${conv.denominator} ${escapeHtml(conv.denominator_label)}</div>`
                  : ''
              }</div>
              <div class="k-num">${num}</div>
            </div>`
          )
          .join('')}
      </div>
      <div class="panel">
        <h3 style="margin-top:0">Closed / We Declined Customer (terminal, not "lost")</h3>
        <p style="font-size:1.2rem;font-weight:700;margin:0">${k.counts.closed_we_declined}</p>
      </div>

      <h2>Revenue (window)</h2>
      <div class="grid cols-4">
        <div class="stat"><div class="num">${fmtMoney(k.revenue.collected)}</div><div class="label">Payments collected<br><span class="denominator-note">sum of payments dated in window</span></div></div>
        <div class="stat"><div class="num">${fmtMoney(k.revenue.sold_contract_value)}</div><div class="label">Sold contract value<br><span class="denominator-note">sum of sold_amount on jobs created in window</span></div></div>
        <div class="stat"><div class="num">${k.revenue.jobs_created}</div><div class="label">Jobs created in window</div></div>
        <div class="stat"><div class="num">${fmtMoney(k.revenue.average_sale)}</div><div class="label">Average sale<br><span class="denominator-note">sold value ÷ jobs created</span></div></div>
      </div>

      <h2>All conversion rates</h2>
      <div class="panel"><table>
        <tr><th>Rate</th><th>Value</th><th>Numerator</th><th>Denominator</th></tr>
        ${Object.entries(k.conversion)
          .map(
            ([key, v]) =>
              `<tr><td>${escapeHtml(key.replace(/_/g, ' '))}</td><td>${v.rate === null ? '—' : v.rate + '%'}</td><td>${v.numerator}</td><td>${v.denominator} <span class="denominator-note">(${escapeHtml(v.denominator_label)})</span></td></tr>`
          )
          .join('')}
      </table></div>

      <h2>By marketing source / campaign</h2>
      <div class="panel"><div style="overflow-x:auto"><table>
        <tr><th>Source / campaign</th><th>Spend</th><th>Leads</th><th>Appts</th><th>Sales</th><th>Revenue</th><th>Cost / lead</th><th>Cost / appt</th><th>CAC</th><th>ROAS</th></tr>
        ${camp
          .map(
            (g) => `<tr>
              <td>${escapeHtml(g.label)}</td>
              <td>${g.campaign_cost ? fmtMoney(g.campaign_cost) : '—'}</td>
              <td>${g.leads}</td><td>${g.appointments}</td><td>${g.sales}</td>
              <td>${fmtMoney(g.revenue)}</td>
              <td>${g.cost_per_lead != null ? fmtMoney(g.cost_per_lead) : '—'}</td>
              <td>${g.cost_per_appointment != null ? fmtMoney(g.cost_per_appointment) : '—'}</td>
              <td>${g.customer_acquisition_cost != null ? fmtMoney(g.customer_acquisition_cost) : '—'}</td>
              <td>${g.roas != null ? g.roas + '×' : '—'}</td>
            </tr>`
          )
          .join('')}
      </table></div>
      <p class="denominator-note">Cost/lead = campaign spend ÷ leads attributed to it. Cost/appt = spend ÷ appointments. CAC = spend ÷ sales. ROAS = revenue ÷ spend. Blank when spend or the denominator is zero.</p>
      </div>

      <h2>Home Show / consultant scoreboard</h2>
      <div class="panel"><div style="overflow-x:auto"><table>
        <tr><th>Consultant</th><th>Leads captured</th><th>Appts booked</th><th>Appts completed</th><th>Show rate</th><th>Jobs sold</th><th>Revenue</th></tr>
        ${
          scoreboard.length
            ? scoreboard
                .map(
                  (s) => `<tr>
                    <td>${escapeHtml(s.name)}${s.active ? '' : ' <span class="badge">inactive</span>'}</td>
                    <td>${s.leads_captured}</td>
                    <td>${s.appointments_booked}</td>
                    <td>${s.appointments_completed}</td>
                    <td>${s.show_rate === null ? '—' : Math.round(s.show_rate * 100) + '%'}</td>
                    <td>${s.jobs_sold}</td>
                    <td>${fmtMoney(s.revenue)}</td>
                  </tr>`
                )
                .join('')
            : `<tr><td colspan="7" class="denominator-note">No consultant-credited activity in this window. Make a Home Show link on the <a href="/dashboard/booking-link">Booking Link</a> page.</td></tr>`
        }
      </table></div>
      <p class="denominator-note">Leads captured = customers this consultant is credited with (by first-contact date). Appts booked/completed = design appointments they booked. Show rate = completed ÷ booked. Jobs sold / revenue = jobs and sold contract value for their customers, by job creation date. Lead-capture credit and appointment-booked credit are counted separately.</p>
      </div>
    `;
    res.send(dashboardLayout({ title: 'KPI', active: '/dashboard/kpi', body, flash: flashFromQuery(req.query) }));
  });

  // ---------- Marketing (sources & campaigns) ----------
  router.get('/dashboard/marketing', requireAuth, (req, res) => {
    const sources = db.listSources({ includeInactive: true });
    const campaigns = db.listCampaigns({ includeInactive: true });
    const body = `
      <h1>Marketing</h1>
      <p class="subtitle">Sources (Reach, Richmond Magazine, Home Show, Referral, Google…) each hold campaigns. A campaign can own a dedicated tracking phone number — a future answering AI will use the number a call came in on to auto-attribute that Bona Fide Lead. Original attribution on a customer is preserved forever; re-attribution is logged.</p>

      <div class="grid cols-2">
        <div class="panel">
          <h2 style="margin-top:0">Add a source</h2>
          <form method="POST" action="/dashboard/marketing/sources">
            <label>Name *</label><input type="text" name="name" required placeholder="Home Show">
            <label>Notes</label><input type="text" name="notes">
            <div style="margin-top:10px"><button class="btn" type="submit">Add source</button></div>
          </form>
          <h3>Sources</h3>
          ${
            sources.length
              ? `<table><tr><th>Name</th><th>Campaigns</th><th></th></tr>${sources
                  .map(
                    (s) =>
                      `<tr><td>${escapeHtml(s.name)}${s.active ? '' : ' <span class="badge">inactive</span>'}</td><td>${campaigns.filter((c) => c.source_id === s.id).length}</td>
                       <td><form class="inline" method="POST" action="/dashboard/marketing/sources/${s.id}"><input type="hidden" name="active" value="${s.active ? '0' : '1'}"><input type="hidden" name="name" value="${escapeHtml(s.name)}"><button class="btn small secondary" type="submit">${s.active ? 'Deactivate' : 'Reactivate'}</button></form></td></tr>`
                  )
                  .join('')}</table>`
              : '<p class="subtitle">No sources yet.</p>'
          }
        </div>

        <div class="panel">
          <h2 style="margin-top:0">Add a campaign</h2>
          ${
            sources.filter((s) => s.active).length
              ? `<form method="POST" action="/dashboard/marketing/campaigns">
                  <label>Source *</label><select name="source_id" required>${sources.filter((s) => s.active).map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
                  <label>Campaign name *</label><input type="text" name="name" required placeholder="Spring 2026 Home Show booth">
                  <label>Dedicated tracking phone</label><input type="tel" name="tracking_phone" placeholder="(804) 555-0142">
                  <div class="grid cols-2">
                    <div><label>Start</label><input type="date" name="start_date"></div>
                    <div><label>End</label><input type="date" name="end_date"></div>
                    <div><label>Spend ($)</label><input type="number" step="0.01" name="cost"></div>
                    <div><label>Status</label><select name="status"><option>active</option><option>planned</option><option>ended</option></select></div>
                  </div>
                  <label>Notes</label><input type="text" name="notes">
                  <div style="margin-top:10px"><button class="btn" type="submit">Add campaign</button></div>
                </form>`
              : '<p class="subtitle">Add a source first.</p>'
          }
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Campaigns</h2>
        ${
          campaigns.length
            ? `<div style="overflow-x:auto"><table>
                <tr><th>Source</th><th>Campaign</th><th>Tracking #</th><th>Dates</th><th>Spend</th><th>Status</th><th></th></tr>
                ${campaigns
                  .map(
                    (c) => `<tr>
                      <td>${escapeHtml(c.source_name || '')}</td>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${c.tracking_phone ? phone(c.tracking_phone) : '—'}</td>
                      <td>${c.start_date ? fmtDate(c.start_date) : '?'} – ${c.end_date ? fmtDate(c.end_date) : 'ongoing'}</td>
                      <td>${c.cost != null ? fmtMoney(c.cost) : '—'}</td>
                      <td>${escapeHtml(c.status)}${c.active ? '' : ' <span class="badge">archived</span>'}</td>
                      <td><a class="btn small secondary" href="/dashboard/marketing/campaigns/${c.id}/edit">Edit</a></td>
                    </tr>`
                  )
                  .join('')}
              </table></div>`
            : '<p class="subtitle">No campaigns yet.</p>'
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Marketing', active: '/dashboard/marketing', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/marketing/sources', requireAuth, (req, res) => {
    if (!req.body.name) return res.redirect('/dashboard/marketing?err=Source needs a name');
    if (req.body.active !== undefined) {
      // toggle path reuses this route via hidden fields - handled in :id below normally
    }
    db.createSource({ name: req.body.name, notes: req.body.notes });
    res.redirect('/dashboard/marketing?ok=Source added');
  });

  router.post('/dashboard/marketing/sources/:id', requireAuth, (req, res) => {
    db.updateSource(req.params.id, { name: req.body.name, notes: req.body.notes, active: req.body.active === '1' });
    res.redirect('/dashboard/marketing?ok=Source updated');
  });

  router.post('/dashboard/marketing/campaigns', requireAuth, (req, res) => {
    const { source_id, name } = req.body;
    if (!source_id || !name) return res.redirect('/dashboard/marketing?err=Campaign needs a source and a name');
    db.createCampaign({
      source_id,
      name,
      tracking_phone: req.body.tracking_phone ? normalizePhone(req.body.tracking_phone) : null,
      start_date: req.body.start_date || null,
      end_date: req.body.end_date || null,
      cost: req.body.cost,
      status: req.body.status || 'active',
      notes: req.body.notes || null,
    });
    res.redirect('/dashboard/marketing?ok=Campaign added');
  });

  router.get('/dashboard/marketing/campaigns/:id/edit', requireAuth, (req, res) => {
    const c = db.getCampaign(req.params.id);
    if (!c) return res.status(404).send('Campaign not found');
    const sources = db.listSources({ includeInactive: true });
    const body = `
      ${backLink('/dashboard/marketing', 'Cancel — back to Marketing')}
      <h1>Edit campaign</h1>
      <div class="panel">
        <form method="POST" action="/dashboard/marketing/campaigns/${c.id}">
          <label>Source</label><select name="source_id">${sources.map((s) => `<option value="${s.id}" ${s.id === c.source_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
          <label>Name</label><input type="text" name="name" value="${escapeHtml(c.name)}">
          <label>Tracking phone</label><input type="tel" name="tracking_phone" value="${escapeHtml(c.tracking_phone ? formatPhone(c.tracking_phone) : '')}">
          <div class="grid cols-2">
            <div><label>Start</label><input type="date" name="start_date" value="${escapeHtml(c.start_date || '')}"></div>
            <div><label>End</label><input type="date" name="end_date" value="${escapeHtml(c.end_date || '')}"></div>
            <div><label>Spend ($)</label><input type="number" step="0.01" name="cost" value="${c.cost != null ? c.cost : ''}"></div>
            <div><label>Status</label><select name="status">${['active', 'planned', 'ended'].map((s) => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
          </div>
          <label>Notes</label><input type="text" name="notes" value="${escapeHtml(c.notes || '')}">
          <label class="check" style="display:flex;gap:8px;margin-top:10px"><input type="checkbox" name="active" value="1" style="width:auto" ${c.active ? 'checked' : ''}> Active (unchecked = archived)</label>
          <div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn" type="submit">Save</button>
            <a class="btn secondary" href="/dashboard/marketing">Cancel</a>
          </div>
        </form>
      </div>
    `;
    res.send(dashboardLayout({ title: 'Edit campaign', active: '/dashboard/marketing', body }));
  });

  router.post('/dashboard/marketing/campaigns/:id', requireAuth, (req, res) => {
    db.updateCampaign(req.params.id, {
      source_id: req.body.source_id,
      name: req.body.name,
      tracking_phone: req.body.tracking_phone ? normalizePhone(req.body.tracking_phone) : '',
      start_date: req.body.start_date,
      end_date: req.body.end_date,
      cost: req.body.cost,
      status: req.body.status,
      notes: req.body.notes,
      active: req.body.active === '1',
    });
    res.redirect('/dashboard/marketing?ok=Campaign saved');
  });

  router.post('/dashboard/leads', requireAuth, (req, res) => {
    const { customer_id, source, estimate_value, notes } = req.body;
    const lead = db.createLead({ customer_id, source, estimate_value, notes });
    automations.onLeadCreated(lead, db.getCustomer(customer_id)).catch((e) => console.error(e));
    res.redirect(`/dashboard/customers/${customer_id}?ok=Lead added to funnel`);
  });

  // Quick-add: creates the customer (or reuses an existing match by phone/email),
  // records marketing attribution, and keeps a legacy lead row for continuity.
  router.post('/dashboard/leads/quick', requireAuth, async (req, res) => {
    const { name, phone: ph, email: em, source, source_id, campaign_id, estimate_value, notes } = req.body;
    if (!name) return res.redirect('/dashboard/pipeline?err=Name is required');
    const phoneNorm = normalizePhone(ph);
    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, em);
    if (!customer) {
      customer = db.createCustomer({
        name,
        phone: phoneNorm,
        email: em,
        notes,
        source_id: source_id || null,
        campaign_id: campaign_id || null,
        actor: actorOf(req),
      });
    } else if (source_id || campaign_id) {
      db.setCustomerAttribution({ customer_id: customer.id, source_id, campaign_id, note: 'quick-add', actor: actorOf(req) });
    }
    const lead = db.createLead({ customer_id: customer.id, source: source || null, estimate_value, notes });
    try {
      await automations.onLeadCreated(lead, customer);
    } catch (e) {
      console.error('onLeadCreated failed', e);
    }
    res.redirect(`/dashboard/customers/${customer.id}?ok=Customer added`);
  });

  // Legacy funnel stage dropdown. Kept working, but it now also moves the
  // customer-level sales_stage (the KPI source of truth) via a legacy->new map.
  router.post('/dashboard/leads/:id/stage', requireAuth, async (req, res) => {
    const lead = db.getLead(req.params.id);
    if (!lead) return res.status(404).send('Lead not found');
    const { stage } = req.body;
    db.updateLeadStage(lead.id, stage);
    const map = {
      'New Lead': 'Bona Fide Lead',
      Contacted: 'Bona Fide Lead',
      Quoted: 'Estimate Presented',
      Sold: 'Sold',
      Lost: 'Closed / We Declined Customer',
    };
    if (map[stage]) {
      try {
        db.setSalesStage(lead.customer_id, map[stage], { actor: actorOf(req), note: 'via legacy funnel' });
      } catch (e) {
        console.error(e);
      }
    }
    if (stage === 'Sold' && !db.listJobs().some((j) => j.customer_id === lead.customer_id)) {
      const customer = db.getCustomer(lead.customer_id);
      const job = db.createJob({ lead_id: lead.id, customer_id: lead.customer_id, sold_amount: lead.estimate_value });
      try {
        await automations.onJobCreated(job, customer);
      } catch (e) {
        console.error('onJobCreated failed', e);
      }
    }
    res.redirect(`${req.body.return_to || '/dashboard/pipeline'}?ok=Stage updated`);
  });

  // ---------- Appointments ----------
  router.get('/dashboard/appointments', requireAuth, (req, res) => {
    const appts = db.listAppointments();
    const customers = db.listCustomers();
    const preselect = req.query.customer_id || '';
    const body = `
      <h1>Appointments</h1>
      <div class="panel">
        <h2 style="margin-top:0">Schedule an appointment</h2>
        <form method="POST" action="/dashboard/appointments">
          <div class="grid cols-3">
            <div>
              <label>Customer *</label>
              <select name="customer_id" required>
                <option value="">Select...</option>
                ${customers.map((c) => `<option value="${c.id}" ${c.id === preselect ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Type</label>
              <select name="type">${db.APPT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
            </div>
            <div><label>Date &amp; time *</label><input type="datetime-local" name="scheduled_at" required></div>
            <div><label>Duration (min)</label><input type="number" name="duration_min" value="60"></div>
            <div style="grid-column: span 2"><label>Notes</label><input type="text" name="notes"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Schedule</button></div>
        </form>
      </div>
      <div class="panel">
        <div style="overflow-x:auto"><table>
          <tr><th>When</th><th>Customer</th><th>Type</th><th>Status</th><th></th></tr>
          ${appts
            .map((a) => {
              const missed = a.status === 'scheduled' && new Date(a.scheduled_at) < new Date();
              return `
            <tr>
              <td class="${missed ? 'overdue' : ''}">${fmtDateTime(a.scheduled_at)}${missed ? ' (missed)' : ''}</td>
              <td><a href="/dashboard/customers/${a.customer_id}">${escapeHtml(a.customer_name)}</a>${a.customer_phone ? `<div class="subtitle" style="margin:0">${phone(a.customer_phone)}</div>` : ''}</td>
              <td>${escapeHtml(a.type)}</td>
              <td>${escapeHtml(a.status)}</td>
              <td style="white-space:nowrap">
                ${
                  a.status === 'scheduled'
                    ? `<a class="btn small secondary" href="/dashboard/appointments/${a.id}/edit?return_to=${encodeURIComponent('/dashboard/appointments')}">Edit</a>
                       <form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="completed"><input type="hidden" name="return_to" value="/dashboard/appointments"><button class="btn small" type="submit">Complete</button></form>
                       <form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="canceled"><input type="hidden" name="return_to" value="/dashboard/appointments"><button class="btn small danger" type="submit">Cancel</button></form>`
                    : ''
                }
              </td>
            </tr>`;
            })
            .join('')}
        </table></div>
        ${appts.length === 0 ? '<p class="subtitle">No appointments yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Appointments', active: '/dashboard/appointments', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/appointments', requireAuth, async (req, res) => {
    const { customer_id, type, scheduled_at, duration_min, notes } = req.body;
    const returnTo = req.body.return_to || '/dashboard/appointments';
    if (!customer_id || !scheduled_at) return res.redirect(`${returnTo}?err=Customer and time are required`);
    const iso = new Date(scheduled_at).toISOString();
    db.createAppointment({ customer_id, type, scheduled_at: iso, duration_min: Number(duration_min) || 60, notes, created_by: actorOf(req) });
    // A design appointment being set advances the KPI stage (if it isn't already past it).
    if (/design|consultation/i.test(type || '')) {
      const c = db.getCustomer(customer_id);
      if (c && db.SALES_STAGES.indexOf(c.sales_stage) < db.SALES_STAGES.indexOf('Design Appointment Set')) {
        db.setSalesStage(customer_id, 'Design Appointment Set', { substatus: 'Upcoming', actor: actorOf(req), note: 'appointment scheduled' });
      }
    }
    res.redirect(`${returnTo}?ok=Appointment scheduled`);
  });

  router.get('/dashboard/appointments/:id/edit', requireAuth, (req, res) => {
    const a = db.getAppointment(req.params.id);
    if (!a) return res.status(404).send('Appointment not found');
    const c = db.getCustomer(a.customer_id);
    const local = new Date(a.scheduled_at);
    const localValue = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const returnTo = req.query.return_to || `/dashboard/customers/${a.customer_id}`;
    const body = `
      ${backLink(returnTo, 'Cancel — back without changes')}
      <h1>Edit / reschedule appointment</h1>
      <p class="subtitle">${escapeHtml(c ? c.name : '')} · currently ${escapeHtml(a.status)}</p>
      <div class="panel">
        <form method="POST" action="/dashboard/appointments/${a.id}">
          <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
          <div class="grid cols-2">
            <div><label>Type</label><select name="type">${db.APPT_TYPES.map((t) => `<option ${t === a.type ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></div>
            <div><label>Date &amp; time</label><input type="datetime-local" name="scheduled_at" value="${localValue}"></div>
            <div><label>Duration (min)</label><input type="number" name="duration_min" value="${a.duration_min || 60}"></div>
            <div><label>Notes</label><input type="text" name="notes" value="${escapeHtml(a.notes || '')}"></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn" type="submit">Save changes</button>
            <a class="btn secondary" href="${escapeHtml(returnTo)}">Cancel</a>
          </div>
        </form>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">Change status</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <form method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="completed"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="btn" type="submit">Mark completed</button></form>
          <form method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="canceled"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="btn danger" type="submit">Cancel appointment</button></form>
        </div>
      </div>
    `;
    res.send(dashboardLayout({ title: 'Edit appointment', active: '/dashboard/appointments', body }));
  });

  router.post('/dashboard/appointments/:id', requireAuth, (req, res) => {
    const a = db.getAppointment(req.params.id);
    if (!a) return res.status(404).send('Appointment not found');
    const { type, scheduled_at, duration_min, notes } = req.body;
    db.updateAppointment(
      a.id,
      {
        type,
        scheduled_at: scheduled_at ? new Date(scheduled_at).toISOString() : a.scheduled_at,
        duration_min,
        notes,
      },
      { actor: actorOf(req) }
    );
    res.redirect(`${req.body.return_to || `/dashboard/customers/${a.customer_id}`}?ok=Appointment updated`);
  });

  router.post('/dashboard/appointments/:id/status', requireAuth, (req, res) => {
    const a = db.getAppointment(req.params.id);
    if (!a) return res.status(404).send('Appointment not found');
    db.setAppointmentStatusTracked(a.id, req.body.status, { actor: actorOf(req) });
    // A completed design appointment advances the KPI stage.
    if (req.body.status === 'completed' && /design|consultation/i.test(a.type || '')) {
      const c = db.getCustomer(a.customer_id);
      if (c && db.SALES_STAGES.indexOf(c.sales_stage) < db.SALES_STAGES.indexOf('Design Appointment Completed')) {
        db.setSalesStage(a.customer_id, 'Design Appointment Completed', {
          substatus: 'Estimate Being Prepared',
          actor: actorOf(req),
          note: 'design appointment completed',
        });
      }
    }
    res.redirect(`${req.body.return_to || '/dashboard/appointments'}?ok=Appointment ${req.body.status}`);
  });

  // ---------- Jobs ----------
  router.get('/dashboard/jobs', requireAuth, (req, res) => {
    const jobs = db.listJobs();
    const body = `
      <h1>Jobs</h1>
      <p class="subtitle">Created automatically when a lead is marked "Sold". Each has a customer-facing status link.</p>
      <div class="panel">
        <table>
          <tr><th>Customer</th><th>Status</th><th>Amount</th><th>Updated</th><th></th></tr>
          ${jobs
            .map(
              (j) => `
            <tr>
              <td><a href="/dashboard/customers/${j.customer_id}">${escapeHtml(j.customer_name)}</a></td>
              <td>${escapeHtml(j.status)}</td>
              <td>${j.sold_amount ? fmtMoney(j.sold_amount) : ''}</td>
              <td>${fmtDate(j.updated_at)}</td>
              <td><a class="btn small secondary" href="/dashboard/jobs/${j.id}">Open</a></td>
            </tr>`
            )
            .join('')}
        </table>
        ${jobs.length === 0 ? '<p class="subtitle">No jobs yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Jobs', active: '/dashboard/jobs', body, flash: flashFromQuery(req.query) }));
  });

  router.get('/dashboard/jobs/:id', requireAuth, (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    const customer = db.getCustomer(job.customer_id);
    const history = db.getJobHistory(job.id);
    const payments = db.listPayments().filter((p) => p.job_id === job.id);
    const paidTotal = payments.reduce((s, p) => s + Number(p.amount), 0);
    const statusUrl = automations.statusUrl(job.public_token);
    const products = db.listProductsForJob(job.id);
    const jobFiles = db.listJobFiles(job.id);

    const body = `
      <h1>Job for ${escapeHtml(customer.name)}</h1>
      <p class="subtitle">Customer link: <a href="${statusUrl}" target="_blank">${statusUrl}</a></p>

      <div class="grid cols-2">
        <div class="panel">
          <h2 style="margin-top:0">Update status</h2>
          <form method="POST" action="/dashboard/jobs/${job.id}/status">
            <label>New status</label>
            <select name="status">${db.JOB_STAGES.map((s) => `<option value="${s}" ${s === job.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
            <label>Note (optional, shown to customer's team, not on public page)</label>
            <input type="text" name="note">
            <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
              <input type="checkbox" name="notify" value="1" style="width:auto" checked> Text/email the customer about this update
            </label>
            <div style="margin-top:12px"><button class="btn" type="submit">Update status</button></div>
          </form>
          <h3>History</h3>
          <ul class="timeline">
            ${history.map((h) => `<li class="done"><div class="status">${escapeHtml(h.status)}</div><div class="when">${fmtDateTime(h.created_at)}${h.note ? ' · ' + escapeHtml(h.note) : ''}</div></li>`).join('')}
          </ul>
        </div>

        <div class="panel">
          <h2 style="margin-top:0">Payments</h2>
          <p>Sold amount: <strong>${job.sold_amount ? fmtMoney(job.sold_amount) : 'not set'}</strong><br>
          Paid so far: <strong>${fmtMoney(paidTotal)}</strong></p>
          <form method="POST" action="/dashboard/jobs/${job.id}/payments">
            <div class="grid cols-2">
              <div><label>Amount ($) *</label><input type="number" step="0.01" name="amount" required></div>
              <div><label>Method</label><input type="text" name="method" placeholder="Check, card, cash, ACH..."></div>
              <div><label>Date</label><input type="date" name="paid_at"></div>
              <div><label>Note</label><input type="text" name="note" placeholder="Deposit, final payment..."></div>
            </div>
            <div style="margin-top:12px"><button class="btn" type="submit">Record payment</button></div>
          </form>
          ${
            payments.length
              ? `<table style="margin-top:14px"><tr><th>Date</th><th>Amount</th><th>Method</th><th>Note</th></tr>${payments
                  .map((p) => `<tr><td>${fmtDate(p.paid_at)}</td><td>${fmtMoney(p.amount)}</td><td>${escapeHtml(p.method || '')}</td><td>${escapeHtml(p.note || '')}</td></tr>`)
                  .join('')}</table>`
              : ''
          }
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Factory order - products</h2>
        <p class="subtitle">Each line sent to the factory, with its own specs, deadline, and status. Shows up on the <a href="/dashboard/production">Factory Queue</a> until delivered. Need a new cabinet type, mount style, rail type, or color in the dropdowns? Add it on the <a href="/dashboard/settings/product-options">Product Options</a> page.</p>
        <form method="POST" action="/dashboard/jobs/${job.id}/products">
          <div class="grid cols-4">
            <div><label>Product / piece name *</label><input type="text" name="name" placeholder="Upper pantry cabinet" required></div>
            <div><label>Cabinet / product type</label>${optionSelect('cabinet_type', '')}</div>
            <div><label>Type code</label>${optionSelect('type_code', '')}</div>
            <div><label>Mount style</label>${optionSelect('mount_style', '')}</div>
            <div><label>Rail type</label>${optionSelect('rail_type', '')}</div>
            <div><label>Color</label>${optionSelect('color', '')}</div>
            <div><label>Divider</label>${optionSelect('divider', '')}</div>
            <div><label>Opening width (mm)</label><input type="number" step="0.1" name="opening_width_mm"></div>
            <div><label>Unit price ($)</label><input type="number" step="0.01" name="unit_price"></div>
            <div><label>Quantity</label><input type="number" name="quantity" value="1" min="1"></div>
            <div><label>Deadline</label><input type="date" name="deadline"></div>
            <div><label>Factory / vendor</label><input type="text" name="factory" placeholder="Who's building it"></div>
            <div><label>Measurements (free text, optional)</label><input type="text" name="measurements" placeholder="36&quot;W x 84&quot;H x 24&quot;D"></div>
            <div><label>Notes</label><input type="text" name="notes"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Add to factory order</button></div>
        </form>
        ${
          products.length
            ? `<div style="overflow-x:auto"><table style="margin-top:16px">
                <tr><th>Product</th><th>Type</th><th>Mount</th><th>Rail</th><th>Color</th><th>Width</th><th>Qty</th><th>Deadline</th><th>Factory</th><th>Status</th></tr>
                ${products
                  .map((p) => {
                    const overdue = p.deadline && p.status !== 'Delivered' && new Date(p.deadline) < new Date();
                    return `<tr>
                      <td>${escapeHtml(p.name)}${p.cabinet_type ? `<div class="subtitle" style="margin:0">${escapeHtml(p.cabinet_type)}</div>` : ''}${p.measurements ? `<div class="subtitle" style="margin:0">${escapeHtml(p.measurements)}</div>` : ''}</td>
                      <td>${escapeHtml(p.type_code || '')}</td>
                      <td>${escapeHtml(p.mount_style || '')}</td>
                      <td>${escapeHtml(p.rail_type || '')}</td>
                      <td>${escapeHtml(p.color || '')}</td>
                      <td>${p.opening_width_mm ? p.opening_width_mm + 'mm' : ''}</td>
                      <td>${p.quantity}</td>
                      <td class="${overdue ? 'overdue' : ''}">${p.deadline ? fmtDate(p.deadline) : ''}${overdue ? ' (overdue)' : ''}</td>
                      <td>${escapeHtml(p.factory || '')}</td>
                      <td>
                        <form method="POST" action="/dashboard/products/${p.id}/status">
                          <input type="hidden" name="return_to" value="/dashboard/jobs/${job.id}">
                          <select name="status" onchange="this.form.submit()">
                            ${db.PRODUCT_STAGES.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
                          </select>
                        </form>
                      </td>
                    </tr>`;
                  })
                  .join('')}
              </table></div>`
            : `<p class="subtitle">No products added to this job's factory order yet.</p>`
        }
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Files</h2>
        <p class="subtitle">Order forms, measurement sheets, invoices, install photos - anything for this job. Also shows on <a href="/dashboard/customers/${customer.id}">${escapeHtml(customer.name)}</a>'s page and is searchable from <a href="/dashboard/files">Files</a>.</p>
        <form method="POST" action="/dashboard/jobs/${job.id}/files" enctype="multipart/form-data">
          <div class="grid cols-2">
            <div><label>File</label><input type="file" name="file" required></div>
            <div><label>Note (optional)</label><input type="text" name="note" placeholder="e.g. signed order form"></div>
          </div>
          <div style="margin-top:12px"><button class="btn secondary" type="submit">Upload</button></div>
        </form>
        ${
          jobFiles.length
            ? `<table style="margin-top:14px"><tr><th>File</th><th>Note</th><th>Uploaded</th><th></th></tr>${jobFiles
                .map(
                  (f) => `<tr>
                    <td><a href="/dashboard/customers/${customer.id}/files/${f.id}" target="_blank">${escapeHtml(f.original_name)}</a>${f.extraction_status === 'done' ? ' <span class="badge">indexed</span>' : ''}</td>
                    <td>${escapeHtml(f.note || '')}</td>
                    <td>${fmtDateTime(f.created_at)}</td>
                    <td style="white-space:nowrap">
                      <form class="inline" method="POST" action="/dashboard/jobs/${job.id}/files/${f.id}/delete" onsubmit="return confirm('Delete this file?')"><button class="btn small danger" type="submit">Delete</button></form>
                    </td>
                  </tr>`
                )
                .join('')}</table>`
            : `<p class="subtitle">No files on this job yet.</p>`
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Job', active: '/dashboard/jobs', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/jobs/:id/files', requireAuth, (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    const upload = (req.files || []).find((f) => f.fieldname === 'file');
    if (!upload || !upload.filename) return res.redirect(`/dashboard/jobs/${job.id}?err=Choose a file first`);
    saveUpload({ customer_id: job.customer_id, job_id: job.id, upload, note: req.body.note || null });
    res.redirect(`/dashboard/jobs/${job.id}?ok=File uploaded`);
  });

  router.post('/dashboard/jobs/:id/files/:fileId/delete', requireAuth, (req, res) => {
    const job = db.getJob(req.params.id);
    const f = db.getCustomerFile(req.params.fileId);
    if (job && f && f.job_id === job.id) db.softDeleteCustomerFile(f.id, actorOf(req));
    res.redirect(`/dashboard/jobs/${req.params.id}?ok=File moved to Deleted Files (recoverable)`);
  });

  // ---------- Unfiled assistant uploads: confirm / reassign / undo ----------
  router.post('/dashboard/customer-files/:id/confirm', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.id);
    if (!f || f.assignment_status !== 'unconfirmed' || !f.suggested_customer_id) {
      return res.status(400).json({ error: 'Nothing to confirm.' });
    }
    db.setFileAssignment(f.id, { customer_id: f.suggested_customer_id, assignment_status: 'confirmed' });
    res.json({ ok: true });
  });
  router.post('/dashboard/customer-files/:id/undo', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    db.setFileAssignment(f.id, { customer_id: null, assignment_status: 'needs_review' });
    res.json({ ok: true });
  });
  router.post('/dashboard/customer-files/:id/assign', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.id);
    if (!f) return res.status(404).send('File not found');
    const customer = db.getCustomer(req.body.customer_id);
    if (!customer) return res.redirect('/dashboard/files?err=Pick a customer#needs-review');
    db.setFileAssignment(f.id, { customer_id: customer.id, assignment_status: 'confirmed' });
    res.redirect(`/dashboard/files?ok=${encodeURIComponent('Filed under ' + customer.name)}#needs-review`);
  });

  // ---------- Files search (across all customers + jobs) ----------
  router.get('/dashboard/files', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim();
    const results = q ? db.searchFiles(q) : [];
    const needsReview = db.listFilesNeedingReview();
    const allCustomers = db.listCustomers();
    const customerOptions = (selectedId) =>
      `<option value="">Pick a customer…</option>${allCustomers
        .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
        .join('')}`;
    const body = `
      <h1>Files</h1>
      ${
        needsReview.length
          ? `<div class="panel" id="needs-review">
              <h2 style="margin-top:0">Needs review (${needsReview.length})</h2>
              <p class="subtitle">Uploaded through the AI Assistant with no confident customer match. Nothing here is attached to any customer's record yet.</p>
              <table><tr><th>File</th><th>Uploaded</th><th>Suggested</th><th>Assign to</th><th></th></tr>${needsReview
                .map(
                  (f) => `<tr>
                    <td>${escapeHtml(f.original_name)}</td>
                    <td>${fmtDate(f.created_at)}</td>
                    <td>${f.assignment_status === 'unconfirmed' ? escapeHtml(f.suggested_customer_name || '') + ' (unconfirmed)' : 'Needs Review - no suggestion'}</td>
                    <td>
                      <form class="inline" method="POST" action="/dashboard/customer-files/${f.id}/assign">
                        <select name="customer_id">${customerOptions(f.suggested_customer_id)}</select>
                        <button class="btn small" type="submit">Assign</button>
                      </form>
                    </td>
                    <td>
                      ${
                        f.assignment_status === 'unconfirmed'
                          ? `<form class="inline" method="POST" action="/dashboard/customer-files/${f.id}/assign"><input type="hidden" name="customer_id" value="${f.suggested_customer_id}"><button class="btn small" type="submit">Confirm</button></form>`
                          : ''
                      }
                    </td>
                  </tr>`
                )
                .join('')}</table>
            </div>`
          : ''
      }
      <p class="subtitle">Search every uploaded file by name, note, or - for order forms and invoices the Assistant has read - their contents.</p>
      <div class="panel">
        <form method="GET" action="/dashboard/files">
          <div class="grid cols-3">
            <div style="grid-column: span 2"><label>Search</label><input type="text" name="q" value="${escapeHtml(q)}" placeholder="customer name, product, invoice number, amount..." autofocus></div>
            <div style="align-self:end"><button class="btn" type="submit">Search</button></div>
          </div>
        </form>
        ${
          !q
            ? '<p class="subtitle">Type something above to search.</p>'
            : results.length
              ? `<table style="margin-top:14px"><tr><th>File</th><th>Customer</th><th>Job</th><th>Match</th><th>Uploaded</th></tr>${results
                  .map(
                    (f) => `<tr>
                      <td><a href="/dashboard/customers/${f.customer_id}/files/${f.id}" target="_blank">${escapeHtml(f.original_name)}</a></td>
                      <td>${f.customer_id ? `<a href="/dashboard/customers/${f.customer_id}">${escapeHtml(f.customer_name || '')}</a>` : ''}</td>
                      <td>${f.job_id ? `<a href="/dashboard/jobs/${f.job_id}">${escapeHtml(f.job_status || 'job')}</a>` : ''}</td>
                      <td class="subtitle" style="margin:0">${escapeHtml(f.snippet || f.note || '')}</td>
                      <td>${fmtDate(f.created_at)}</td>
                    </tr>`
                  )
                  .join('')}</table>`
              : '<p class="subtitle">No files matched.</p>'
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Files', active: '/dashboard/files', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/jobs/:id/products', requireAuth, (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    const {
      name,
      measurements,
      quantity,
      deadline,
      factory,
      notes,
      cabinet_type,
      type_code,
      mount_style,
      rail_type,
      color,
      divider,
      opening_width_mm,
      unit_price,
    } = req.body;
    if (!name) return res.redirect(`/dashboard/jobs/${job.id}?err=Product name is required`);
    db.createProduct({
      job_id: job.id,
      name,
      measurements,
      quantity: Number(quantity) || 1,
      factory,
      notes,
      deadline: deadline ? new Date(deadline).toISOString() : undefined,
      cabinet_type,
      type_code,
      mount_style,
      rail_type,
      color,
      divider,
      opening_width_mm: opening_width_mm ? Number(opening_width_mm) : undefined,
      unit_price: unit_price ? Number(unit_price) : undefined,
    });
    res.redirect(`/dashboard/jobs/${job.id}?ok=Added to factory order`);
  });

  router.post('/dashboard/products/:id/status', requireAuth, (req, res) => {
    const product = db.getProduct(req.params.id);
    if (!product) return res.status(404).send('Product not found');
    db.updateProductStatus(product.id, req.body.status);
    const base = req.body.return_to || `/dashboard/jobs/${product.job_id}`;
    const sep = base.includes('?') ? '&' : '?';
    res.redirect(`${base}${sep}ok=Product status updated`);
  });

  // ---------- Factory Queue ----------
  router.get('/dashboard/production', requireAuth, (req, res) => {
    const includeDelivered = req.query.all === '1';
    const queue = db.listProductionQueue({ includeDelivered });
    const body = `
      <h1>Factory Queue</h1>
      <p class="subtitle">Every product currently on order, across all jobs, soonest deadline first.</p>
      <p class="subtitle">${includeDelivered ? '<a href="/dashboard/production">Hide delivered</a>' : '<a href="/dashboard/production?all=1">Show delivered too</a>'}</p>
      <div class="panel">
        <div style="overflow-x:auto"><table>
          <tr><th>Deadline</th><th>Customer</th><th>Product</th><th>Type</th><th>Mount</th><th>Rail</th><th>Color</th><th>Width</th><th>Qty</th><th>Factory</th><th>Status</th></tr>
          ${queue
            .map((p) => {
              const overdue = p.deadline && p.status !== 'Delivered' && new Date(p.deadline) < new Date();
              return `<tr>
                <td class="${overdue ? 'overdue' : ''}">${p.deadline ? fmtDate(p.deadline) : 'no deadline'}${overdue ? ' (overdue)' : ''}</td>
                <td><a href="/dashboard/jobs/${p.job_id}">${escapeHtml(p.customer_name)}</a></td>
                <td>${escapeHtml(p.name)}${p.cabinet_type ? `<div class="subtitle" style="margin:0">${escapeHtml(p.cabinet_type)}</div>` : ''}${p.measurements ? `<div class="subtitle" style="margin:0">${escapeHtml(p.measurements)}</div>` : ''}</td>
                <td>${escapeHtml(p.type_code || '')}</td>
                <td>${escapeHtml(p.mount_style || '')}</td>
                <td>${escapeHtml(p.rail_type || '')}</td>
                <td>${escapeHtml(p.color || '')}</td>
                <td>${p.opening_width_mm ? p.opening_width_mm + 'mm' : ''}</td>
                <td>${p.quantity}</td>
                <td>${escapeHtml(p.factory || '')}</td>
                <td>
                  <form method="POST" action="/dashboard/products/${p.id}/status">
                    <input type="hidden" name="return_to" value="/dashboard/production${includeDelivered ? '?all=1' : ''}">
                    <select name="status" onchange="this.form.submit()">
                      ${db.PRODUCT_STAGES.map((s) => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                  </form>
                </td>
              </tr>`;
            })
            .join('')}
        </table></div>
        ${queue.length === 0 ? '<p class="subtitle">Nothing in the queue right now.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Factory Queue', active: '/dashboard/production', body, flash: flashFromQuery(req.query) }));
  });

  // ---------- Product Options (editable dropdown lists) ----------
  router.get('/dashboard/settings/product-options', requireAuth, (req, res) => {
    const grouped = db.listAllProductOptionsGrouped();
    const body = `
      <h1>Product Options</h1>
      <p class="subtitle">These are the dropdown choices on the factory order form (Job page). Add whatever your factory actually offers - mount styles, rail types, colors, cabinet types, dividers - no code changes needed.</p>
      <div class="grid cols-2">
        ${db.PRODUCT_OPTION_CATEGORIES.map((cat) => {
          const opts = grouped[cat.key] || [];
          return `<div class="panel">
            <h2 style="margin-top:0">${escapeHtml(cat.label)}</h2>
            <form method="POST" action="/dashboard/settings/product-options">
              <input type="hidden" name="category" value="${cat.key}">
              <div class="grid cols-2">
                <div><label>Code *</label><input type="text" name="code" placeholder="e.g. FE" required></div>
                <div><label>Display label</label><input type="text" name="label" placeholder="optional, defaults to code"></div>
              </div>
              <div style="margin-top:10px"><button class="btn small" type="submit">Add</button></div>
            </form>
            ${
              opts.length
                ? `<table style="margin-top:14px">
                    <tr><th>Code</th><th>Label</th><th></th></tr>
                    ${opts
                      .map(
                        (o) => `<tr>
                          <td>${escapeHtml(o.code)}</td>
                          <td>${escapeHtml(o.label || '')}</td>
                          <td>
                            <form method="POST" action="/dashboard/settings/product-options/${o.id}/delete" style="margin:0">
                              <input type="hidden" name="return_to" value="/dashboard/settings/product-options">
                              <button class="btn small danger" type="submit">Remove</button>
                            </form>
                          </td>
                        </tr>`
                      )
                      .join('')}
                  </table>`
                : `<p class="subtitle">No options yet.</p>`
            }
          </div>`;
        }).join('')}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Product Options', active: '/dashboard/settings/product-options', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/settings/product-options', requireAuth, (req, res) => {
    const { category, code, label } = req.body;
    if (!category || !code) return res.redirect(`/dashboard/settings/product-options?err=Category and code are required`);
    db.createProductOption({ category, code, label });
    res.redirect(`/dashboard/settings/product-options?ok=Option added`);
  });

  router.post('/dashboard/settings/product-options/:id/delete', requireAuth, (req, res) => {
    db.deleteProductOption(req.params.id);
    const base = req.body.return_to || '/dashboard/settings/product-options';
    const sep = base.includes('?') ? '&' : '?';
    res.redirect(`${base}${sep}ok=Option removed`);
  });

  router.post('/dashboard/jobs/:id/status', requireAuth, async (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    const { status, note, notify } = req.body;
    const updated = db.updateJobStatus(job.id, status, note);
    if (notify) {
      const customer = db.getCustomer(job.customer_id);
      try {
        await automations.onJobStatusChanged(updated, customer, status);
      } catch (e) {
        console.error('onJobStatusChanged failed', e);
      }
    }
    res.redirect(`/dashboard/jobs/${job.id}?ok=Status updated`);
  });

  router.post('/dashboard/jobs/:id/payments', requireAuth, (req, res) => {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).send('Job not found');
    const { amount, method, note, paid_at } = req.body;
    if (!amount) return res.redirect(`/dashboard/jobs/${job.id}?err=Amount is required`);
    db.createPayment({
      job_id: job.id,
      amount: Number(amount),
      method,
      note,
      paid_at: paid_at ? new Date(paid_at).toISOString() : undefined,
    });
    res.redirect(`/dashboard/jobs/${job.id}?ok=Payment recorded`);
  });

  // ---------- Bookkeeping (Finances) ----------
  function csvEscape(v) {
    return `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  }
  function toCsv(rows) {
    return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  }
  function bkSubnav(active) {
    const tabs = [
      ['/dashboard/finances', 'Overview'],
      ['/dashboard/finances/expenses', 'Expenses'],
      ['/dashboard/finances/review', 'Needs Review'],
      ['/dashboard/finances/reports', 'Reports'],
    ];
    return `<div style="margin-bottom:16px">${tabs
      .map(([href, label]) => `<a class="btn ${active === href ? '' : 'secondary'} small" href="${href}" style="margin-right:8px">${label}</a>`)
      .join('')}</div>`;
  }
  // Turns plain <input type=date> values (YYYY-MM-DD) into inclusive ISO boundaries.
  function dateRangeToIso(startStr, endStr) {
    return {
      start: `${startStr}T00:00:00.000Z`,
      end: `${endStr}T23:59:59.999Z`,
    };
  }
  function defaultRange() {
    const now = new Date();
    const startOfYear = `${now.getFullYear()}-01-01`;
    const today = now.toISOString().slice(0, 10);
    return { start: startOfYear, end: today };
  }

  router.get('/dashboard/finances', requireAuth, (req, res) => {
    const payments = db.listPayments().slice(0, 25);
    const customers = db.listCustomers();
    const incomeTotal = db.totalIncome();
    const incomeMonth = db.totalIncomeThisMonth();
    const expenseTotal = db.totalExpenses();
    const expenseMonth = db.totalExpensesThisMonth();
    const body = `
      <h1>Bookkeeping</h1>
      <p class="subtitle">Income, expenses, and reports for taxes, P&amp;L, and cash flow. Not a replacement for an accountant - just clean numbers to hand one, or your tax software.</p>
      ${bkSubnav('/dashboard/finances')}
      <div class="grid cols-4">
        <div class="stat"><div class="num">${fmtMoney(incomeMonth)}</div><div class="label">Income this month</div></div>
        <div class="stat"><div class="num">${fmtMoney(expenseMonth)}</div><div class="label">Expenses this month</div></div>
        <div class="stat"><div class="num">${fmtMoney(incomeTotal - expenseTotal)}</div><div class="label">Lifetime net</div></div>
        <div class="stat"><div class="num">${fmtMoney(incomeTotal)}</div><div class="label">Lifetime income</div></div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Log income</h2>
        <p class="subtitle">Job payments are usually logged from the job page. Use this for other income not tied to a job (e.g. scrap materials, misc sales).</p>
        <form method="POST" action="/dashboard/finances/income">
          <div class="grid cols-3">
            <div>
              <label>Customer (optional)</label>
              <select name="customer_id"><option value="">- none -</option>${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
            </div>
            <div><label>Amount ($) *</label><input type="number" step="0.01" name="amount" required></div>
            <div><label>Category</label><select name="category">${db.INCOME_CATEGORIES.map((c) => `<option value="${c}" ${c === 'Other Income' ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            <div><label>Date</label><input type="date" name="paid_at"></div>
            <div><label>Method</label><input type="text" name="method" placeholder="Cash, check, card..."></div>
            <div><label>Note</label><input type="text" name="note"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Log income</button></div>
        </form>
      </div>

      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Recent income (last 25)</h2>
          <a class="btn secondary small" href="/dashboard/finances/income/export.csv">Export all income CSV</a>
        </div>
        <table style="margin-top:12px">
          <tr><th>Date</th><th>Customer</th><th>Category</th><th>Amount</th><th>Method</th><th>Note</th></tr>
          ${payments
            .map(
              (p) =>
                `<tr><td>${fmtDate(p.paid_at)}</td><td>${p.job_customer_id ? `<a href="/dashboard/customers/${p.job_customer_id}">${escapeHtml(p.customer_name || '')}</a>` : escapeHtml(p.customer_name || '-')}</td><td>${escapeHtml(p.category)}</td><td>${fmtMoney(p.amount)}</td><td>${escapeHtml(p.method || '')}</td><td>${escapeHtml(p.note || '')}</td></tr>`
            )
            .join('')}
        </table>
        ${payments.length === 0 ? '<p class="subtitle">No income recorded yet - add one from a job page, or log one above.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Bookkeeping', active: '/dashboard/finances', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/finances/income', requireAuth, (req, res) => {
    const { customer_id, amount, category, method, note, paid_at } = req.body;
    if (!amount) return res.redirect('/dashboard/finances?err=Amount is required');
    db.createPayment({
      customer_id: customer_id || null,
      category: category || 'Other Income',
      amount: Number(amount),
      method,
      note,
      paid_at: paid_at ? new Date(paid_at).toISOString() : undefined,
    });
    res.redirect('/dashboard/finances?ok=Income logged');
  });

  router.get('/dashboard/finances/income/export.csv', requireAuth, (req, res) => {
    const payments = db.listPayments();
    const rows = [['Date', 'Customer', 'Category', 'Amount', 'Method', 'Note', 'Job ID']];
    for (const p of payments) {
      rows.push([fmtDate(p.paid_at), p.customer_name || '', p.category, p.amount, p.method || '', p.note || '', p.job_id || '']);
    }
    res.sendCsv(`income-export-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  });

  // ---------- Expenses ----------
  function coaSelect(name, selected) {
    return `<select name="${name}">
      <option value="">— uncategorized (needs review) —</option>
      ${db
        .chartOfAccounts({ type: 'expense' })
        .map((a) => `<option value="${escapeHtml(a.name)}" ${a.name === selected ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
        .join('')}
    </select>`;
  }

  router.get('/dashboard/finances/expenses', requireAuth, (req, res) => {
    const expenses = db.listExpenses();
    const jobs = db.listJobs();
    const reviewCount = db.listUncategorizedExpenses().length;
    const body = `
      <h1>Bookkeeping</h1>
      <p class="subtitle">Capture expenses now — categorization can wait. Anything without a Chart-of-Accounts category is flagged under <a href="/dashboard/finances/review">Needs Review</a>${reviewCount ? ` (${reviewCount})` : ''}.</p>
      ${bkSubnav('/dashboard/finances/expenses')}
      <div class="panel">
        <h2 style="margin-top:0">Log an expense</h2>
        <p class="subtitle">Tip: the assistant can capture these from a sentence ("spent $84.27 at Lowe's for cabinet hardware") or a receipt photo.</p>
        <form method="POST" action="/dashboard/finances/expenses">
          <div class="grid cols-3">
            <div><label>Amount ($) *</label><input type="number" step="0.01" name="amount" required></div>
            <div><label>Merchant / payee</label><input type="text" name="merchant" placeholder="Lowe's"></div>
            <div><label>Date</label><input type="date" name="expense_date"></div>
            <div><label>Chart of Accounts category</label>${coaSelect('coa_account', '')}</div>
            <div><label>Payment account</label><input type="text" name="payment_account" placeholder="Business checking, Amex…"></div>
            <div><label>Job (optional)</label><select name="job_id"><option value="">— none / overhead —</option>${jobs
              .map((j) => `<option value="${j.id}">${escapeHtml(j.customer_name)} — ${escapeHtml(j.status)}</option>`)
              .join('')}</select></div>
            <div style="grid-column: span 3"><label>Memo / description</label><input type="text" name="memo" placeholder="Cabinet hinges + drawer slides"></div>
          </div>
          <input type="hidden" name="entry_source" value="manual">
          <div style="margin-top:12px"><button class="btn" type="submit">Log expense</button></div>
        </form>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">All expenses</h2>
          <a class="btn secondary small" href="/dashboard/finances/expenses/export.csv">Export CSV</a>
        </div>
        <div style="overflow-x:auto"><table style="margin-top:12px">
          <tr><th>Date</th><th>Category</th><th>Merchant</th><th>Amount</th><th>Account</th><th>Job</th><th>Recon.</th><th></th></tr>
          ${expenses
            .map(
              (e) =>
                `<tr>
                  <td>${fmtDate(e.expense_at || e.expense_date)}</td>
                  <td>${escapeHtml(e.coa_account || e.category)}${e.needs_review ? ' <span class="badge">review</span>' : ''}</td>
                  <td>${escapeHtml(e.merchant || e.vendor || '')}</td>
                  <td>${fmtMoney(e.amount)}</td>
                  <td>${escapeHtml(e.payment_account || '')}</td>
                  <td>${e.job_id ? `<a href="/dashboard/jobs/${e.job_id}">${escapeHtml(e.job_customer_name || '')}</a>` : ''}</td>
                  <td>${escapeHtml(e.reconciliation_status || 'unreconciled')}</td>
                  <td><a class="btn small secondary" href="/dashboard/finances/expenses/${e.id}/edit">Edit</a></td>
                </tr>`
            )
            .join('')}
        </table></div>
        ${expenses.length === 0 ? '<p class="subtitle">No expenses logged yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Expenses', active: '/dashboard/finances/expenses', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/finances/expenses', requireAuth, (req, res) => {
    const { amount, coa_account, expense_date, merchant, memo, payment_account, job_id, entry_source } = req.body;
    if (!amount) return res.redirect('/dashboard/finances/expenses?err=Amount is required');
    const id = db.createExpense({
      job_id: job_id || null,
      amount: Number(amount),
      merchant,
      memo,
      coa_account: coa_account || null, // createExpense auto-suggests when this is blank
      payment_account,
      entry_source: entry_source || 'manual',
      expense_at: expense_date ? new Date(expense_date).toISOString() : undefined,
      created_by: actorOf(req),
    });
    const flagged = db.getExpense(id).needs_review;
    res.redirect(
      `/dashboard/finances/expenses?ok=${encodeURIComponent('Expense captured' + (flagged ? ' - flagged for review (no confident category)' : ''))}`
    );
  });

  router.get('/dashboard/finances/expenses/:id/edit', requireAuth, (req, res) => {
    const e = db.getExpense(req.params.id);
    if (!e) return res.status(404).send('Expense not found');
    const jobs = db.listJobs();
    const candidates = db.findExpenseMatchCandidates({ amount: e.amount, date: e.expense_at || e.expense_date });
    const body = `
      ${backLink('/dashboard/finances/expenses', 'Cancel — back to Expenses')}
      <h1>Edit expense</h1>
      <div class="panel">
        <form method="POST" action="/dashboard/finances/expenses/${e.id}">
          <div class="grid cols-3">
            <div><label>Amount ($)</label><input type="number" step="0.01" name="amount" value="${e.amount}"></div>
            <div><label>Merchant</label><input type="text" name="merchant" value="${escapeHtml(e.merchant || e.vendor || '')}"></div>
            <div><label>Date</label><input type="date" name="expense_date" value="${escapeHtml((e.expense_at || e.expense_date || '').slice(0, 10))}"></div>
            <div><label>Category</label>${coaSelect('coa_account', e.coa_account)}</div>
            <div><label>Payment account</label><input type="text" name="payment_account" value="${escapeHtml(e.payment_account || '')}"></div>
            <div><label>Reconciliation</label><select name="reconciliation_status">${['unreconciled', 'matched', 'reconciled'].map((s) => `<option ${s === e.reconciliation_status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
            <div><label>Job</label><select name="job_id"><option value="">— none —</option>${jobs.map((j) => `<option value="${j.id}" ${j.id === e.job_id ? 'selected' : ''}>${escapeHtml(j.customer_name)} — ${escapeHtml(j.status)}</option>`).join('')}</select></div>
            <div style="grid-column: span 2"><label>Memo</label><input type="text" name="memo" value="${escapeHtml(e.memo || e.note || '')}"></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn" type="submit">Save</button>
            <a class="btn secondary" href="/dashboard/finances/expenses">Cancel</a>
          </div>
        </form>
      </div>
      ${
        e.entry_source && e.entry_source !== 'bank_import'
          ? `<p class="subtitle">When a bank/card import is added later, a transaction of ${fmtMoney(e.amount)} near ${fmtDate(e.expense_at || e.expense_date)} should be <strong>matched</strong> to this row (external_ref is currently empty), not entered again. ${candidates.length > 1 ? `${candidates.length - 1} other captured expense(s) also fall in that match window.` : ''}</p>`
          : ''
      }
    `;
    res.send(dashboardLayout({ title: 'Edit expense', active: '/dashboard/finances/expenses', body }));
  });

  router.post('/dashboard/finances/expenses/:id', requireAuth, (req, res) => {
    const e = db.getExpense(req.params.id);
    if (!e) return res.status(404).send('Expense not found');
    db.updateExpense(
      e.id,
      {
        amount: req.body.amount,
        merchant: req.body.merchant,
        memo: req.body.memo,
        coa_account: req.body.coa_account || null,
        payment_account: req.body.payment_account,
        job_id: req.body.job_id || null,
        reconciliation_status: req.body.reconciliation_status,
        expense_at: req.body.expense_date ? new Date(req.body.expense_date).toISOString() : undefined,
        needs_review: req.body.coa_account ? 0 : 1,
      },
      { actor: actorOf(req) }
    );
    res.redirect(`${req.body.return_to || '/dashboard/finances/expenses'}?ok=Expense updated`);
  });

  // Needs Review: expenses captured without a confident category.
  router.get('/dashboard/finances/review', requireAuth, (req, res) => {
    const rows = db.listUncategorizedExpenses();
    const body = `
      <h1>Bookkeeping</h1>
      <p class="subtitle">Expenses captured without a certain category. Assign one — or leave it and come back later.</p>
      ${bkSubnav('/dashboard/finances/review')}
      <div class="panel">
        ${
          rows.length
            ? rows
                .map(
                  (e) => `<form method="POST" action="/dashboard/finances/expenses/${e.id}" style="border-bottom:1px solid var(--line);padding:12px 0">
                    <input type="hidden" name="return_to" value="/dashboard/finances/review">
                    <input type="hidden" name="amount" value="${e.amount}">
                    <input type="hidden" name="merchant" value="${escapeHtml(e.merchant || e.vendor || '')}">
                    <input type="hidden" name="memo" value="${escapeHtml(e.memo || e.note || '')}">
                    <input type="hidden" name="payment_account" value="${escapeHtml(e.payment_account || '')}">
                    <input type="hidden" name="reconciliation_status" value="${escapeHtml(e.reconciliation_status || 'unreconciled')}">
                    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                      <strong>${fmtMoney(e.amount)}</strong>
                      <span>${escapeHtml(e.merchant || e.vendor || 'unknown merchant')}</span>
                      <span class="subtitle">${fmtDate(e.expense_at || e.expense_date)}${e.memo ? ' · ' + escapeHtml(e.memo) : ''}</span>
                      ${coaSelect('coa_account', db.suggestExpenseAccount(`${e.merchant || ''} ${e.memo || ''}`))}
                      <button class="btn small" type="submit">Save</button>
                      ${e.receipt_file_id ? '<span class="badge">receipt attached</span>' : ''}
                    </div>
                  </form>`
                )
                .join('')
            : '<p class="subtitle">Nothing needs review. 🎉</p>'
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Needs Review', active: '/dashboard/finances/review', body, flash: flashFromQuery(req.query) }));
  });

  router.get('/dashboard/finances/expenses/export.csv', requireAuth, (req, res) => {
    const expenses = db.listExpenses();
    const rows = [['Date', 'Category', 'Vendor', 'Amount', 'Method', 'Job Customer', 'Note']];
    for (const e of expenses) {
      rows.push([fmtDate(e.expense_date), e.category, e.vendor || '', e.amount, e.method || '', e.job_customer_name || '', e.note || '']);
    }
    res.sendCsv(`expenses-export-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  });

  // ---------- Reports: P&L, Cash Flow, Tax Summary ----------
  router.get('/dashboard/finances/reports', requireAuth, (req, res) => {
    const type = req.query.type || 'pl';
    const def = defaultRange();
    const startStr = req.query.start || def.start;
    const endStr = req.query.end || def.end;
    const year = req.query.year || String(new Date().getFullYear());
    const { start, end } = dateRangeToIso(startStr, endStr);

    const reportTabs = ['pl', 'cashflow', 'tax'];
    const tabLabels = { pl: 'Profit & Loss', cashflow: 'Cash Flow', tax: 'Tax Summary' };
    const tabsHtml = reportTabs
      .map((t) => `<a class="btn ${t === type ? '' : 'secondary'} small" href="/dashboard/finances/reports?type=${t}" style="margin-right:8px">${tabLabels[t]}</a>`)
      .join('');

    let reportBody = '';
    if (type === 'pl') {
      const r = db.profitLoss(start, end);
      reportBody = `
        <form method="GET" action="/dashboard/finances/reports" style="margin-bottom:16px">
          <input type="hidden" name="type" value="pl">
          <div class="grid cols-3">
            <div><label>From</label><input type="date" name="start" value="${startStr}"></div>
            <div><label>To</label><input type="date" name="end" value="${endStr}"></div>
            <div style="align-self:end"><button class="btn secondary" type="submit">Update range</button></div>
          </div>
        </form>
        <div class="grid cols-3">
          <div class="stat"><div class="num">${fmtMoney(r.income)}</div><div class="label">Total income</div></div>
          <div class="stat"><div class="num">${fmtMoney(r.expenses)}</div><div class="label">Total expenses</div></div>
          <div class="stat"><div class="num">${fmtMoney(r.net)}</div><div class="label">Net profit</div></div>
        </div>
        <div class="grid cols-2">
          <div class="panel">
            <h3 style="margin-top:0">Income by category</h3>
            <table><tr><th>Category</th><th>Amount</th></tr>${r.incomeByCategory.map((c) => `<tr><td>${escapeHtml(c.category)}</td><td>${fmtMoney(c.total)}</td></tr>`).join('')}</table>
            ${r.incomeByCategory.length === 0 ? '<p class="subtitle">No income in this range.</p>' : ''}
          </div>
          <div class="panel">
            <h3 style="margin-top:0">Expenses by category</h3>
            <table><tr><th>Category</th><th>Amount</th></tr>${r.expensesByCategory.map((c) => `<tr><td>${escapeHtml(c.category)}</td><td>${fmtMoney(c.total)}</td></tr>`).join('')}</table>
            ${r.expensesByCategory.length === 0 ? '<p class="subtitle">No expenses in this range.</p>' : ''}
          </div>
        </div>
        <a class="btn secondary" href="/dashboard/finances/reports/export.csv?type=pl&start=${startStr}&end=${endStr}">Export this report as CSV</a>
      `;
    } else if (type === 'cashflow') {
      const months = db.cashFlowByMonth(start, end);
      reportBody = `
        <form method="GET" action="/dashboard/finances/reports" style="margin-bottom:16px">
          <input type="hidden" name="type" value="cashflow">
          <div class="grid cols-3">
            <div><label>From</label><input type="date" name="start" value="${startStr}"></div>
            <div><label>To</label><input type="date" name="end" value="${endStr}"></div>
            <div style="align-self:end"><button class="btn secondary" type="submit">Update range</button></div>
          </div>
        </form>
        <div class="panel">
          <table>
            <tr><th>Month</th><th>Income</th><th>Expenses</th><th>Net</th><th>Running balance</th></tr>
            ${months
              .map(
                (m) =>
                  `<tr><td>${m.month}</td><td>${fmtMoney(m.income)}</td><td>${fmtMoney(m.expenses)}</td><td>${fmtMoney(m.net)}</td><td>${fmtMoney(m.runningBalance)}</td></tr>`
              )
              .join('')}
          </table>
          ${months.length === 0 ? '<p class="subtitle">No activity in this range.</p>' : ''}
        </div>
        <a class="btn secondary" href="/dashboard/finances/reports/export.csv?type=cashflow&start=${startStr}&end=${endStr}">Export this report as CSV</a>
      `;
    } else if (type === 'tax') {
      const r = db.taxYearSummary(year);
      const yearOptions = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
      reportBody = `
        <form method="GET" action="/dashboard/finances/reports" style="margin-bottom:16px">
          <input type="hidden" name="type" value="tax">
          <div class="grid cols-3">
            <div><label>Tax year</label><select name="year" onchange="this.form.submit()">${yearOptions.map((y) => `<option value="${y}" ${String(y) === String(year) ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
          </div>
        </form>
        <p class="subtitle">Organized totals for your accountant or tax software - not tax advice, and not a substitute for a professional's review.</p>
        <div class="grid cols-3">
          <div class="stat"><div class="num">${fmtMoney(r.income)}</div><div class="label">Total income - ${year}</div></div>
          <div class="stat"><div class="num">${fmtMoney(r.expenses)}</div><div class="label">Total expenses - ${year}</div></div>
          <div class="stat"><div class="num">${fmtMoney(r.net)}</div><div class="label">Net (est. taxable profit)</div></div>
        </div>
        <div class="panel">
          <h3 style="margin-top:0">Expenses by category (${year})</h3>
          <table><tr><th>Category</th><th>Amount</th></tr>${r.expensesByCategory.map((c) => `<tr><td>${escapeHtml(c.category)}</td><td>${fmtMoney(c.total)}</td></tr>`).join('')}</table>
          ${r.expensesByCategory.length === 0 ? '<p class="subtitle">No expenses recorded for this year.</p>' : ''}
        </div>
        <a class="btn secondary" href="/dashboard/finances/reports/export.csv?type=tax&year=${year}">Export this report as CSV</a>
      `;
    }

    const body = `
      <h1>Bookkeeping</h1>
      <p class="subtitle">Reports built from your logged income and expenses.</p>
      ${bkSubnav('/dashboard/finances/reports')}
      <div style="margin-bottom:16px">${tabsHtml}</div>
      ${reportBody}
    `;
    res.send(dashboardLayout({ title: 'Reports', active: '/dashboard/finances/reports', body, flash: flashFromQuery(req.query) }));
  });

  router.get('/dashboard/finances/reports/export.csv', requireAuth, (req, res) => {
    const type = req.query.type || 'pl';
    let rows = [];
    let filename = 'report.csv';

    if (type === 'pl') {
      const { start: startStr, end: endStr } = req.query;
      const { start, end } = dateRangeToIso(startStr, endStr);
      const r = db.profitLoss(start, end);
      rows = [
        ['Profit & Loss', `${startStr} to ${endStr}`],
        [],
        ['Total Income', r.income],
        ['Total Expenses', r.expenses],
        ['Net Profit', r.net],
        [],
        ['Income by category'],
        ['Category', 'Amount'],
        ...r.incomeByCategory.map((c) => [c.category, c.total]),
        [],
        ['Expenses by category'],
        ['Category', 'Amount'],
        ...r.expensesByCategory.map((c) => [c.category, c.total]),
      ];
      filename = `pl-report-${startStr}-to-${endStr}.csv`;
    } else if (type === 'cashflow') {
      const { start: startStr, end: endStr } = req.query;
      const { start, end } = dateRangeToIso(startStr, endStr);
      const months = db.cashFlowByMonth(start, end);
      rows = [
        ['Month', 'Income', 'Expenses', 'Net', 'Running Balance'],
        ...months.map((m) => [m.month, m.income, m.expenses, m.net, m.runningBalance]),
      ];
      filename = `cashflow-report-${startStr}-to-${endStr}.csv`;
    } else if (type === 'tax') {
      const year = req.query.year || String(new Date().getFullYear());
      const r = db.taxYearSummary(year);
      rows = [
        [`Tax Summary ${year}`],
        [],
        ['Total Income', r.income],
        ['Total Expenses', r.expenses],
        ['Net (est. taxable profit)', r.net],
        [],
        ['Expenses by category'],
        ['Category', 'Amount'],
        ...r.expensesByCategory.map((c) => [c.category, c.total]),
      ];
      filename = `tax-summary-${year}.csv`;
    }

    res.sendCsv(filename, toCsv(rows));
  });

  // ---------- Booking link / QR ----------
  router.get('/dashboard/booking-link', requireAuth, (req, res) => {
    const url = automations.bookingUrl();
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(url)}`;
    const consultants = db.listConsultants();
    const pickedName = (req.query.consultant || '').trim();
    const hsUrl = pickedName ? `${url}?consultant=${encodeURIComponent(pickedName)}&lead_source=Home%20Show` : '';
    const hsQr = hsUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(hsUrl)}` : '';

    const body = `
      <h1>Booking Link / QR Code</h1>
      <p class="subtitle">Customers scan this or visit the link to pick their own appointment time - no login needed.</p>
      <div class="panel">
        <div class="qr-box">
          <img src="${qrImg}" alt="QR code to booking page" width="280" height="280">
          <p class="link-copy">${escapeHtml(url)}</p>
          <p class="subtitle">Print this and post it at your shop, add it to invoices, or drop it in a text/email.</p>
          <p class="subtitle" style="font-size:0.78rem">(QR image is generated by a free third-party service loaded in your browser - the link itself is served by this app.)</p>
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Home Show link (credits a consultant)</h2>
        <p class="subtitle" style="margin-top:0">Pick the salesperson working the booth. The link and QR below pre-tag every booking as <strong>Home Show</strong> and credit them with the lead and any appointment booked - it shows on the KPI scoreboard.</p>
        <form method="GET" action="/dashboard/booking-link" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
          <div>
            <label>Consultant</label>
            <input type="text" name="consultant" list="consultant-list" value="${escapeHtml(pickedName)}" placeholder="Type a name" autocomplete="off">
            <datalist id="consultant-list">${consultants.map((c) => `<option value="${escapeHtml(c.name)}">`).join('')}</datalist>
          </div>
          <button class="btn" type="submit">Make link</button>
        </form>
        ${
          hsUrl
            ? `<div class="qr-box" style="margin-top:14px">
                 <img src="${hsQr}" alt="Home Show QR for ${escapeHtml(pickedName)}" width="280" height="280">
                 <p class="link-copy">${escapeHtml(hsUrl)}</p>
                 <p class="subtitle">Every booking from this code credits <strong>${escapeHtml(pickedName)}</strong>.</p>
               </div>`
            : ''
        }
        ${
          consultants.length
            ? `<p class="subtitle" style="margin-top:10px">Consultants on file: ${consultants.map((c) => escapeHtml(c.name)).join(' · ')}</p>`
            : '<p class="subtitle" style="margin-top:10px">No consultants yet - just type a name above; it\'s created the first time it\'s used.</p>'
        }
      </div>
    `;
    res.send(dashboardLayout({ title: 'Booking Link', active: '/dashboard/booking-link', body, flash: flashFromQuery(req.query) }));
  });

  // ---------- Office Manager Assistant (BETA - global chat box) ----------
  router.post('/dashboard/assistant/message', requireAuth, async (req, res) => {
    const message = (req.body.message || '').trim();
    const redirectTo = req.body.redirect_to || '/dashboard';
    if (!message) return res.redirect(`${redirectTo}?err=Type something for the assistant first`);

    const result = await assistant.handleMessage(message);
    const target =
      result.navigateTo ||
      (result.changedCustomerId ? `/dashboard/customers/${result.changedCustomerId}` : redirectTo);
    const param = result.error ? 'err' : 'ok';
    res.redirect(`${target}${target.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(result.summary)}`);
  });

  router.post('/dashboard/assistant/reset', requireAuth, (req, res) => {
    assistant.resetConversation();
    const redirectTo = req.body.redirect_to || '/dashboard';
    res.redirect(`${redirectTo}?ok=Assistant conversation cleared`);
  });

  // JSON versions of the two routes above, used by the in-widget chat log so
  // it can show the reply without leaving/reloading the page. The form-post
  // routes above stay as a fallback for anyone with JS off.
  router.get('/dashboard/assistant/history', requireAuth, (req, res) => {
    res.json({ history: assistant.getHistory() });
  });

  // Reads the stored bytes for a customer_files row back off disk, so a file
  // uploaded on an earlier request can still be handed to the model.
  function readStoredFile(fileRow) {
    if (!fileRow || !fileRow.stored_name) return null;
    const p = path.join(UPLOADS_DIR, fileRow.customer_id || '_unassigned', fileRow.stored_name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  // Attachment upload is now a SEPARATE, fast request from sending a chat
  // message. It just saves the file and hands back a reference. This is why a
  // slow or failed assistant call can no longer lose an attachment (spec 16):
  // the bytes are already on disk and the widget keeps the returned file_id to
  // retry with.
  router.post('/dashboard/assistant/upload', requireAuth, async (req, res) => {
    try {
      const upload = req.files && req.files[0] ? req.files[0] : null;
      if (!upload || !upload.filename) {
        return res.status(400).json({ error: 'No file received. Pick a file and try again.' });
      }
      // Uploads always save unassigned (spec B4) - the customer on screen is
      // NOT enough to file it there. Resolution happens in /assistant/chat
      // once the accompanying message names someone (or doesn't).
      const fileId = saveUpload({
        customer_id: null,
        job_id: null,
        upload,
        note: 'Uploaded via assistant chat',
        assignment_status: 'needs_review',
      });
      const analyzable =
        (upload.mimeType || '').startsWith('image/') ||
        upload.mimeType === 'application/pdf' ||
        (upload.mimeType || '').startsWith('text/') ||
        /\.(txt|csv|md|pdf|jpe?g|png|webp|gif)$/i.test(upload.filename);
      return res.json({
        ok: true,
        file_id: fileId,
        filename: upload.filename,
        mime: upload.mimeType || 'application/octet-stream',
        size: upload.data.length,
        analyzable,
      });
    } catch (err) {
      console.error('[assistant/upload] failed:', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'Could not save that file. It was not stored - try again.' });
    }
  });

  router.post('/dashboard/assistant/chat', requireAuth, async (req, res) => {
    const started = Date.now();
    let stage = 'start';
    try {
      const message = (req.body.message || '').trim();
      const ctxCustomer = req.body.context_customer_id ? db.getCustomer(req.body.context_customer_id) : null;
      const context = ctxCustomer ? { customerId: ctxCustomer.id } : {};
      if (req.body.mode === 'voice') context.mode = 'voice';

      // Attachment arrives one of two ways:
      //  - file_id: already uploaded via /assistant/upload (preferred path)
      //  - a raw multipart file on this same request (legacy / JS-off fallback)
      let file = null;
      stage = 'attachment';
      if (req.body.file_id) {
        const row = db.getCustomerFile(req.body.file_id);
        const buf = row ? readStoredFile(row) : null;
        if (row && buf) {
          file = {
            id: row.id,
            filename: row.original_name || row.stored_name,
            mimeType: row.mime_type || 'application/octet-stream',
            buffer: buf,
          };
        } else {
          console.warn('[assistant/chat] file_id given but bytes not found:', req.body.file_id);
        }
      } else if (req.files && req.files[0] && req.files[0].filename) {
        const upload = req.files[0];
        const fileId = saveUpload({
          customer_id: null,
          job_id: null,
          upload,
          note: 'Uploaded via assistant chat',
          assignment_status: 'needs_review',
        });
        file = {
          id: fileId,
          filename: upload.filename,
          mimeType: upload.mimeType || 'application/octet-stream',
          buffer: upload.data,
        };
      }

      if (!message && !file) {
        return res.status(400).json({ error: 'Type something or attach a file first.' });
      }

      // Decide who an unfiled attachment belongs to (spec B4). A customer
      // named IN THE MESSAGE always wins, even over the record on screen -
      // the on-screen customer only ever produces an "unconfirmed" suggestion,
      // never a silent attach. Only runs once per file (guarded on
      // assignment_status), so a file already confirmed/corrected earlier in
      // this conversation is never re-decided by a later message.
      let fileAssignment = null;
      stage = 'fileAssignment';
      if (file) {
        const fileRow = db.getCustomerFile(file.id);
        if (fileRow && fileRow.assignment_status === 'needs_review' && !fileRow.customer_id) {
          const decision = db.decideFileAssignment({ message, ctxCustomer });
          db.setFileAssignment(file.id, decision);
          if (decision.assignment_status !== 'needs_review') {
            fileAssignment = { file_id: file.id, status: decision.assignment_status, customer_id: decision.customer_id, suggested_customer_id: decision.suggested_customer_id, customer_name: decision.customer.name };
          }
          // else: no name, no on-screen customer - stays needs_review, surfaced later from the Files page.
        }
      }

      stage = 'handleMessage';
      const result = await assistant.handleMessage(message, context, { file });
      console.log(
        `[assistant/chat] ok in ${Date.now() - started}ms` +
          (file ? ` (file ${file.mimeType} ${Math.round(file.buffer.length / 1024)}KB)` : '') +
          (result.error ? ' [assistant returned error]' : '')
      );
      return res.json({
        summary: result.summary,
        error: !!result.error,
        changedCustomerId: result.changedCustomerId || null,
        navigateTo: result.navigateTo || null,
        fileAssignment,
      });
    } catch (err) {
      console.error(
        `[assistant/chat] FAILED at stage "${stage}" after ${Date.now() - started}ms:`,
        err && err.stack ? err.stack : err
      );
      // Always JSON, always 200-shaped for the widget - it distinguishes on the
      // `error` flag, not the HTTP status, so a thrown error still renders as a
      // readable message instead of the generic "could not reach" catch.
      return res.status(200).json({
        error: true,
        summary:
          'The assistant hit an error handling that' +
          (stage === 'handleMessage' ? ' (while thinking/using tools).' : ` (${stage}).`) +
          ' Your message and attachment are kept - press Retry.',
      });
    }
  });
}

module.exports = { register };
