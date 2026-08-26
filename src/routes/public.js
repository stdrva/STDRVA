const db = require('../db');
const { publicLayout, BUSINESS_NAME } = require('../render');
const { escapeHtml, fmtDate, fmtDateTime, normalizePhone, isValidEmail } = require('../util');
const automations = require('../services/automations');

const HOURS_START = Number(process.env.BUSINESS_HOURS_START || 9); // 24h, local server time
const HOURS_END = Number(process.env.BUSINESS_HOURS_END || 17);
const BUSINESS_DAYS = (process.env.BUSINESS_DAYS || '1,2,3,4,5').split(',').map(Number); // 0=Sun..6=Sat
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);
const BOOKING_WINDOW_DAYS = Number(process.env.BOOKING_WINDOW_DAYS || 14);

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function upcomingBusinessDays() {
  const days = [];
  const now = new Date();
  for (let i = 0; days.length < BOOKING_WINDOW_DAYS && i < BOOKING_WINDOW_DAYS + 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (BUSINESS_DAYS.includes(d.getDay())) days.push(d);
  }
  return days;
}

function slotsForDate(dateStr, durationMin) {
  // dateStr: YYYY-MM-DD (interpreted in server local time)
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, HOURS_START, 0, 0);
  const dayEnd = new Date(y, m - 1, d, HOURS_END, 0, 0);
  const now = new Date();
  const existing = db.listAppointmentsBetween(dayStart.toISOString(), dayEnd.toISOString());

  const slots = [];
  for (let t = new Date(dayStart); t.getTime() + durationMin * 60000 <= dayEnd.getTime(); t = new Date(t.getTime() + SLOT_MINUTES * 60000)) {
    if (t < now) continue;
    const slotEnd = new Date(t.getTime() + durationMin * 60000);
    const conflict = existing.some((a) => {
      const aStart = new Date(a.scheduled_at);
      const aEnd = new Date(aStart.getTime() + (a.duration_min || 60) * 60000);
      return t < aEnd && slotEnd > aStart;
    });
    if (!conflict) slots.push(new Date(t));
  }
  return slots;
}

function durationForType(type) {
  const map = {
    'Free Consultation': 30,
    'In-Home Measure': 60,
    'Design Review': 45,
    Install: 240,
  };
  return map[type] || 60;
}

function register(router) {
  router.get('/book', (req, res) => {
    const type = req.query.type || db.APPT_TYPES[0];
    const dateSel = req.query.date || '';
    const days = upcomingBusinessDays();
    const duration = durationForType(type);

    const typeOptions = db.APPT_TYPES.map(
      (t) => `<a class="btn ${t === type ? '' : 'secondary'} small" href="/book?type=${encodeURIComponent(t)}" style="margin:0 6px 6px 0">${t}</a>`
    ).join('');

    const dayButtons = days
      .map((d) => {
        const key = dateKey(d);
        const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        return `<a class="btn ${key === dateSel ? '' : 'secondary'} small" href="/book?type=${encodeURIComponent(type)}&date=${key}" style="margin:0 6px 6px 0">${label}</a>`;
      })
      .join('');

    let slotsHtml = '';
    if (dateSel) {
      const slots = slotsForDate(dateSel, duration);
      slotsHtml = slots.length
        ? `<div class="slot-grid">${slots
            .map((s) => {
              const hhmm = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
              const label = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
              return `<a class="slot-btn" href="/book/confirm?type=${encodeURIComponent(type)}&date=${dateSel}&time=${hhmm}">${label}</a>`;
            })
            .join('')}</div>`
        : `<p class="subtitle">No open times that day - try another date.</p>`;
    }

    const body = `
      <div class="public-hero">
        <h1>Book with ${escapeHtml(BUSINESS_NAME)}</h1>
        <p class="subtitle">Pick a service, a day, then a time. No account needed.</p>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">1. What do you need?</h3>
        ${typeOptions}
      </div>
      <div class="panel">
        <h3 style="margin-top:0">2. Choose a day</h3>
        ${dayButtons}
      </div>
      ${dateSel ? `<div class="panel"><h3 style="margin-top:0">3. Choose a time</h3>${slotsHtml}</div>` : ''}
    `;
    res.send(publicLayout({ title: 'Book an appointment', body }));
  });

  router.get('/book/confirm', (req, res) => {
    const { type, date, time } = req.query;
    if (!type || !date || !time) return res.redirect('/book');
    const when = new Date(`${date}T${time}:00`);
    const body = `
      <div class="public-hero">
        <h1>Confirm your appointment</h1>
        <p class="subtitle">${escapeHtml(type)} &middot; ${when.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
      </div>
      <div class="panel">
        <form method="POST" action="/book">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <input type="hidden" name="date" value="${escapeHtml(date)}">
          <input type="hidden" name="time" value="${escapeHtml(time)}">
          <label>Name *</label><input type="text" name="name" required>
          <label>Phone *</label><input type="tel" name="phone" required placeholder="(804) 555-0100">
          <label>Email</label><input type="email" name="email">
          <label>Anything we should know?</label><textarea name="notes"></textarea>
          <div style="margin-top:14px"><button class="btn" type="submit">Confirm booking</button></div>
        </form>
        <p class="subtitle" style="margin-top:10px"><a href="/book">&larr; pick a different time</a></p>
      </div>
    `;
    res.send(publicLayout({ title: 'Confirm appointment', body }));
  });

  router.post('/book', async (req, res) => {
    const { type, date, time, name, phone, email, notes } = req.body;
    if (!name || !phone || !date || !time) {
      return res.send(publicLayout({ title: 'Booking error', body: `<div class="panel"><p>Missing required info. <a href="/book">Start over</a>.</p></div>` }));
    }
    const phoneNorm = normalizePhone(phone);
    const emailVal = isValidEmail(email) ? email : null;

    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
    if (!customer) {
      customer = db.createCustomer({ name, phone: phoneNorm, email: emailVal, notes });
    }
    // Make sure this customer is represented in the funnel.
    const existingLeads = db.listLeads().filter((l) => l.customer_id === customer.id);
    let lead = existingLeads.find((l) => l.stage !== 'Sold' && l.stage !== 'Lost');
    if (!lead) lead = db.createLead({ customer_id: customer.id, stage: 'Contacted', source: 'Self-service booking' });

    const scheduledAt = new Date(`${date}T${time}:00`).toISOString();
    const duration = durationForType(type);
    const appt = db.createAppointment({
      customer_id: customer.id,
      lead_id: lead.id,
      type,
      scheduled_at: scheduledAt,
      duration_min: duration,
      notes,
    });

    try {
      await automations.onAppointmentBooked(appt, customer);
    } catch (e) {
      console.error('onAppointmentBooked failed', e);
    }

    const body = `
      <div class="public-hero">
        <h1>You're booked!</h1>
        <p class="subtitle">${escapeHtml(type)} on ${new Date(scheduledAt).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
      </div>
      <div class="panel">
        <p>We've sent a confirmation${customer.phone ? ' text' : ''}${customer.phone && customer.email ? ' and' : ''}${customer.email ? ' email' : ''} to you. We'll also remind you before your appointment.</p>
        <p>See you then!</p>
      </div>
    `;
    res.send(publicLayout({ title: 'Booked', body }));
  });

  // ---------- Public job status page ----------
  router.get('/status/:token', (req, res) => {
    const job = db.getJobByToken(req.params.token);
    if (!job) {
      return res.status(404).send(publicLayout({ title: 'Not found', body: `<div class="panel"><p>We couldn't find that project. Double check the link, or contact us.</p></div>` }));
    }
    const customer = db.getCustomer(job.customer_id);
    const history = db.getJobHistory(job.id);
    const stages = db.JOB_STAGES;
    const currentIdx = stages.indexOf(job.status);

    const timeline = stages
      .map((s, i) => {
        const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
        const histEntry = history.find((h) => h.status === s);
        return `<li class="${cls}"><div class="status">${escapeHtml(s)}</div>${histEntry ? `<div class="when">${fmtDate(histEntry.created_at)}</div>` : ''}</li>`;
      })
      .join('');

    const body = `
      <div class="public-hero">
        <h1>Hi ${escapeHtml(customer.name.split(' ')[0])}</h1>
        <p class="subtitle">Here's where your project stands.</p>
      </div>
      <div class="panel">
        <h2 style="margin-top:0">Status: ${escapeHtml(job.status)}</h2>
        <ul class="timeline">${timeline}</ul>
      </div>
      <div class="panel">
        <p class="subtitle" style="margin:0">Questions about your project? Just reply to the text or email we sent you, or give us a call.</p>
      </div>
    `;
    res.send(publicLayout({ title: 'Your project status', body }));
  });
}

module.exports = { register };
