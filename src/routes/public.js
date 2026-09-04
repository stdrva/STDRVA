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

// ---------- Service area zones ----------
// Address is a single free-text field (no separate city/zip columns), so
// every zone below is matched two ways against whatever the customer typed:
// an exact 5-digit ZIP found in the text, or a known town name as a
// substring (case-insensitive). ZIP/town lists sourced from zip-codes.com
// county/city lookup pages, checked Aug 2026 - not guaranteed complete or
// permanently accurate; add more as real bookings turn up a gap.
//
// Zone 1 - WEDNESDAY_ZONE: Caroline County / Spotsylvania County side of
// Richmond. Andrew only runs that route on Wednesdays.
// Fredericksburg (independent city, not technically inside Spotsylvania
// County) is included here too since it's the same direction/route - an
// interpretation of "that side of Richmond," not a county-line fact.
const WEDNESDAY_WEEKDAY = 3; // 0=Sun..6=Sat
const WEDNESDAY_ZIPS = [
  // Caroline County, VA
  '22546', '22580', '22427', '22428', '22514', '22535', '22538', '22446', '22552', '22501',
  // Spotsylvania County, VA (+ Fredericksburg zips, see note above)
  '22407', '22408', '22551', '22553', '22534', '22565', '22401', '22402', '22403', '22404', '22405', '22412',
];
const WEDNESDAY_TOWNS = [
  // Caroline County, VA
  'ruther glen', 'woodford', 'bowling green', 'milford', 'port royal', 'rappahannock academy', 'corbin', 'sparta', 'ladysmith', 'caroline county',
  // Spotsylvania County, VA + Fredericksburg
  'fredericksburg', 'spotsylvania', 'partlow', 'thornburg',
];

// Zone 2 - CORE_AREA: the normal Richmond metro service area, plus
// Charlottesville/Albemarle by Andrew's explicit request ("maybe an hour
// drive from Richmond, but include Charlottesville"). Bookable any business
// day EXCEPT Wednesday - Andrew's up north on the Wednesday route, so the
// rest of the area skips that day to avoid a same-day conflict.
// Covers: Richmond City, Henrico, Chesterfield, Hanover, Goochland,
// Powhatan, New Kent, Charles City, Albemarle County + Charlottesville,
// Dinwiddie, Prince George, Amelia, Cumberland, King William, King & Queen,
// Louisa, Fluvanna, Nottoway, Colonial Heights, Petersburg, Hopewell.
const CORE_AREA_DAYS = BUSINESS_DAYS.filter((d) => d !== WEDNESDAY_WEEKDAY);
const CORE_AREA_ZIPS = [
  // Richmond City (incl. PO Box / unique zips shared with Henrico/Chesterfield)
  '23219', '23220', '23221', '23222', '23223', '23224', '23225', '23226', '23227', '23228', '23229',
  '23230', '23231', '23233', '23234', '23235', '23236', '23237', '23238', '23250', '23294', '23298',
  '23218', '23241', '23242', '23255', '23260', '23261', '23284', '23285', '23173', '23249', '23269',
  '23273', '23274', '23276', '23278', '23279', '23282', '23286', '23288', '23289', '23290', '23291',
  '23292', '23293', '23295', '23297', '23232',
  // Henrico County
  '23059', '23060', '23058', '23075', '23150',
  // Chesterfield County
  '23112', '23113', '23114', '23832', '23831', '23838', '23120', '23836',
  // Hanover County
  '23111', '23116', '23005', '23192', '23015', '23146', '23069', '23047', '23162',
  // Goochland County
  '23103', '23063', '23102', '23153', '23065', '23160', '23039', '23129', '23014', '23067',
  // Powhatan County
  '23139',
  // New Kent County
  '23141', '23140', '23124', '23089', '23011',
  // Charles City County
  '23030', '23147',
  // Albemarle County + Charlottesville
  '22901', '22902', '22903', '22904', '22905', '22906', '22907', '22908', '22909', '22910', '22911',
  '22932', '24590', '22936', '22947', '22959', '22937', '22940', '22943', '22946', '22931', '22924', '22945', '22987',
  // Louisa County
  '23093', '23024', '23117', '23170',
  // Prince George County
  '23875', '23801', '23842',
  // Dinwiddie County
  '23885', '23841', '23872', '23833', '23840', '23830', '23850', '23894', '23822',
  // Amelia County
  '23002', '23083', '23105',
  // Cumberland County
  '23040', '23027',
  // Fluvanna County
  '22963', '22974', '23084', '23038', '23022', '23055',
  // King William County
  '23009', '23181', '23086', '23106',
  // King and Queen County
  '23148', '23156', '23110', '23177', '23091', '23023', '23126', '23085', '23161', '23108',
  // Nottoway County
  '23824', '23930', '23922', '23955',
  // Colonial Heights (independent city)
  '23834',
  // Petersburg (independent city)
  '23803', '23805', '23804', '23806',
  // Hopewell (independent city)
  '23860',
];
const CORE_AREA_TOWNS = [
  'richmond', 'henrico', 'glen allen', 'sandston',
  'midlothian', 'chester', 'chesterfield', 'moseley',
  'mechanicsville', 'ashland', 'montpelier', 'beaverdam', 'rockville', 'hanover', 'doswell', 'studley',
  'manakin sabot', 'goochland', 'maidens', 'sandy hook', 'gum spring', 'crozier', 'oilville', 'beaumont', 'hadensville',
  'powhatan',
  'quinton', 'providence forge', 'new kent', 'lanexa', 'barhamsville',
  'charles city', 'ruthville',
  'charlottesville', 'albemarle', 'crozet', 'scottsville', 'earlysville', 'keswick', 'north garden',
  'esmont', 'free union', 'greenwood', 'keene', 'covesville', 'batesville', 'ivy', 'white hall',
  'louisa', 'bumpass', 'mineral', 'trevilians',
  'prince george', 'fort lee', 'fort gregg-adams', 'disputanta',
  'dinwiddie', 'sutherland', 'mckenney', 'mc kenney', 'church road', 'dewitt', 'wilsons', 'ammon',
  'amelia court house', 'jetersville', 'mannboro',
  'cumberland', 'cartersville',
  'fluvanna', 'palmyra', 'kents store', 'bremo bluff', 'fork union',
  'king william', 'aylett', 'west point va', 'manquin',
  'king and queen', 'saint stephens church', 'shacklefords', 'mattaponi', 'walkerton', 'little plymouth', 'bruington', 'stevensville', 'mascot',
  'nottoway', 'blackstone', 'crewe', 'burkeville',
  'colonial heights',
  'petersburg',
  'hopewell',
];

function zoneForAddress(address) {
  if (!address) return null;
  const text = String(address).toLowerCase();
  const zipsInText = text.match(/\b\d{5}\b/g) || [];
  const hasZip = (list) => zipsInText.some((z) => list.includes(z));
  const hasTown = (list) => list.some((t) => text.includes(t));
  if (hasZip(WEDNESDAY_ZIPS) || hasTown(WEDNESDAY_TOWNS)) return 'wednesday';
  if (hasZip(CORE_AREA_ZIPS) || hasTown(CORE_AREA_TOWNS)) return 'core';
  return 'out-of-area';
}

function allowedDaysForAddress(address) {
  const zone = zoneForAddress(address);
  if (zone === 'wednesday') return [WEDNESDAY_WEEKDAY];
  if (zone === 'core') return CORE_AREA_DAYS;
  return [];
}

function upcomingBusinessDays(allowedDays) {
  const allowed = allowedDays && allowedDays.length ? allowedDays : BUSINESS_DAYS;
  const days = [];
  const now = new Date();
  const weekCounts = new Map();
  for (let i = BOOKING_MIN_LEAD_DAYS; days.length < BOOKING_WINDOW_DAYS && i < BOOKING_MIN_LEAD_DAYS + 90; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!allowed.includes(d.getDay())) continue;
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
    // Name/phone/address are collected here, BEFORE any day or time is
    // offered - Andrew needs the physical address up front since these are
    // in-home appointments. Threaded through as query params on every link
    // (same stateless pattern as `type`/`date` already used on this page).
    const name = (req.query.name || '').trim();
    const phone = (req.query.phone || '').trim();
    const email = (req.query.email || '').trim();
    const address = (req.query.address || '').trim();
    // All four are required at once (name/phone/email/address) so a lead is
    // never lost for missing contact info - including out-of-area visitors,
    // who get no day picker at all and need to be reachable another way.
    const hasContact = Boolean(name && phone && address && isValidEmail(email));
    const zone = hasContact ? zoneForAddress(address) : null; // 'wednesday' | 'core' | 'out-of-area' | null
    // "Book anyway" lets an out-of-area visitor push through to a real time
    // slot instead of just leaving contact info - they still get flagged to
    // Andrew (see POST /book), just via a real appointment instead of a lead.
    const forced = req.query.force === '1';
    const outOfAreaBlocked = zone === 'out-of-area' && !forced;
    const days = isRequestType || !hasContact || outOfAreaBlocked ? [] : upcomingBusinessDays(forced && zone === 'out-of-area' ? BUSINESS_DAYS : allowedDaysForAddress(address));
    const duration = durationForType(type);
    const contactQS =
      `&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}` +
      `&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}${forced ? '&force=1' : ''}`;

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
        return `<a class="btn ${key === dateSel ? '' : 'secondary'} small" href="/book?type=${encodeURIComponent(type)}&date=${key}${contactQS}" style="margin:0 6px 6px 0">${label}</a>`;
      })
      .join('');

    let slotsHtml = '';
    if (dateSel && hasContact) {
      const slots = slotsForDate(dateSel, duration);
      slotsHtml = slots.length
        ? `<div class="slot-grid">${slots
            .map((s) => {
              const hhmm = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
              const label = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
              return `<a class="slot-btn" href="/book/confirm?type=${encodeURIComponent(type)}&date=${dateSel}&time=${hhmm}${contactQS}">${label}</a>`;
            })
            .join('')}</div>`
        : `<p class="subtitle">No open times that day - try another date.</p>`;
    }

    const contactPanel = `
      <div class="panel">
        <h3 style="margin-top:0">2. Your info</h3>
        <form method="GET" action="/book">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <label>Name *</label><input type="text" name="name" value="${escapeHtml(name)}" required>
          <label>Phone *</label><input type="tel" name="phone" value="${escapeHtml(phone)}" required placeholder="(804) 555-0100">
          <label>Email *</label><input type="email" name="email" value="${escapeHtml(email)}" required>
          <label>Home address *</label><input type="text" name="address" value="${escapeHtml(address)}" required placeholder="Street, city, state, zip - we're coming to your home">
          <div style="margin-top:14px"><button class="btn" type="submit">${hasContact ? 'Update info' : 'Continue'}</button></div>
        </form>
      </div>`;

    const outOfAreaPanel = `
      <div class="panel">
        <h3 style="margin-top:0">3. Your area</h3>
        <p>That address is outside our normal service area. You can have Andrew reach out to see if a visit can be arranged, or book a time anyway and he'll be notified it's outside the usual area.</p>
        <form method="POST" action="/book/out-of-area" onsubmit="if(this.dataset.sent)return false;this.dataset.sent='1';" style="margin-bottom:10px">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <input type="hidden" name="name" value="${escapeHtml(name)}">
          <input type="hidden" name="phone" value="${escapeHtml(phone)}">
          <input type="hidden" name="email" value="${escapeHtml(email)}">
          <input type="hidden" name="address" value="${escapeHtml(address)}">
          <button class="btn" type="submit">Have Andrew reach out to me</button>
        </form>
        <a class="btn secondary" href="/book?type=${encodeURIComponent(type)}${contactQS}&force=1">Book anyway</a>
      </div>`;

    const outOfAreaBanner = `
      <div class="panel" style="border-left:3px solid #b54f1e">
        <p style="margin:0">This address may be outside the normal service area &mdash; booking anyway. Andrew will be notified. This may also be a glitch, book anyway works.</p>
      </div>`;

    const showScheduler = hasContact && !outOfAreaBlocked;

    const body = `
      <div class="public-hero">
        <h1>Let's Get Started</h1>
        <div class="rule"></div>
        <p class="subtitle">Pick a service, tell us where you are, then choose a day and time. No account needed.</p>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">1. What do you need?</h3>
        ${typeOptions}
      </div>
      ${contactPanel}
      ${hasContact && outOfAreaBlocked ? outOfAreaPanel : ''}
      ${hasContact && forced && zone === 'out-of-area' ? outOfAreaBanner : ''}
      ${showScheduler ? `<div class="panel"><h3 style="margin-top:0">3. Choose a day</h3>${dayButtons}</div>` : ''}
      ${showScheduler && dateSel ? `<div class="panel"><h3 style="margin-top:0">4. Choose a time</h3>${slotsHtml}</div>` : ''}
    `;
    res.send(publicLayout({ title: 'Book an appointment', body }));
  });

  router.get('/book/confirm', (req, res) => {
    const { type, date, time } = req.query;
    const name = (req.query.name || '').trim();
    const phone = (req.query.phone || '').trim();
    const email = (req.query.email || '').trim();
    const address = (req.query.address || '').trim();
    const forced = req.query.force === '1';
    // Full contact info is required before a time is ever offered on /book,
    // but guard here too in case someone lands on this URL directly without
    // it - including a stale out-of-area address, unless they came through
    // the "book anyway" flow (force=1).
    const zone = zoneForAddress(address);
    if (!type || !date || !time || !name || !phone || !email || !address || (zone === 'out-of-area' && !forced)) {
      return res.redirect('/book');
    }
    const when = new Date(`${date}T${time}:00`);
    const backQS =
      `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}` +
      `&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}${forced ? '&force=1' : ''}`;
    const body = `
      <div class="public-hero">
        <h1>Confirm your appointment</h1>
        <p class="subtitle">${escapeHtml(type)} &middot; ${when.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
      </div>
      ${zone === 'out-of-area' ? `<div class="panel" style="border-left:3px solid #b54f1e"><p style="margin:0">This address is outside the normal service area &mdash; Andrew will be notified this was booked anyway.</p></div>` : ''}
      <div class="panel">
        <form method="POST" action="/book" onsubmit="if(this.dataset.sent)return false;this.dataset.sent='1';">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <input type="hidden" name="date" value="${escapeHtml(date)}">
          <input type="hidden" name="time" value="${escapeHtml(time)}">
          <input type="hidden" name="force" value="${forced ? '1' : '0'}">
          <label>Name *</label><input type="text" name="name" value="${escapeHtml(name)}" required>
          <label>Phone *</label><input type="tel" name="phone" value="${escapeHtml(phone)}" required placeholder="(804) 555-0100">
          <label>Email *</label><input type="email" name="email" value="${escapeHtml(email)}" required>
          <label>Home address *</label><input type="text" name="address" value="${escapeHtml(address)}" required>
          ${discoveryWizard(
            `${escapeHtml(type)} with <strong>Andrew</strong><br>${when.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
            'Skip all of this and confirm appointment',
            'Confirm booking'
          )}
        </form>
        <p class="subtitle" style="margin-top:10px"><a href="/book?${backQS}">&larr; pick a different time</a></p>
      </div>
    `;
    res.send(publicLayout({ title: 'Confirm appointment', body }));
  });

  router.post('/book', async (req, res) => {
    const { type, date, time, name, phone, email, address, force } = req.body;
    if (!name || !phone || !email || !address || !date || !time) {
      return res.send(publicLayout({ title: 'Booking error', body: `<div class="panel"><p>Missing required info (we need a name, phone, email, and home address to schedule an in-home visit). <a href="/book">Start over</a>.</p></div>` }));
    }
    const outOfArea = zoneForAddress(address) === 'out-of-area';
    if (outOfArea && force !== '1') {
      // Belt-and-suspenders: the day/time picker never offers slots for an
      // out-of-area address unless "book anyway" was used (force=1), so
      // reaching here without it means a crafted URL. Bounce to the normal
      // out-of-area flow instead of booking a real slot.
      return res.redirect(`/book?type=${encodeURIComponent(type || '')}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}`);
    }
    const phoneNorm = normalizePhone(phone);
    const emailVal = isValidEmail(email) ? email : null;
    const { notesWithDiscovery: discoveryNotes } = discoveryFromBody(req.body);
    const notesWithDiscovery = outOfArea ? ['[OUT OF AREA - booked anyway]', discoveryNotes].filter(Boolean).join(' | ') : discoveryNotes;

    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
    if (!customer) {
      customer = db.createCustomer({ name, phone: phoneNorm, email: emailVal, address, notes: notesWithDiscovery });
    } else if (!customer.address && address) {
      // Existing record with no address on file yet - fill it in from this
      // booking rather than leaving it blank. Never overwrites an address
      // that's already there.
      db.updateCustomer(customer.id, {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address,
        notes: customer.notes,
      });
      customer = db.getCustomer(customer.id);
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
        if (outOfArea) await automations.onOutOfAreaContact('booked', customer, { type });
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

  // A visitor whose address fell outside the service area (see zoneForAddress
  // above) never gets a day/time picker - this saves their full contact info
  // as a lead instead, so it's not just lost when they close the tab. Andrew
  // follows up manually to see if a visit can be arranged.
  router.post('/book/out-of-area', async (req, res) => {
    const { type, name, phone, email, address } = req.body;
    if (!name || !phone || !email || !address) {
      return res.send(publicLayout({ title: 'Request error', body: `<div class="panel"><p>Missing required info. <a href="/book">Start over</a>.</p></div>` }));
    }
    const phoneNorm = normalizePhone(phone);
    const emailVal = isValidEmail(email) ? email : null;
    const notes = `[Out of area request${type ? ' - ' + type : ''}]`;

    let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
    if (!customer) {
      customer = db.createCustomer({ name, phone: phoneNorm, email: emailVal, address, notes });
    } else if (!customer.address && address) {
      db.updateCustomer(customer.id, {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address,
        notes: customer.notes,
      });
      customer = db.getCustomer(customer.id);
    }

    // Idempotency guard, same reasoning as /book/request.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    let lead = db
      .listLeads()
      .find((l) => l.customer_id === customer.id && l.source === 'Out of area' && l.created_at >= fiveMinAgo);
    if (!lead) {
      lead = db.createLead({ customer_id: customer.id, stage: 'Contacted', source: 'Out of area', notes });
      try {
        await automations.onLeadCreated(lead, customer);
        await automations.onOutOfAreaContact('lead', customer, { type });
      } catch (e) {
        console.error('onLeadCreated failed', e);
      }
    }

    const body = `
      <div class="public-hero">
        <h1>Got it!</h1>
        <p class="subtitle">We have your info</p>
      </div>
      <div class="panel">
        <p>Your address is outside our normal service area, but Andrew has your contact info and will reach out directly to see if a visit can be arranged.</p>
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
