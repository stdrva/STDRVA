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

// Which weekdays we'll offer for a given address. This is a ROUTING preference,
// never a rejection - an unknown / out-of-area address still gets every normal
// business day (spec 6: don't auto-reject on service area). Andrew is notified
// separately when an out-of-area address books.
function allowedDaysForAddress(address) {
  const zone = zoneForAddress(address);
  if (zone === 'wednesday') return [WEDNESDAY_WEEKDAY];
  if (zone === 'core') return CORE_AREA_DAYS;
  return BUSINESS_DAYS;
}

// ---------- Address parsing (spec 5) ----------
// The customer types / pastes one free-text address (single DB column). Pull
// out the pieces we need for the review screen and the zone check. Handles a
// one-line "123 Main St, Richmond, VA 23220" and a multi-line block pasted
// from Contacts / Maps / an email.
function parseAddress(raw) {
  const full = String(raw || '').replace(/\s*\n\s*/g, ', ').replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();
  const zipMatch = full.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipMatch ? zipMatch[1] : '';
  const stateMatch = full.match(/\b(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : '';
  const parts = full.split(',').map((p) => p.trim()).filter(Boolean);
  const line1 = parts[0] || '';
  let city = '';
  if (parts.length >= 3) city = parts[1];
  else if (parts.length === 2 && state) {
    // "123 Main St, Richmond VA 23220"
    city = parts[1].replace(new RegExp('\\b' + state + '\\b.*$', 'i'), '').trim();
  }
  return { full, line1, city, state, zip, hasStreetNumber: /\d/.test(line1) };
}

// Enough of an address to safely check the service zone and bring the right
// samples. We need a ZIP, OR a city + state, OR a recognized town name.
function addressLooksComplete(raw) {
  const a = parseAddress(raw);
  if (a.zip) return true;
  if (a.city && a.state) return true;
  const zone = zoneForAddress(raw);
  return zone === 'core' || zone === 'wednesday';
}

// A long, readable slot label: "Tuesday, March 17 at 2:00 PM".
function fmtSlotLong(d) {
  return d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- Pick exactly N appointment options, spread out (spec 3) ----------
// Not the first N chronological openings - spread across different days and a
// mix of morning / afternoon so the customer gets a real choice. `offset`
// drives "Look for more times": it walks further down the same spread ordering
// without restarting anything.
function pickSpreadSlots(allowedDays, duration, { count = 4, offset = 0 } = {}) {
  const days = upcomingBusinessDays(allowedDays);
  const byDay = days
    .map((d) => ({ key: dateKey(d), slots: slotsForDate(dateKey(d), duration) }))
    .filter((x) => x.slots.length);
  if (!byDay.length) return { slots: [], hasMore: false };

  // Order each day's slots as early, late, 2nd-early, 2nd-late, ... then rotate
  // by the day's position so consecutive days lead with different times of day
  // (day 1 -> morning, day 2 -> afternoon, ...). That spreads the four options
  // across both days AND times, not just days.
  byDay.forEach((day, i) => {
    const sorted = day.slots.slice().sort((a, b) => a - b);
    const out = [];
    let lo = 0;
    let hi = sorted.length - 1;
    let takeLow = true;
    while (lo <= hi) {
      out.push(takeLow ? sorted[lo++] : sorted[hi--]);
      takeLow = !takeLow;
    }
    const rot = i % out.length;
    day.ordered = out.slice(rot).concat(out.slice(0, rot));
  });

  // Round-robin across days: one slot from day 1, one from day 2, ... then back.
  const spread = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const day of byDay) {
      if (day.ordered[round]) {
        spread.push(day.ordered[round]);
        added = true;
      }
    }
    round++;
  }

  const window = spread.slice(offset, offset + count);
  return { slots: window, hasMore: spread.length > offset + count };
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
const PUBLIC_TYPE_ORDER = [...db.APPT_TYPES.filter((t) => !db.INTERNAL_APPT_TYPES.includes(t)), ...REQUEST_TYPES];
// A hand-typed ?type=Measure (or Install) must not open a public booking for an internal type.
const publicType = (t) => (db.INTERNAL_APPT_TYPES.includes(t) ? PUBLIC_TYPE_ORDER[0] : t || PUBLIC_TYPE_ORDER[0]);

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
        var formEl = document.querySelector('.wizard-nav') && document.querySelector('.wizard-nav').closest('form');
        function saveProgress() {
          // Save-on-Next (spec C6) - partial answers are expected and fine.
          // The server overwrites its own previous save rather than appending.
          if (!formEl) return;
          var fd = new FormData(formEl);
          fetch(formEl.action, { method: 'POST', headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' }, body: fd }).catch(function(){});
        }
        window.wqNav = function(delta) {
          step = Math.min(total, Math.max(1, step + delta));
          show();
          if (delta > 0) saveProgress();
        };
        window.wqToggle = function(id, on) {
          var el = document.getElementById(id);
          if (el) el.hidden = !on;
        };
        show();
      })();
    </script>`;
}

// Repeated saves (one per wizard step, spec C6) must overwrite the previous
// discovery text, never append another copy of it - keeps the delimited
// block after this marker in sync, leaving any note written before it alone.
const DISCOVERY_MARKER = '[Discovery]\n';
function upsertDiscoverySection(existingNotes, notesWithDiscovery) {
  const base = (existingNotes || '').split(DISCOVERY_MARKER)[0].replace(/\n+$/, '');
  if (!notesWithDiscovery) return base;
  return (base ? base + '\n' : '') + DISCOVERY_MARKER + notesWithDiscovery;
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

// Everything the booking flow threads from step to step, as query params.
function contactQS(q) {
  const p = new URLSearchParams();
  for (const k of ['type', 'name', 'phone', 'email', 'address', 'consultant', 'lead_source', 'src', 'campaign']) {
    if (q[k]) p.set(k, q[k]);
  }
  return p.toString();
}

function bookingContact(q) {
  const name = (q.name || '').trim();
  const phone = (q.phone || '').trim();
  const email = (q.email || '').trim();
  let address = (q.address || '').trim();
  // Split address fields (spec C3) recombine into the same single `address`
  // string every downstream piece (parseAddress, zone check, createBooking,
  // storage) already expects - nothing else needed to change. Mutating q
  // (== req.query for every caller) means contactQS() and every link built
  // from {...req.query} pick the combined value straight up.
  if (!address && (q.address_line1 || q.address_city || q.address_state || q.address_zip)) {
    const line1 = (q.address_line1 || '').trim();
    const city = (q.address_city || '').trim();
    const state = (q.address_state || '').trim();
    const zip = (q.address_zip || '').trim();
    address = [line1, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (address) q.address = address;
  }
  return {
    name,
    phone,
    email,
    address,
    hasContact: Boolean(name && phone && isValidEmail(email) && address),
  };
}

// The one place a design appointment is actually created from a self-serve /
// voice booking. No HTTP here - both POST /book/confirm and the assistant's
// book_design_appointment tool call this so the two paths can never drift
// (customer upsert with latest values (spec 7), Home Show consultant credit
// (spec 9), lead, appointment, notify automations, idempotency + slot re-check).
async function createBooking({ name, phone, email, address, slotIso, type, consultantName, leadSource, actor }) {
  type = type || PUBLIC_TYPE_ORDER[0];
  name = (name || '').trim();
  phone = (phone || '').trim();
  email = (email || '').trim();
  address = (address || '').trim();
  const when = slotIso ? new Date(slotIso) : null;
  if (!name || !phone || !isValidEmail(email) || !address || !when || isNaN(when.getTime())) {
    return { ok: false, error: 'Need a name, phone, valid email, full address and a valid time slot.' };
  }

  const phoneNorm = normalizePhone(phone);
  const emailVal = email;
  const outOfArea = zoneForAddress(address) === 'out-of-area';
  const duration = durationForType(type);
  const scheduledAt = when.toISOString();

  let ls = (leadSource || '').trim();
  const consultant = (consultantName || '').trim() ? db.upsertConsultantByName(consultantName) : null;
  if (consultant && !ls) ls = 'Home Show';

  const flags = [];
  if (outOfArea) flags.push('[Outside normal service area — booked anyway]');
  if (consultant) flags.push(`[Sales consultant: ${consultant.name}]`);
  if (ls) flags.push(`[Lead source: ${ls}]`);
  const bookingNote = flags.join(' ');
  const who = actor || 'public';

  let customer = db.findCustomerByPhoneOrEmail(phoneNorm, emailVal);
  if (!customer) {
    customer = db.createCustomer({
      name,
      phone: phoneNorm,
      email: emailVal,
      address,
      notes: bookingNote || null,
      source_id: consultant ? db.homeShowSourceId() : null,
    });
  } else {
    const merged = {
      name: name || customer.name,
      phone: phoneNorm || customer.phone,
      email: emailVal || customer.email,
      address: address || customer.address,
      notes: customer.notes,
    };
    if (
      merged.name !== customer.name ||
      merged.phone !== customer.phone ||
      merged.email !== customer.email ||
      merged.address !== customer.address
    ) {
      db.updateCustomer(customer.id, merged, { actor: who });
      customer = db.getCustomer(customer.id);
    }
  }

  if (consultant && !customer.consultant_id) {
    db.setCustomerConsultant(customer.id, consultant.id, { actor: who });
    try {
      db.setCustomerAttribution({
        customer_id: customer.id,
        source_id: db.homeShowSourceId(),
        note: `Home Show — consultant ${consultant.name}`,
        actor: who,
      });
    } catch (e) {
      console.error('home show attribution failed', e);
    }
    customer = db.getCustomer(customer.id);
  }

  const existingLeads = db.listLeads().filter((l) => l.customer_id === customer.id);
  let lead = existingLeads.find((l) => db.OPEN_LEAD_STAGES.includes(l.stage));
  if (!lead) {
    lead = db.createLead({
      customer_id: customer.id,
      stage: 'Contacted',
      source: ls || 'Self-service booking',
      notes: bookingNote || null,
      consultant_id: consultant ? consultant.id : customer.consultant_id || null,
    });
  }

  let appt = db
    .listAppointments()
    .find((a) => a.customer_id === customer.id && a.scheduled_at === scheduledAt && a.type === type);
  if (!appt) {
    const dayStart = new Date(when.getFullYear(), when.getMonth(), when.getDate(), HOURS_START, 0, 0);
    const dayEnd = new Date(when.getFullYear(), when.getMonth(), when.getDate(), HOURS_END, 0, 0);
    const taken = db.listAppointmentsBetween(dayStart.toISOString(), dayEnd.toISOString()).some((a) => {
      const aStart = new Date(a.scheduled_at);
      const aEnd = new Date(aStart.getTime() + (a.duration_min || 60) * 60000);
      return when < aEnd && new Date(when.getTime() + duration * 60000) > aStart;
    });
    if (taken) return { ok: false, error: 'That time was just taken - pick another.', conflict: true, customer, when };
    appt = db.createAppointment({
      customer_id: customer.id,
      lead_id: lead.id,
      type,
      scheduled_at: scheduledAt,
      duration_min: duration,
      notes: bookingNote || null,
      created_by: consultant ? `consultant:${consultant.name}` : who,
      consultant_id: consultant ? consultant.id : customer.consultant_id || null,
    });
    try {
      await automations.onAppointmentBooked(appt, customer);
      if (outOfArea) await automations.onOutOfAreaContact('booked', customer, { type });
    } catch (e) {
      console.error('onAppointmentBooked failed', e);
    }
  }
  return { ok: true, customer, lead, appt, outOfArea, when, duration };
}

// Available appointment slots for the voice/assistant booking path (spec 14).
// Returns up to `count` spread options as ISO strings, each annotated with
// whether Andrew already has an appointment that day near `near` (same ZIP-3 /
// town / zone) so the assistant can prefer those when a consultant asks for a
// day he's "already in that area". Falls back to normal spread when there is
// no usable geography.
function voiceBookingSlots({ address, near, type, count = 4, fromDate, toDate } = {}) {
  const duration = durationForType(type || PUBLIC_TYPE_ORDER[0]);
  const allowed = address ? allowedDaysForAddress(address) : BUSINESS_DAYS;
  let days;
  if (fromDate || toDate) {
    // An explicit window ("sometime in March") - walk that range directly so we
    // aren't capped by the normal ~2-week booking horizon.
    const now = new Date();
    const minDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + BOOKING_MIN_LEAD_DAYS);
    const start = fromDate && fromDate > dateKey(minDay) ? new Date(fromDate + 'T00:00:00') : minDay;
    const end = toDate ? new Date(toDate + 'T00:00:00') : new Date(start.getTime() + 45 * 86400000);
    days = [];
    for (let d = new Date(start); d <= end && days.length < 60; d.setDate(d.getDate() + 1)) {
      if (allowed.includes(d.getDay())) days.push(new Date(d));
    }
  } else {
    days = upcomingBusinessDays(allowed);
  }

  const nearZone = near ? zoneForAddress(near) : null;
  const nearZip3 = near ? (parseAddress(near).zip || '').slice(0, 3) : '';

  const dayInfo = days
    .map((d) => {
      const key = dateKey(d);
      const slots = slotsForDate(key, duration);
      if (!slots.length) return null;
      let nearby = false;
      if (near) {
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
        const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
        const appts = db.listAppointmentsBetween(dayStart.toISOString(), dayEnd.toISOString());
        nearby = appts.some((a) => {
          const cust = db.getCustomer(a.customer_id);
          if (!cust || !cust.address) return false;
          const z = zoneForAddress(cust.address);
          const zip3 = (parseAddress(cust.address).zip || '').slice(0, 3);
          return (nearZip3 && zip3 && zip3 === nearZip3) || (nearZone && z && z === nearZone && z !== 'out-of-area');
        });
      }
      return { key, date: d, slots, nearby };
    })
    .filter(Boolean);

  // Prefer days with a nearby appointment (spec 14), else keep natural order.
  const ordered = near ? dayInfo.slice().sort((a, b) => (b.nearby ? 1 : 0) - (a.nearby ? 1 : 0)) : dayInfo;
  const out = [];
  let round = 0;
  while (out.length < count && round < 12) {
    for (const di of ordered) {
      const sorted = di.slots.slice().sort((a, b) => a - b);
      const s = sorted[round];
      if (s && out.length < count) out.push({ iso: s.toISOString(), label: fmtSlotLong(s), nearby: di.nearby });
    }
    round++;
  }
  return {
    slots: out,
    used_geography: !!near && dayInfo.some((d) => d.nearby),
    note: near
      ? dayInfo.some((d) => d.nearby)
        ? 'Some options are on days Andrew already has an appointment in that area - those are listed first.'
        : 'No existing appointments near that address were found, so these are just the normal openings.'
      : undefined,
  };
}

function register(router) {
  // ---------- Step 1-2: service + contact/address, then the 4 time options ----------
  router.get('/book', (req, res) => {
    const type = publicType(req.query.type);
    const isRequestType = REQUEST_TYPES.includes(type);
    const { name, phone, email, address, hasContact } = bookingContact(req.query);
    const duration = durationForType(type);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const qs = contactQS({ ...req.query, type });

    const typeOptions = PUBLIC_TYPE_ORDER.map((t) => {
      const selected = t === type;
      const prominent = t === 'Short Design Consultation';
      const cls = ['type-card', prominent ? 'featured' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
      const keep = contactQS({ ...req.query, type: t });
      return `
        <a class="${cls}" href="/book?${keep}#step-contact">
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
            <label>Name *</label><input type="text" name="name" autocomplete="name" required>
            <label>Phone *</label><input type="tel" name="phone" autocomplete="tel" inputmode="tel" required placeholder="(804) 555-0100">
            <label>Email</label><input type="email" name="email" autocomplete="email" inputmode="email">
            <div style="margin-top:14px"><button class="btn" type="submit">${type === 'Callback by Owner' ? 'Request a callback' : 'Submit request'}</button></div>
          </form>
        </div>
      `;
      return res.send(publicLayout({ title: 'Request info', body }));
    }

    const addr = parseAddress(address);
    // Prefer whatever the split fields carried on this exact request (so a
    // half-typed value isn't clobbered by round-tripping through parseAddress),
    // falling back to the combined address parsed apart for prefill otherwise.
    const addrParts = {
      line1: req.query.address_line1 !== undefined ? req.query.address_line1 : addr.line1,
      city: req.query.address_city !== undefined ? req.query.address_city : addr.city,
      state: req.query.address_state !== undefined ? req.query.address_state : addr.state,
      zip: req.query.address_zip !== undefined ? req.query.address_zip : addr.zip,
    };
    const addrComplete = address && addressLooksComplete(address);
    const zone = addrComplete ? zoneForAddress(address) : null;

    const contactPanel = `
      <div class="panel" id="step-contact">
        <h3 style="margin-top:0">2. Your info &amp; address</h3>
        <form method="GET" action="/book" id="contact-form">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          ${req.query.consultant ? `<input type="hidden" name="consultant" value="${escapeHtml(req.query.consultant)}">` : ''}
          ${req.query.lead_source ? `<input type="hidden" name="lead_source" value="${escapeHtml(req.query.lead_source)}">` : ''}
          ${req.query.src ? `<input type="hidden" name="src" value="${escapeHtml(req.query.src)}">` : ''}
          ${req.query.campaign ? `<input type="hidden" name="campaign" value="${escapeHtml(req.query.campaign)}">` : ''}
          <label>Name *</label>
          <input type="text" name="name" value="${escapeHtml(name)}" autocomplete="name" required>
          <label>Phone *</label>
          <input type="tel" name="phone" value="${escapeHtml(phone)}" autocomplete="tel" inputmode="tel" required placeholder="(804) 555-0100">
          <label>Email *</label>
          <input type="email" name="email" value="${escapeHtml(email)}" autocomplete="email" inputmode="email" required>
          <label>Street address *</label>
          <input type="text" name="address_line1" value="${escapeHtml(addrParts.line1)}" autocomplete="address-line1" required>
          <div class="grid cols-3" style="margin-top:10px">
            <div><label>City</label><input type="text" name="address_city" value="${escapeHtml(addrParts.city)}" autocomplete="address-level2"></div>
            <div><label>State</label><input type="text" name="address_state" value="${escapeHtml(addrParts.state)}" autocomplete="address-level1" maxlength="2" style="text-transform:uppercase" placeholder="VA"></div>
            <div><label>ZIP</label><input type="text" name="address_zip" value="${escapeHtml(addrParts.zip)}" autocomplete="postal-code" inputmode="numeric" placeholder="23220"></div>
          </div>
          ${
            address && !addrComplete
              ? `<p class="subtitle" style="margin:8px 0 0;color:#b54f1e">That address looks incomplete — please add the city, state and ZIP so we can schedule your visit.</p>`
              : ''
          }
          <div style="margin-top:14px"><button class="btn" type="submit">${hasContact && addrComplete ? 'Update info' : 'See available times'}</button></div>
        </form>
      </div>
      <script>
        (function () {
          var f = document.getElementById('contact-form');
          if (!f) return;
          // Native GET-form submission doesn't reliably keep a fragment
          // through to the reloaded page, so build the URL by hand (spec C5)
          // and land smoothly on the times section once it renders.
          f.addEventListener('submit', function (e) {
            e.preventDefault();
            var params = new URLSearchParams(new FormData(f));
            window.location.href = '/book?' + params.toString() + '#step-times';
          });
        })();
      </script>`;

    let timesPanel = '';
    if (hasContact && addrComplete) {
      const { slots, hasMore } = pickSpreadSlots(allowedDaysForAddress(address), duration, { count: 4, offset });
      if (slots.length) {
        const cards = slots
          .map((s) => {
            const iso = s.toISOString();
            const review = `/book/review?${contactQS({ ...req.query, type })}&slot=${encodeURIComponent(iso)}`;
            return `
              <a class="slot-card" href="${escapeHtml(review)}">
                <span class="slot-day">${s.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                <span class="slot-time">${s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              </a>`;
          })
          .join('');
        const moreLink = hasMore
          ? `<a class="btn secondary small" href="/book?${qs}&offset=${offset + 4}" style="margin-top:10px">Look for more times</a>`
          : offset > 0
            ? `<a class="btn secondary small" href="/book?${qs}" style="margin-top:10px">Back to the first times</a>`
            : '';
        timesPanel = `
          <div class="panel" id="step-times">
            <h3 style="margin-top:0">3. Pick a time that works</h3>
            <p class="subtitle" style="margin-top:0">${escapeHtml(type)} · about ${duration >= 120 ? Math.round(duration / 60) + ' hours' : duration + ' minutes'}. Here are four openings${offset ? ' (more options)' : ''} — pick one and you'll confirm the details next.</p>
            <div class="slot-cards">${cards}</div>
            ${moreLink}
            ${zone === 'out-of-area' ? `<p class="subtitle" style="margin-top:10px">This looks like it may be outside our usual area — that's OK, you can still book and Andrew will confirm.</p>` : ''}
          </div>`;
      } else {
        timesPanel = `
          <div class="panel">
            <h3 style="margin-top:0">3. Pick a time</h3>
            <p class="subtitle">We don't have an opening we can show right now. Leave your info above and Andrew will reach out with times, or call ${escapeHtml(process.env.BUSINESS_PHONE || '(804) 839-7984')}.</p>
          </div>`;
      }
    }

    const consultantParam = (req.query.consultant || '').trim();
    const showBanner = consultantParam
      ? `<div class="panel" style="border-left:3px solid var(--gold);background:#fffbf0">
          <p style="margin:0"><strong>${escapeHtml(req.query.lead_source || 'Home Show')}</strong> — booking with <strong>${escapeHtml(consultantParam)}</strong>. Fill this out and pick a time; ${escapeHtml(consultantParam.split(' ')[0])} stays credited on your appointment.</p>
        </div>`
      : '';

    const body = `
      <div class="public-hero">
        <h1>Let's Get Started</h1>
        <div class="rule"></div>
        <p class="subtitle">Pick a service, tell us where you are, then choose from the times we offer. No account needed.</p>
      </div>
      ${showBanner}
      <div class="panel">
        <h3 style="margin-top:0">1. What do you need?</h3>
        ${typeOptions}
      </div>
      ${contactPanel}
      ${timesPanel}
    `;
    return res.send(publicLayout({ title: 'Book an appointment', body }));
  });

  // ---------- Step 4: final confirmation (name, address, date, time) ----------
  router.get('/book/review', (req, res) => {
    const type = publicType(req.query.type);
    const { name, phone, email, address, hasContact } = bookingContact(req.query);
    const slotIso = req.query.slot || '';
    const when = slotIso ? new Date(slotIso) : null;
    if (!hasContact || !when || isNaN(when.getTime())) {
      return res.redirect(`/book?${contactQS({ ...req.query, type })}`);
    }
    const addr = parseAddress(address);
    const backQS = contactQS({ ...req.query, type });
    const body = `
      <div class="public-hero">
        <h1>Confirm your appointment</h1>
        <p class="subtitle">Nothing is booked yet — check the details and confirm.</p>
      </div>
      <div class="panel review-card">
        <div class="review-row"><span>Service</span><strong>${escapeHtml(type)}</strong></div>
        <div class="review-row"><span>When</span><strong>${escapeHtml(fmtSlotLong(when))}</strong></div>
        <div class="review-row"><span>Name</span><strong>${escapeHtml(name)}</strong></div>
        <div class="review-row"><span>Address</span><strong>${escapeHtml(addr.full || address)}</strong></div>
        <div class="review-row"><span>Phone</span><strong>${escapeHtml(phone)}</strong></div>
        <div class="review-row"><span>Email</span><strong>${escapeHtml(email)}</strong></div>
      </div>
      <div class="panel">
        <form method="POST" action="/book/confirm" onsubmit="if(this.dataset.sent)return false;this.dataset.sent='1';var b=this.querySelector('button[type=submit]');if(b){b.disabled=true;b.textContent='Booking…';}">
          <input type="hidden" name="type" value="${escapeHtml(type)}">
          <input type="hidden" name="slot" value="${escapeHtml(slotIso)}">
          ${['consultant', 'lead_source', 'src', 'campaign'].map((k) => (req.query[k] ? `<input type="hidden" name="${k}" value="${escapeHtml(req.query[k])}">` : '')).join('')}
          <details class="review-edit">
            <summary>Something wrong? Edit your details</summary>
            <label>Name *</label><input type="text" name="name" value="${escapeHtml(name)}" autocomplete="name" required>
            <label>Phone *</label><input type="tel" name="phone" value="${escapeHtml(phone)}" autocomplete="tel" inputmode="tel" required>
            <label>Email *</label><input type="email" name="email" value="${escapeHtml(email)}" autocomplete="email" inputmode="email" required>
            <label>Home address *</label><textarea name="address" rows="3" autocomplete="street-address" required>${escapeHtml(address)}</textarea>
          </details>
          <!-- Controls inside a closed <details> still submit, so no hidden
               duplicates are needed - and an edit here always wins (spec 7). -->
          <div style="margin-top:16px"><button class="btn btn-confirm" type="submit">Confirm Appointment</button></div>
          <p class="subtitle" style="margin-top:10px"><a href="/book?${backQS}">&larr; pick a different time</a></p>
        </form>
      </div>
    `;
    return res.send(publicLayout({ title: 'Confirm appointment', body }));
  });

  // Old links keep working.
  router.get('/book/confirm', (req, res) => res.redirect(`/book/review?${new URLSearchParams(req.query).toString()}`));

  // ---------- The ONLY thing that creates the appointment ----------
  async function doConfirm(req, res) {
    const body = req.body || {};
    const type = publicType(body.type);
    // A form with the edit-details <details> open sends the field twice - the
    // last value wins in querystring.parse only when it's an array; take the
    // last non-empty in that case so an edit ("Donna" -> "Donna Test") sticks
    // (spec 7).
    const pick = (v) => (Array.isArray(v) ? v.filter((x) => x && x.trim()).pop() || v[v.length - 1] : v);
    const name = (pick(body.name) || '').trim();
    const phone = (pick(body.phone) || '').trim();
    const email = (pick(body.email) || '').trim();
    const address = (pick(body.address) || '').trim();
    const slotIso = body.slot || (body.date && body.time ? new Date(`${body.date}T${body.time}:00`).toISOString() : '');
    const when = slotIso ? new Date(slotIso) : null;

    if (!name || !phone || !isValidEmail(email) || !address || !when || isNaN(when.getTime())) {
      return res.send(
        publicLayout({
          title: 'Booking error',
          body: `<div class="panel"><p>We're missing something needed to book an in-home visit (name, phone, a valid email, full address, and a time). <a href="/book?${contactQS({ type, name, phone, email, address })}">Go back</a>.</p></div>`,
        })
      );
    }

    const result = await createBooking({
      name,
      phone,
      email,
      address,
      slotIso: slotIso,
      type,
      consultantName: (body.consultant || req.query.consultant || '').trim(),
      leadSource: (body.lead_source || req.query.lead_source || '').trim(),
      actor: 'public',
    });

    if (!result.ok) {
      if (result.conflict) {
        return res.send(
          publicLayout({
            title: 'That time was just taken',
            body: `<div class="panel"><p>Sorry — someone grabbed <strong>${escapeHtml(fmtSlotLong(when))}</strong> a moment ago. <a href="/book?${contactQS({ type, name, phone, email, address })}">Pick another time</a>.</p></div>`,
          })
        );
      }
      return res.send(
        publicLayout({
          title: 'Booking error',
          body: `<div class="panel"><p>${escapeHtml(result.error)} <a href="/book?${contactQS({ type, name, phone, email, address })}">Go back</a>.</p></div>`,
        })
      );
    }

    // Post-Redirect-Get so a refresh on the success page doesn't resubmit.
    return res.redirect(`/book/booked?appt=${encodeURIComponent(result.appt.id)}`);
  }

  router.post('/book/confirm', doConfirm);
  router.post('/book', doConfirm); // back-compat with the old confirm form
  router.post('/book/out-of-area', doConfirm); // spec 6: book them, don't shunt to a "leave your info" dead end

  // ---------- Step 5: booked + post-booking discovery (spec 8) ----------
  router.get('/book/booked', (req, res) => {
    const appt = req.query.appt ? db.getAppointment(req.query.appt) : null;
    if (!appt) {
      return res.send(publicLayout({ title: 'Booked', body: `<div class="panel"><p>Your appointment is booked. We'll be in touch with a reminder. <a href="/book">Back to booking</a>.</p></div>` }));
    }
    const customer = db.getCustomer(appt.customer_id);
    const when = new Date(appt.scheduled_at);
    const addr = parseAddress(customer && customer.address);
    const discoveryDone = /Rooms:|Interested in:|Pets:/.test((appt.notes || '') + (customer && customer.notes ? customer.notes : ''));

    const body = `
      <div class="public-hero">
        <h1>You're booked!</h1>
        <p class="subtitle">${escapeHtml(appt.type)}</p>
      </div>
      <div class="panel review-card">
        <div class="review-row"><span>When</span><strong>${escapeHtml(fmtSlotLong(when))}</strong></div>
        <div class="review-row"><span>Where</span><strong>${escapeHtml(addr.full || (customer && customer.address) || '')}</strong></div>
      </div>
      <div class="panel">
        <p>We've sent a confirmation${customer && customer.phone ? ' text' : ''}${customer && customer.phone && customer.email ? ' and' : ''}${customer && customer.email ? ' email' : ''}, and we'll remind you before your appointment.</p>
      </div>
      ${
        discoveryDone
          ? ''
          : `<div class="panel">
        <h3 style="margin-top:0">A few quick details (optional)</h3>
        <p class="subtitle" style="margin-top:0">This helps Andrew bring the right samples. You can skip it — your appointment is already set.</p>
        <form method="POST" action="/book/discovery">
          <input type="hidden" name="appt" value="${escapeHtml(appt.id)}">
          ${discoveryWizard('', "Skip — I'm all set", 'Finished')}
        </form>
      </div>`
      }
    `;
    return res.send(publicLayout({ title: 'Booked', body }));
  });

  router.post('/book/discovery', (req, res) => {
    const isFetch = req.headers['x-requested-with'] === 'fetch';
    const appt = req.body.appt ? db.getAppointment(req.body.appt) : null;
    if (!appt) return isFetch ? res.status(400).json({ error: 'Appointment not found' }) : res.redirect('/book');
    const { notesWithDiscovery } = discoveryFromBody(req.body);
    if (notesWithDiscovery) {
      const apptNotes = upsertDiscoverySection(appt.notes, notesWithDiscovery);
      try {
        db.updateAppointment(appt.id, { notes: apptNotes }, { actor: 'public' });
      } catch (e) {
        console.error('discovery updateAppointment failed', e);
      }
      const customer = db.getCustomer(appt.customer_id);
      if (customer) {
        const custNotes = upsertDiscoverySection(customer.notes, notesWithDiscovery);
        db.updateCustomer(
          customer.id,
          { name: customer.name, phone: customer.phone, email: customer.email, address: customer.address, notes: custNotes },
          { actor: 'public' }
        );
      }
    }
    // A background save-on-Next (spec C6) just needs an ack - it must not
    // navigate the customer away from the wizard they're still filling out.
    if (isFetch) return res.json({ ok: true });
    const body = `
      <div class="public-hero">
        <h1>Thanks!</h1>
        <p class="subtitle">You're all set.</p>
      </div>
      <div class="panel"><p>We've got your details. See you at your appointment — we'll send a reminder beforehand.</p></div>
    `;
    return res.send(publicLayout({ title: 'All set', body }));
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

  // ---------- Appointment self-service: Confirm / Change / Cancel (spec G2.4) ----------
  // Each appointment has its own private token (separate from the job token).
  // Confirm only sets a `confirmed` flag - never the status field, since most
  // of the app filters on status = 'scheduled'. Cancel requires an explicit
  // POST (never fires from a bare GET, which an email client's own link
  // scanner could otherwise trigger) and frees the slot via the existing
  // 'canceled' status - no new status value.
  function notFoundAppointment(res) {
    return res.status(404).send(publicLayout({ title: 'Not found', body: `<div class="panel"><p>We couldn't find that appointment. Double check the link, or contact us.</p></div>` }));
  }

  router.get('/appointment/:token', (req, res) => {
    const appt = db.getAppointmentByToken(req.params.token);
    if (!appt) return notFoundAppointment(res);
    const customer = db.getCustomer(appt.customer_id);
    const when = fmtSlotLong(new Date(appt.scheduled_at));
    const canAct = appt.status === 'scheduled';
    const body = `
      <div class="public-hero">
        <h1>Your appointment</h1>
      </div>
      <div class="panel review-card">
        <div class="review-row"><span>Service</span><strong>${escapeHtml(appt.type)}</strong></div>
        <div class="review-row"><span>When</span><strong>${escapeHtml(when)}</strong></div>
        <div class="review-row"><span>Status</span><strong>${escapeHtml(appt.status)}${appt.confirmed ? ' · confirmed' : ''}</strong></div>
      </div>
      ${
        canAct
          ? `<div class="panel" style="display:flex;gap:10px;flex-wrap:wrap">
              <form method="POST" action="/appointment/${appt.public_token}/confirm"><button class="btn" type="submit">${appt.confirmed ? 'Confirmed ✓' : 'Confirm'}</button></form>
              <a class="btn secondary" href="/appointment/${appt.public_token}/change">Change</a>
              <a class="btn secondary" href="/appointment/${appt.public_token}/cancel">Cancel</a>
            </div>`
          : `<div class="panel"><p class="subtitle" style="margin:0">This appointment is ${escapeHtml(appt.status)} - contact us if that's not right.</p></div>`
      }
    `;
    res.send(publicLayout({ title: 'Your appointment', body }));
  });

  router.post('/appointment/:token/confirm', (req, res) => {
    const appt = db.getAppointmentByToken(req.params.token);
    if (!appt) return notFoundAppointment(res);
    if (appt.status === 'scheduled') db.confirmAppointment(appt.id);
    res.redirect(`/appointment/${appt.public_token}`);
  });

  router.get('/appointment/:token/change', (req, res) => {
    const appt = db.getAppointmentByToken(req.params.token);
    if (!appt) return notFoundAppointment(res);
    const customer = db.getCustomer(appt.customer_id);
    const qs = contactQS({ type: appt.type, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address });
    res.redirect(`/book?${qs}`);
  });

  router.get('/appointment/:token/cancel', (req, res) => {
    const appt = db.getAppointmentByToken(req.params.token);
    if (!appt) return notFoundAppointment(res);
    if (appt.status !== 'scheduled') return res.redirect(`/appointment/${appt.public_token}`);
    const when = fmtSlotLong(new Date(appt.scheduled_at));
    const body = `
      <div class="public-hero"><h1>Cancel this appointment?</h1></div>
      <div class="panel review-card">
        <div class="review-row"><span>Service</span><strong>${escapeHtml(appt.type)}</strong></div>
        <div class="review-row"><span>When</span><strong>${escapeHtml(when)}</strong></div>
      </div>
      <div class="panel" style="display:flex;gap:10px">
        <form method="POST" action="/appointment/${appt.public_token}/cancel"><button class="btn danger" type="submit">Yes, cancel it</button></form>
        <a class="btn secondary" href="/appointment/${appt.public_token}">Never mind</a>
      </div>
    `;
    res.send(publicLayout({ title: 'Cancel appointment', body }));
  });

  router.post('/appointment/:token/cancel', async (req, res) => {
    const appt = db.getAppointmentByToken(req.params.token);
    if (!appt) return notFoundAppointment(res);
    if (appt.status === 'scheduled') {
      db.updateAppointmentStatus(appt.id, 'canceled');
      const customer = db.getCustomer(appt.customer_id);
      try {
        await automations.notifyOwner({
          smsBody: `${customer ? customer.name : 'A customer'} canceled their ${appt.type} appointment (was ${fmtSlotLong(new Date(appt.scheduled_at))}).`,
          emailSubject: `Appointment canceled: ${customer ? customer.name : 'customer'}`,
          emailHtml: `<p>${escapeHtml(customer ? customer.name : 'A customer')} canceled their <strong>${escapeHtml(appt.type)}</strong> appointment (was ${escapeHtml(fmtSlotLong(new Date(appt.scheduled_at)))}).</p>`,
        });
      } catch (e) {
        console.error('cancel notifyOwner failed', e);
      }
    }
    res.redirect(`/appointment/${appt.public_token}`);
  });
}

module.exports = {
  register,
  // shared with the assistant / voice booking path + tests
  createBooking,
  voiceBookingSlots,
  parseAddress,
  addressLooksComplete,
  pickSpreadSlots,
  zoneForAddress,
  allowedDaysForAddress,
  durationForType,
  fmtSlotLong,
  bookingContact,
  upsertDiscoverySection,
  discoveryFromBody,
};
