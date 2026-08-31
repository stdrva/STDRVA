const db = require('../db');
const { publicLayout, BUSINESS_NAME } = require('../render');
const { escapeHtml, fmtDate, fmtDateTime, normalizePhone, isValidEmail } = require('../util');
const automations = require('../services/automations');

const HOURS_START = Number(process.env.BUSINESS_HOURS_START || 9); // 24h, local server time
const HOURS_END = Number(process.env.BUSINESS_HOURS_END || 17);
const BUSINESS_DAYS = (process.env.BUSINESS_DAYS || '1,2,3,4,5').split(',').map(Number); // 0=Sun..6=Sat
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 60);
const BOOKING_WINDOW_DAYS = Number(process.env.BOOKING_WINDOW_DAYS || 14);
// Keep the day picker from looking wide-open: don't offer anything sooner than
// this many days out, and cap how many day-options show per calendar week.
const BOOKING_MIN_LEAD_DAYS = Number(process.env.BOOKING_MIN_LEAD_DAYS || 4);
const BOOKING_MAX_DAYS_PER_WEEK = Number(process.env.BOOKING_MAX_DAYS_PER_WEEK || 3);

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekStartKey(d) {
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  return dateKey(sunday);
}

function upcomingBusinessDays() {
  const days = [];
  const now = new Date();
  const weekCounts = new Map();
  for (let i = BOOKING_MIN_LEAD_DAYS; days.length < BOOKING_WINDOW_DAYS && i < BOOKING_MIN_LEAD_DAYS + 90; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!BUSINESS_DAYS.includes(d.getDay())) continue;
    const wk = weekStartKey(d);
    const count = weekCounts.get(wk) || 0;
    if (count >= BOOKING_MAX_DAYS_PER_WEEK) continue;
    weekCounts.set(wk, count + 1);
    days.push(d);
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
    'Short Design Consultation': 60,
    'Long Design Consultation': 120,
    'Design Review': 45,
    'Repair or Warranty': 60,
    Install: 240,
  };
  return map[type] || 60;
}

// Options that don't need a calendar slot at all - handled as a quick request instead of a booking.
const REQUEST_TYPES = ['Callback by Owner', 'More Info by Email'];

const TYPE_DESCRIPTIONS = {
  'Short Design Consultation': 'Up to 1 hour. Best if you already know what you want and mainly need a quote.',
  'Long Design Consultation': 'For larger spaces, multiple rooms, complications, highly custom work, or a design with a free organizational plan.',
  'Design Review': 'Reviewing a proposed design before moving forward.',
  'Repair or Warranty': 'Already a customer and need something fixed or covered under warranty.',
  'Callback by Owner': 'Skip scheduling - Andrew calls you back directly.',
  'More Info by Email': 'Skip scheduling - get details by email, no call needed.',
};

// Public-facing order: schedulable types (minus internal-only "Install"), then the two quick-request options.
const PUBLIC_TYPE_ORDER = [...db.APPT_TYPES.filter((t) => t !== 'Install'), ...REQUEST_TYPES];

// ---------- 5-question discovery wizard (asked on every booking / request form) ----------
const ROOM_OPTIONS = ['Kitchen', 'Bathroom(s)', 'Garage', 'Shop', 'Studio', 'Commercial', 'Hidden kick-panel', 'Closet'];

const PRODUCT_LIST = [
  'Pull-out shelves',
  'Premium hardwood pull-out shelves',
  'Blind corner',
  'Lazy Susan corner',
  'Adjustable pantry pull-out',
  'Under sink options',
  'Bathroom options',
  'Spice options',
  'Tray options',
  'Deeper drawers',
  'LED cabinet lighting',
  'Backsplash',
  'Paint Cabinets',
  'New Cabinet Doors',
  'Cabinet modification',
  'Soft close hinge replacement',
  'Soft close rail upgrade to existing drawers',
  'Trash can pull-outs',
  'Organizing services',
  'Entry door refinish',
  'Kick panel secret drawer',
  'Not sure yet - show me what you recommend',
];

function discoveryWizard(summaryHtml, skipLabel, submitLabel) {
  return `
    <div class="wizard">
      ${summaryHtml ? `<div class="wizard-summary">${summaryHtml}</div>` : ''}
      <div class="wizard-progress">Question <span id="wq-num">1</span> of 5</div>

      <div class="wizard-step" data-step="1">
        <label>1. Where are you looking to make a change? (choose all that apply)</label>
        <div class="checkbox-grid">
          ${ROOM_OPTIONS.map(
            (r) => `<label class="checkbox-item"><input type="checkbox" name="rooms" value="${escapeHtml(r)}"> ${escapeHtml(r)}</label>`
          ).join('')}
        </div>
      </div>

      <div class="wizard-step" data-step="2" hidden>
        <label>2. Do you have any pets?</label>
        <div class="radio-row">
          <label class="checkbox-item"><input type="radio" name="has_pets" value="Yes" onchange="wqToggle('pets-detail', true)"> Yes</label>
          <label class="checkbox-item"><input type="radio" name="has_pets" value="No" onchange="wqToggle('pets-detail', false)" checked> No</label>
        </div>
        <div id="pets-detail" hidden style="margin-top:10px">
          <label>OK if we bring a treat?</label>
          <div class="radio-row">
            <label class="checkbox-item"><input type="radio" name="pet_treat_ok" value="Yes"> Yes</label>
            <label class="checkbox-item"><input type="radio" name="pet_treat_ok" value="No"> No</label>
          </div>
          <label>Pet name(s) and breed(s)</label>
          <input type="text" name="pet_details" placeholder="e.g. Biscuit, Lab mix">
        </div>
      </div>

      <div class="wizard-step" data-step="3" hidden>
        <label>3. Have you had pull-out shelves before?</label>
        <div class="radio-row">
          <label class="checkbox-item"><input type="radio" name="had_pullouts" value="Yes" onchange="wqToggle('pullout-detail', true)"> Yes</label>
          <label class="checkbox-item"><input type="radio" name="had_pullouts" value="No" onchange="wqToggle('pullout-detail', false)" checked> No</label>
        </div>
        <div id="pullout-detail" hidden style="margin-top:10px">
          <label>What did you like about them?</label>
          <input type="text" name="pullout_liked">
          <label>What didn't you like?</label>
          <input type="text" name="pullout_disliked">
        </div>
      </div>

      <div class="wizard-step" data-step="4" hidden>
        <label>4. Which products would you like us to show you at your appointment? (choose all that apply)</label>
        <div class="checkbox-grid">
          ${PRODUCT_LIST.map(
            (p) => `<label class="checkbox-item"><input type="checkbox" name="products" value="${escapeHtml(p)}"> ${escapeHtml(p)}</label>`
          ).join('')}
        </div>
        <p class="subtitle" style="margin:8px 0 0">Picking several? A Long Design Consultation gives enough time to cover it all.</p>
      </div>

      <div class="wizard-step" data-step="5" hidden>
        <label>5. Anything else we should know?</label>
        <textarea name="notes"></textarea>
      </div>

      <div class="wizard-nav">
        <button type="button" class="btn secondary" id="wq-back" onclick="wqNav(-1)" hidden>Back</button>
        <button type="button" class="btn" id="wq-next" onclick="wqNav(1)">Next</button>
        <button type="submit" class="btn" id="wq-submit" hidden>${escapeHtml(submitLabel || 'Submit')}</button>
      </div>
      <div class="wizard-skip">
        <button type="submit" class="btn-link">${escapeHtml(skipLabel || 'Skip all of this and continue')}</button>
      </div>
    </div>
    <script>
      (function() {
        var step = 1;
        var total = 5;
        function show() {
          document.querySelectorAll('.wizard-step').forEach(function(el) {
            el.hidden = Number(el.dataset.step) !== step;
          });
          var numEl = document.getElementById('wq-num');
          var backBtn = document.getElementById('wq-back');
          var nextBtn = document.getElementById('wq-next');
          var submitBtn = document.getElementById('wq-submit');
          if (numEl) numEl.textContent = step;
          if (backBtn) backBtn.hidden = step === 1;
          if (nextBtn) nextBtn.hidden = step === total;
          if (submitBtn) submitBtn.hidden = step !== total;
        }
        window.wqNav = function(delta) {
          step = Math.min(total, Math.max(1, step + delta));
          show();
        };
        window.wqToggle = function(id, on) {
          var el = document.getElementById(id);
          if (el) el.hidden = !on;
        };
        show();
      })();
    </script>`;
}

function discoveryFromBody(body) {
  const rooms = [].concat(body.rooms || []).filter(Boolean);
  const products = [].concat(body.products || []).filter(Boolean);
  const parts = [];
  if (rooms.length) parts.push(`Rooms: ${rooms.join(', ')}`);
  if (body.has_pets === 'Yes') {
    parts.push(`Pets: yes${body.pet_details ? ' (' + body.pet_details + ')' : ''}, treat OK: ${body.pet_treat_ok || 'unspecified'}`);
  }
  if (body.had_pullouts === 'Yes') {
    parts.push(`Prior pull-outs: liked "${body.pullout_liked || ''}", disliked "${body.pullout_disliked || ''}"`);
  }
  if (products.length) parts.push(`Interested in: ${products.join(', ')}`);
  if (body.notes) parts.push(body.notes);
  return { rooms, notesWithDiscovery: parts.join(' | ') };
}

function register(router) {
  router.get('/book', (req, res) => {
    const type = req.query.type || PUBLIC_TYPE_ORDER[0];
    const dateSel = req.query.date || '';
    const isRequestType = REQUEST_TYPES.includes(type);
    const days = isRequestType ? [] : upcomingBusinessDays();
    const duration = durationForType(type);

    const typeOptions = PUBLIC_TYPE_ORDER.map((t) => {
      const selected = t === type;
      const prominent = t === 'Short Design Consultation';
      const cls = ['type-card', prominent ? 'featured' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
      return `
        <a class="${cls}" href="/book?type=${encodeURIComponent(t)}">
          <span class="type-name">${escapeHtml(t)}</span>${prominent ? '<span class="type-tag">Most popular</span>' : ''}
          <div class="type-desc">${escapeHtml(TYPE_DESCRIPTIONS[t] || '')}</div>
        </a>`;
    }).join('');

    if (isRequestType) {
      const body = `
        <div class="public-hero">
          <h1>Let's Get Started</h1>
          <div class="rule"></div>
          <p class="subtitle">Pick a service. No account needed.</p>
        </div>
        <div class="panel">
          <h3 style="margin-top:0">1. What do you need?</h3>
          ${typeOptions}
        </div>
        <div class="panel">
          <h3 style="margin-top:0">2. What do you want to know?</h3>
          <form method="POST" action="/book/request" onsubmit="if(this.dataset.sent)return false;this.dataset.sent='1';">
            <input type="hidden" name="type" value="${escapeHtml(type)}">
            <textarea name="notes" placeholder="Tell us what you're looking for..." rows="4"></textarea>
            <label>Name *</label><input type="text" name="name" required>
            <label>Phone *</label><input type="tel" name="phone" required placeholder="(804) 555-0100">
            <label>Email</label><input type="email" name="email">
            <div style="margin-top:14px"><button class="btn" type="submit">${type === 'Callback by Owner' ? 'Request a callback' : 'Submit request'}</button></div>
          </form>
        </div>
      `;
      return res.send(publicLayout({ title: 'Request info', body }));
    }

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
        <h1>Let's Get Started</h1>
        <div class="rule"></div>
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
        <form method="POST" action="/book" onsubmit="if(this.dataset.sent)return false;this.dataset.sent='1';">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <input type="hidden" name="date" value="${escapeHtml(date)}">
          <input type="hidden" name="time" value="${escapeHtml(time)}">
          <label>Name *</label><input type="text" name="name" required>
          <label>Phone *</label><input type="tel" name="phone" required placeholder="(804) 555-0100">
          <label>Email</label><input type="email" name="email">
          ${discoveryWizard(
            `${escapeHtml(type)} with <strong>Andrew</strong><br>${when.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
            'Skip all of this and confirm appointment',
            'Confirm booking'
          )}
        </form>
        <p class="subtitle" style="margin-top:10px"><a href="/book">&larr; pick a different time</a></p>
      </div>
    `;
    res.send(publicLayout({ title: 'Confirm appointment', body }));
  });

  router.post('/book', async (req, res) => {
    const { type, date, time, name, phone, email } = req.body;
    if (!name || !phone || !date || !time) {
      return res.send(publicLayout({ title: 'Booking error', body: `<div class="panel"><p>Missing required info. <a href="/book">Start over</a>.</p></div>` }));
    }
    const phoneNorm = normalizePhone(phone);
    const emailVal = isValidEmail(email) ? email : null;
    const { notesWithDiscovery } = discoveryFromBody(req.body);

    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
    if (!customer) {
      customer = db.createCustomer({ name, phone: phoneNorm, email: emailVal, notes: notesWithDiscovery });
    }
    // Make sure this customer is represented in the funnel.
    const existingLeads = db.listLeads().filter((l) => l.customer_id === customer.id);
    let lead = existingLeads.find((l) => l.stage !== 'Sold' && l.stage !== 'Lost');
    if (!lead) lead = db.createLead({ customer_id: customer.id, stage: 'Contacted', source: 'Self-service booking' });

    const scheduledAt = new Date(`${date}T${time}:00`).toISOString();
    const duration = durationForType(type);

    // Idempotency guard: a double-click, slow-network retry, or a resubmit via
    // the browser's back button can all fire this same POST twice. If this
    // customer already has an appointment at this exact time/type, treat the
    // resubmit as a no-op instead of creating a duplicate.
    let appt = db
      .listAppointments()
      .find((a) => a.customer_id === customer.id && a.scheduled_at === scheduledAt && a.type === type);
    if (!appt) {
      appt = db.createAppointment({
        customer_id: customer.id,
        lead_id: lead.id,
        type,
        scheduled_at: scheduledAt,
        duration_min: duration,
        notes: notesWithDiscovery,
      });
      try {
        await automations.onAppointmentBooked(appt, customer);
      } catch (e) {
        console.error('onAppointmentBooked failed', e);
      }
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

  router.post('/book/request', async (req, res) => {
    const { type, name, phone, email } = req.body;
    if (!name || !phone || !REQUEST_TYPES.includes(type)) {
      return res.send(publicLayout({ title: 'Request error', body: `<div class="panel"><p>Missing required info. <a href="/book">Start over</a>.</p></div>` }));
    }
    const phoneNorm = normalizePhone(phone);
    const emailVal = isValidEmail(email) ? email : null;
    const { notesWithDiscovery } = discoveryFromBody(req.body);
    const combinedNotes = [`[${type}]`, notesWithDiscovery].filter(Boolean).join(' ').trim();

    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
    if (!customer) {
      customer = db.createCustomer({ name, phone: phoneNorm, email: emailVal, notes: combinedNotes });
    }

    // Idempotency guard: same reasoning as the appointment booking route -
    // a resubmit within the last 5 minutes with identical notes is treated
    // as a duplicate, not a second request.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let lead = db
      .listLeads()
      .find((l) => l.customer_id === customer.id && l.source === type && l.notes === combinedNotes && l.created_at >= fiveMinAgo);
    if (!lead) {
      lead = db.createLead({ customer_id: customer.id, stage: 'Contacted', source: type, notes: combinedNotes });
      try {
        await automations.onLeadCreated(lead, customer);
      } catch (e) {
        console.error('onLeadCreated failed', e);
      }
    }

    const body = `
      <div class="public-hero">
        <h1>Got it!</h1>
        <p class="subtitle">${escapeHtml(type)}</p>
      </div>
      <div class="panel">
        <p>${type === 'Callback by Owner' ? "Andrew will call you back directly." : "We'll send details to your email."} We received: ${escapeHtml(notesWithDiscovery || '(no additional notes)')}</p>
      </div>
    `;
    res.send(publicLayout({ title: 'Request received', body }));
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
