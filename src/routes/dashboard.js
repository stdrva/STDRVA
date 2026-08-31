const fs = require('fs');
const path = require('path');
const db = require('../db');
const { dashboardLayout, flashFromQuery } = require('../render');
const { escapeHtml, fmtMoney, fmtDate, fmtDateTime, normalizePhone, newId } = require('../util');
const automations = require('../services/automations');
const assistant = require('../services/assistant');

// Uploaded customer files (photos, measurement docs, contracts) live on the
// persistent disk under data/uploads/<customer_id>/<generated-name> - never
// under a web-servable static path, since these are private records only
// reachable through the authenticated download route below.
const UPLOADS_DIR = path.join(db.DATA_DIR, 'uploads');
function customerUploadsDir(customerId) {
  const dir = path.join(UPLOADS_DIR, customerId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stageBadgeClass(stage) {
  return { 'New Lead': 'new', Contacted: 'contacted', Quoted: 'quoted', Sold: 'sold', Lost: 'lost' }[stage] || '';
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
    const leads = db.listLeads();
    const openLeads = leads.filter((l) => l.stage !== 'Sold' && l.stage !== 'Lost');
    const jobs = db.listJobs();
    const activeJobs = jobs.filter((j) => j.status !== 'Complete');
    const upcoming = db.listAppointments({ upcomingOnly: true }).slice(0, 6);
    const recentMsgs = db.listRecentMessages(8);
    const incomeMonth = db.totalIncomeThisMonth();
    const incomeTotal = db.totalIncome();
    const expenseMonth = db.totalExpensesThisMonth();
    const expenseTotal = db.totalExpenses();

    const body = `
      <h1>Overview</h1>
      <p class="subtitle">${escapeHtml(require('../render').BUSINESS_NAME)} at a glance</p>
      <div class="grid cols-4">
        <div class="stat"><div class="num">${customers.length}</div><div class="label">Customers</div></div>
        <div class="stat"><div class="num">${openLeads.length}</div><div class="label">Open leads in funnel</div></div>
        <div class="stat"><div class="num">${activeJobs.length}</div><div class="label">Active jobs</div></div>
        <div class="stat"><div class="num">${fmtMoney(incomeMonth - expenseMonth)}</div><div class="label">Net this month</div></div>
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
          <h2 style="margin-top:0">Recent messages</h2>
          ${
            recentMsgs.length
              ? `<table><tr><th>When</th><th>Customer</th><th>Channel</th><th>Status</th></tr>${recentMsgs
                  .map(
                    (m) =>
                      `<tr><td>${fmtDateTime(m.created_at)}</td><td>${escapeHtml(m.customer_name)}</td><td>${m.channel}</td><td>${escapeHtml(m.status || '')}</td></tr>`
                  )
                  .join('')}</table>`
              : `<p class="subtitle">No messages sent yet.</p>`
          }
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
    const customers = db.listCustomers();
    const body = `
      <h1>Customers</h1>
      <div class="panel">
        <h2 style="margin-top:0">Add a customer</h2>
        <form method="POST" action="/dashboard/customers">
          <div class="grid cols-2">
            <div><label>Name *</label><input type="text" name="name" required></div>
            <div><label>Phone</label><input type="tel" name="phone" placeholder="(804) 555-0100"></div>
            <div><label>Email</label><input type="email" name="email"></div>
            <div><label>Address</label><input type="text" name="address"></div>
          </div>
          <label>Notes</label><textarea name="notes"></textarea>
          <div style="margin-top:12px"><button class="btn" type="submit">Add customer</button></div>
        </form>
      </div>
      <div class="panel">
        <table>
          <tr><th>Name</th><th>Phone</th><th>Email</th><th>Added</th></tr>
          ${customers
            .map(
              (c) =>
                `<tr><td><a href="/dashboard/customers/${c.id}">${escapeHtml(c.name)}</a></td><td>${escapeHtml(c.phone || '')}</td><td>${escapeHtml(c.email || '')}</td><td>${fmtDate(c.created_at)}</td></tr>`
            )
            .join('')}
        </table>
        ${customers.length === 0 ? '<p class="subtitle">No customers yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Customers', active: '/dashboard/customers', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/customers', requireAuth, (req, res) => {
    const { name, phone, email, address, notes } = req.body;
    if (!name) return res.redirect('/dashboard/customers?err=Name is required');
    const c = db.createCustomer({ name, phone: normalizePhone(phone), email, address, notes });
    res.redirect(`/dashboard/customers/${c.id}?ok=Customer added`);
  });

  router.get('/dashboard/customers/:id', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const leads = db.listLeads().filter((l) => l.customer_id === c.id);
    const jobs = db.listJobs().filter((j) => j.customer_id === c.id);
    const appts = db.listAppointments().filter((a) => a.customer_id === c.id);
    const messages = db.listMessagesForCustomer(c.id);
    const files = db.listCustomerFiles(c.id);

    const body = `
      <h1>${escapeHtml(c.name)}</h1>
      <p class="subtitle">Customer since ${fmtDate(c.created_at)}</p>

      <div class="grid cols-2">
        <div class="panel">
          <h2 style="margin-top:0">Contact info</h2>
          <form method="POST" action="/dashboard/customers/${c.id}">
            <label>Name *</label><input type="text" name="name" value="${escapeHtml(c.name)}" required>
            <label>Phone</label><input type="tel" name="phone" value="${escapeHtml(c.phone || '')}">
            <label>Email</label><input type="email" name="email" value="${escapeHtml(c.email || '')}">
            <label>Address</label><input type="text" name="address" value="${escapeHtml(c.address || '')}">
            <label>Notes</label><textarea name="notes">${escapeHtml(c.notes || '')}</textarea>
            <div style="margin-top:12px"><button class="btn" type="submit">Save</button></div>
          </form>
        </div>

        <div class="panel">
          <h2 style="margin-top:0">Send a message</h2>
          <form method="POST" action="/dashboard/customers/${c.id}/message">
            <label>Channel</label>
            <select name="channel">
              <option value="sms">Text (SMS)</option>
              <option value="email">Email</option>
            </select>
            <label>Message</label>
            <textarea name="body" placeholder="Type a message to send now..." required></textarea>
            <div style="margin-top:12px"><button class="btn" type="submit">Send</button></div>
          </form>
          <h3>History</h3>
          ${
            messages.length
              ? `<table><tr><th>When</th><th>Ch.</th><th>Dir.</th><th>Body</th><th>Status</th></tr>${messages
                  .map(
                    (m) =>
                      `<tr><td>${fmtDateTime(m.created_at)}</td><td>${m.channel}</td><td>${m.direction}</td><td>${escapeHtml((m.body || '').slice(0, 80))}</td><td>${escapeHtml(m.status || '')}</td></tr>`
                  )
                  .join('')}</table>`
              : `<p class="subtitle">No messages yet.</p>`
          }
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Files</h2>
        <p class="subtitle">Photos, measurement sheets, contracts - anything for this customer. Only visible here in the dashboard.</p>
        <form method="POST" action="/dashboard/customers/${c.id}/files" enctype="multipart/form-data">
          <div class="grid cols-2">
            <div><label>File</label><input type="file" name="file" required></div>
            <div><label>Note (optional)</label><input type="text" name="note" placeholder="e.g. kitchen measurements"></div>
          </div>
          <div style="margin-top:12px"><button class="btn secondary" type="submit">Upload</button></div>
        </form>
        ${
          files.length
            ? `<table style="margin-top:14px"><tr><th>File</th><th>Note</th><th>Uploaded</th><th></th></tr>${files
                .map(
                  (f) => `<tr>
                    <td><a href="/dashboard/customers/${c.id}/files/${f.id}" target="_blank">${escapeHtml(f.original_name)}</a></td>
                    <td>${escapeHtml(f.note || '')}</td>
                    <td>${fmtDateTime(f.created_at)}</td>
                    <td><form class="inline" method="POST" action="/dashboard/customers/${c.id}/files/${f.id}/delete" onsubmit="return confirm('Delete this file?')"><button class="btn small danger" type="submit">Delete</button></form></td>
                  </tr>`
                )
                .join('')}</table>`
            : `<p class="subtitle">No files yet.</p>`
        }
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Leads / funnel</h2>
        <form method="POST" action="/dashboard/leads">
          <input type="hidden" name="customer_id" value="${c.id}">
          <div class="grid cols-3">
            <div><label>Source</label><input type="text" name="source" placeholder="Referral, Google, walk-in..."></div>
            <div><label>Estimate value ($)</label><input type="number" step="0.01" name="estimate_value"></div>
            <div><label>Notes</label><input type="text" name="notes"></div>
          </div>
          <div style="margin-top:12px"><button class="btn secondary" type="submit">Add to funnel as New Lead</button></div>
        </form>
        ${
          leads.length
            ? `<table style="margin-top:14px"><tr><th>Stage</th><th>Source</th><th>Est. value</th><th>Updated</th></tr>${leads
                .map(
                  (l) =>
                    `<tr><td><span class="badge ${stageBadgeClass(l.stage)}">${escapeHtml(l.stage)}</span></td><td>${escapeHtml(l.source || '')}</td><td>${l.estimate_value ? fmtMoney(l.estimate_value) : ''}</td><td>${fmtDate(l.updated_at)}</td></tr>`
                )
                .join('')}</table>`
            : ''
        }
      </div>

      <div class="grid cols-2">
        <div class="panel">
          <h2 style="margin-top:0">Appointments</h2>
          ${
            appts.length
              ? `<table><tr><th>When</th><th>Type</th><th>Status</th></tr>${appts
                  .map((a) => `<tr><td>${fmtDateTime(a.scheduled_at)}</td><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.status)}</td></tr>`)
                  .join('')}</table>`
              : `<p class="subtitle">None yet.</p>`
          }
          <a class="btn small secondary" href="/dashboard/appointments?customer_id=${c.id}">Schedule one</a>
        </div>
        <div class="panel">
          <h2 style="margin-top:0">Jobs</h2>
          ${
            jobs.length
              ? `<table><tr><th>Status</th><th>Amount</th><th>Link</th></tr>${jobs
                  .map(
                    (j) =>
                      `<tr><td><a href="/dashboard/jobs/${j.id}">${escapeHtml(j.status)}</a></td><td>${j.sold_amount ? fmtMoney(j.sold_amount) : ''}</td><td><a href="/status/${j.public_token}" target="_blank">customer link</a></td></tr>`
                  )
                  .join('')}</table>`
              : `<p class="subtitle">No jobs yet - mark a lead "Sold" to create one.</p>`
          }
        </div>
      </div>
    `;
    res.send(dashboardLayout({ title: c.name, active: '/dashboard/customers', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/customers/:id', requireAuth, (req, res) => {
    const { name, phone, email, address, notes } = req.body;
    db.updateCustomer(req.params.id, { name, phone: normalizePhone(phone), email, address, notes });
    res.redirect(`/dashboard/customers/${req.params.id}?ok=Saved`);
  });

  // ---------- Customer files (photos, measurement docs, contracts) ----------
  router.post('/dashboard/customers/:id/files', requireAuth, (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const upload = (req.files || []).find((f) => f.fieldname === 'file');
    if (!upload || !upload.filename) {
      return res.redirect(`/dashboard/customers/${c.id}?err=Choose a file first`);
    }
    const ext = path.extname(upload.filename);
    const storedName = `${newId()}${ext}`;
    fs.writeFileSync(path.join(customerUploadsDir(c.id), storedName), upload.data);
    db.createCustomerFile({
      customer_id: c.id,
      stored_name: storedName,
      original_name: upload.filename,
      mime_type: upload.mimeType,
      size: upload.data.length,
      note: req.body.note || null,
    });
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

  router.post('/dashboard/customers/:id/files/:fileId/delete', requireAuth, (req, res) => {
    const f = db.getCustomerFile(req.params.fileId);
    if (f && f.customer_id === req.params.id) {
      const filePath = path.join(customerUploadsDir(f.customer_id), f.stored_name);
      fs.existsSync(filePath) && fs.unlinkSync(filePath);
      db.deleteCustomerFile(f.id);
    }
    res.redirect(`/dashboard/customers/${req.params.id}?ok=File deleted`);
  });

  router.post('/dashboard/customers/:id/message', requireAuth, async (req, res) => {
    const c = db.getCustomer(req.params.id);
    if (!c) return res.status(404).send('Customer not found');
    const { channel, body } = req.body;
    if (channel === 'email') {
      await require('../services/email').sendEmail({
        to: c.email,
        subject: `Message from ${require('../render').BUSINESS_NAME}`,
        html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
        customer_id: c.id,
        logMessage: db.logMessage,
      });
    } else {
      await require('../services/sms').sendSms({ to: c.phone, body, customer_id: c.id, logMessage: db.logMessage });
    }
    res.redirect(`/dashboard/customers/${c.id}?ok=Message sent (see history + console if SMS/email isn't configured yet)`);
  });

  // ---------- Funnel ----------
  router.get('/dashboard/funnel', requireAuth, (req, res) => {
    const leads = db.listLeads();
    const cols = db.LEAD_STAGES.map((stage) => {
      const inStage = leads.filter((l) => l.stage === stage);
      return `
        <div class="funnel-col">
          <h3>${stage} <span class="badge">${inStage.length}</span></h3>
          ${inStage
            .map(
              (l) => `
            <div class="lead-card">
              <div class="name"><a href="/dashboard/customers/${l.customer_id}">${escapeHtml(l.customer_name)}</a></div>
              <div class="meta">${escapeHtml(l.source || 'no source')}${l.estimate_value ? ' · ' + fmtMoney(l.estimate_value) : ''}</div>
              <form method="POST" action="/dashboard/leads/${l.id}/stage">
                <select name="stage" onchange="this.form.submit()">
                  ${db.LEAD_STAGES.map((s) => `<option value="${s}" ${s === l.stage ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
              </form>
            </div>`
            )
            .join('')}
        </div>`;
    }).join('');

    const body = `
      <h1>Funnel</h1>
      <p class="subtitle">Move a lead to "Sold" and a job is created automatically, with a tracking link texted/emailed to the customer.</p>
      <div class="panel">
        <h2 style="margin-top:0">New lead (new or existing customer)</h2>
        <form method="POST" action="/dashboard/leads/quick">
          <div class="grid cols-3">
            <div><label>Name *</label><input type="text" name="name" required></div>
            <div><label>Phone</label><input type="tel" name="phone"></div>
            <div><label>Email</label><input type="email" name="email"></div>
            <div><label>Source</label><input type="text" name="source" placeholder="Referral, Google, walk-in..."></div>
            <div><label>Estimate value ($)</label><input type="number" step="0.01" name="estimate_value"></div>
            <div><label>Notes</label><input type="text" name="notes"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Add lead</button></div>
        </form>
      </div>
      <div class="funnel">${cols}</div>
    `;
    res.send(dashboardLayout({ title: 'Funnel', active: '/dashboard/funnel', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/leads', requireAuth, (req, res) => {
    const { customer_id, source, estimate_value, notes } = req.body;
    const lead = db.createLead({ customer_id, source, estimate_value, notes });
    automations.onLeadCreated(lead, db.getCustomer(customer_id)).catch((e) => console.error(e));
    res.redirect(`/dashboard/customers/${customer_id}?ok=Lead added to funnel`);
  });

  // Quick-add: creates the customer (or reuses an existing match by phone/email) and a lead in one step.
  router.post('/dashboard/leads/quick', requireAuth, async (req, res) => {
    const { name, phone, email, source, estimate_value, notes } = req.body;
    if (!name) return res.redirect('/dashboard/funnel?err=Name is required');
    const phoneNorm = normalizePhone(phone);
    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, email);
    if (!customer) customer = db.createCustomer({ name, phone: phoneNorm, email });
    const lead = db.createLead({ customer_id: customer.id, source, estimate_value, notes });
    try {
      await automations.onLeadCreated(lead, customer);
    } catch (e) {
      console.error('onLeadCreated failed', e);
    }
    res.redirect('/dashboard/funnel?ok=Lead added and welcome message sent');
  });

  router.post('/dashboard/leads/:id/stage', requireAuth, async (req, res) => {
    const lead = db.getLead(req.params.id);
    if (!lead) return res.status(404).send('Lead not found');
    const { stage } = req.body;
    db.updateLeadStage(lead.id, stage);

    if (stage === 'Sold') {
      const customer = db.getCustomer(lead.customer_id);
      const job = db.createJob({ lead_id: lead.id, customer_id: lead.customer_id, sold_amount: lead.estimate_value });
      try {
        await automations.onJobCreated(job, customer);
      } catch (e) {
        console.error('onJobCreated failed', e);
      }
    }
    res.redirect('/dashboard/funnel?ok=Stage updated');
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
        <table>
          <tr><th>When</th><th>Customer</th><th>Type</th><th>Status</th><th>Reminder</th><th></th></tr>
          ${appts
            .map(
              (a) => `
            <tr>
              <td>${fmtDateTime(a.scheduled_at)}</td>
              <td><a href="/dashboard/customers/${a.customer_id}">${escapeHtml(a.customer_name)}</a></td>
              <td>${escapeHtml(a.type)}</td>
              <td>${escapeHtml(a.status)}</td>
              <td>${a.reminder_sent ? 'sent' : '-'}</td>
              <td>
                ${
                  a.status === 'scheduled'
                    ? `<form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="completed"><button class="btn small secondary" type="submit">Complete</button></form>
                       <form class="inline" method="POST" action="/dashboard/appointments/${a.id}/status"><input type="hidden" name="status" value="canceled"><button class="btn small danger" type="submit">Cancel</button></form>`
                    : ''
                }
              </td>
            </tr>`
            )
            .join('')}
        </table>
        ${appts.length === 0 ? '<p class="subtitle">No appointments yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Appointments', active: '/dashboard/appointments', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/appointments', requireAuth, async (req, res) => {
    const { customer_id, type, scheduled_at, duration_min, notes } = req.body;
    if (!customer_id || !scheduled_at) return res.redirect('/dashboard/appointments?err=Customer and time are required');
    const iso = new Date(scheduled_at).toISOString();
    const appt = db.createAppointment({ customer_id, type, scheduled_at: iso, duration_min: Number(duration_min) || 60, notes });
    res.redirect('/dashboard/appointments?ok=Appointment scheduled');
  });

  router.post('/dashboard/appointments/:id/status', requireAuth, (req, res) => {
    db.updateAppointmentStatus(req.params.id, req.body.status);
    res.redirect('/dashboard/appointments?ok=Updated');
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
    `;
    res.send(dashboardLayout({ title: 'Job', active: '/dashboard/jobs', body, flash: flashFromQuery(req.query) }));
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
  router.get('/dashboard/finances/expenses', requireAuth, (req, res) => {
    const expenses = db.listExpenses();
    const jobs = db.listJobs();
    const body = `
      <h1>Bookkeeping</h1>
      <p class="subtitle">Business expenses. Attach one to a job to see true job cost/margin later.</p>
      ${bkSubnav('/dashboard/finances/expenses')}
      <div class="panel">
        <h2 style="margin-top:0">Log an expense</h2>
        <form method="POST" action="/dashboard/finances/expenses">
          <div class="grid cols-3">
            <div><label>Amount ($) *</label><input type="number" step="0.01" name="amount" required></div>
            <div><label>Category</label><select name="category">${db.EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div>
            <div><label>Date</label><input type="date" name="expense_date"></div>
            <div><label>Vendor / paid to</label><input type="text" name="vendor"></div>
            <div><label>Method</label><input type="text" name="method" placeholder="Card, check, cash..."></div>
            <div>
              <label>Job (optional - for job costing)</label>
              <select name="job_id"><option value="">- none / overhead -</option>${jobs.map((j) => `<option value="${j.id}">${escapeHtml(j.customer_name)} - ${escapeHtml(j.status)}</option>`).join('')}</select>
            </div>
            <div style="grid-column: span 3"><label>Note</label><input type="text" name="note"></div>
          </div>
          <div style="margin-top:12px"><button class="btn" type="submit">Log expense</button></div>
        </form>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">All expenses</h2>
          <a class="btn secondary small" href="/dashboard/finances/expenses/export.csv">Export CSV</a>
        </div>
        <table style="margin-top:12px">
          <tr><th>Date</th><th>Category</th><th>Vendor</th><th>Amount</th><th>Job</th><th>Note</th></tr>
          ${expenses
            .map(
              (e) =>
                `<tr><td>${fmtDate(e.expense_date)}</td><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.vendor || '')}</td><td>${fmtMoney(e.amount)}</td><td>${e.job_id ? `<a href="/dashboard/jobs/${e.job_id}">${escapeHtml(e.job_customer_name || '')}</a>` : ''}</td><td>${escapeHtml(e.note || '')}</td></tr>`
            )
            .join('')}
        </table>
        ${expenses.length === 0 ? '<p class="subtitle">No expenses logged yet.</p>' : ''}
      </div>
    `;
    res.send(dashboardLayout({ title: 'Expenses', active: '/dashboard/finances/expenses', body, flash: flashFromQuery(req.query) }));
  });

  router.post('/dashboard/finances/expenses', requireAuth, (req, res) => {
    const { amount, category, expense_date, vendor, method, note, job_id } = req.body;
    if (!amount) return res.redirect('/dashboard/finances/expenses?err=Amount is required');
    db.createExpense({
      job_id: job_id || null,
      amount: Number(amount),
      category,
      vendor,
      method,
      note,
      expense_date: expense_date ? new Date(expense_date).toISOString() : undefined,
    });
    res.redirect('/dashboard/finances/expenses?ok=Expense logged');
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
    const body = `
      <h1>Booking Link / QR Code</h1>
      <p class="subtitle">Customers scan this or visit the link to pick their own appointment time - no login needed.</p>
      <div class="panel">
        <div class="qr-box">
          <img src="${qrImg}" alt="QR code to booking page" width="280" height="280">
          <p class="link-copy">${url}</p>
          <p class="subtitle">Print this and post it at your shop, add it to invoices, or drop it in a text/email.</p>
          <p class="subtitle" style="font-size:0.78rem">(QR image is generated by a free third-party service loaded in your browser - the link itself is served by this app.)</p>
        </div>
      </div>
      <div class="panel">
        <h2 style="margin-top:0">Business hours used for available slots</h2>
        <p class="subtitle">Set via environment variables: BUSINESS_HOURS_START, BUSINESS_HOURS_END, BUSINESS_DAYS, SLOT_MINUTES, BOOKING_WINDOW_DAYS. See README.</p>
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
    const target = result.changedCustomerId ? `/dashboard/customers/${result.changedCustomerId}` : redirectTo;
    const param = result.error ? 'err' : 'ok';
    res.redirect(`${target}?${param}=${encodeURIComponent(result.summary)}`);
  });

  router.post('/dashboard/assistant/reset', requireAuth, (req, res) => {
    assistant.resetConversation();
    const redirectTo = req.body.redirect_to || '/dashboard';
    res.redirect(`${redirectTo}?ok=Assistant conversation cleared`);
  });
}

module.exports = { register };
