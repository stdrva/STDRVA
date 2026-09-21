const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { newId, newToken, nowIso, dateInputToIso, etDateString, isCalendarDate } = require('./util');

// DB location is overridable via BOS_DB_PATH so the test suite can run against
// a throwaway file instead of the live database. Production/dev leave it unset.
const DB_PATH = process.env.BOS_DB_PATH || path.join(__dirname, '..', 'data', 's2d-crm.sqlite3');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  stage TEXT NOT NULL DEFAULT 'New Lead',
  source TEXT,
  estimate_value REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  lead_id TEXT REFERENCES leads(id),
  type TEXT NOT NULL DEFAULT 'Consultation',
  scheduled_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'scheduled',
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  public_token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Order Confirmed',
  sold_amount REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  direction TEXT NOT NULL DEFAULT 'out',
  channel TEXT NOT NULL DEFAULT 'sms',
  body TEXT,
  status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  customer_id TEXT REFERENCES customers(id),
  category TEXT NOT NULL DEFAULT 'Job Revenue',
  amount REAL NOT NULL,
  method TEXT,
  note TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  amount REAL NOT NULL,
  vendor TEXT,
  method TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  measurements TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  factory TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'Queued for Factory',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_options (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_reps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  rep_id TEXT NOT NULL REFERENCES sales_reps(id),
  session_type TEXT NOT NULL,
  appointment_id TEXT REFERENCES appointments(id),
  summary TEXT,
  techniques_json TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_files (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
`);

// ---- Migration: add structured spec columns to products (safe to run on an
// existing database that already has rows - only adds columns that are
// missing, never touches existing data). ----
(function migrateProductsTable() {
  const existing = new Set(db.prepare(`PRAGMA table_info(products)`).all().map((c) => c.name));
  const newColumns = [
    ['cabinet_type', 'TEXT'],
    ['type_code', 'TEXT'],
    ['mount_style', 'TEXT'],
    ['rail_type', 'TEXT'],
    ['color', 'TEXT'],
    ['divider', 'TEXT'],
    ['opening_width_mm', 'REAL'],
    ['unit_price', 'REAL'],
  ];
  for (const [col, type] of newColumns) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${col} ${type}`);
    }
  }
})();

// ---- Migration: customer_files gains a job link + AI-extraction columns.
// Additive only, same guarded pattern as migrateProductsTable above. A file
// always belongs to a customer; job_id is an optional tag so it also shows up
// on that job's page. The extracted_* columns hold whatever the Office Manager
// Assistant mines out of an uploaded order form / invoice, so it's searchable
// later. ----
(function migrateCustomerFilesTable() {
  const existing = new Set(db.prepare(`PRAGMA table_info(customer_files)`).all().map((c) => c.name));
  const newColumns = [
    ['job_id', 'TEXT'],
    ['extracted_text', 'TEXT'],
    ['extracted_json', 'TEXT'],
    ['extraction_status', 'TEXT'],
    ['extracted_at', 'TEXT'],
  ];
  for (const [col, type] of newColumns) {
    if (!existing.has(col)) db.exec(`ALTER TABLE customer_files ADD COLUMN ${col} ${type}`);
  }
})();

// ---- Full-text search over uploaded files (filename, manual note, and any
// text the Assistant extracted from the file). Standalone FTS5 table kept in
// sync by hand inside the file functions below - the rest of this codebase
// uses no triggers, so neither does this. ----
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS file_search USING fts5(
  file_id UNINDEXED, original_name, note, extracted_text
);`);
(function backfillFileSearch() {
  const indexed = db.prepare(`SELECT COUNT(*) as n FROM file_search`).get().n;
  const files = db.prepare(`SELECT COUNT(*) as n FROM customer_files`).get().n;
  if (indexed > 0 || files === 0) return;
  const rows = db.prepare(`SELECT id, original_name, note, extracted_text FROM customer_files`).all();
  for (const r of rows) {
    db.prepare(`INSERT INTO file_search (file_id, original_name, note, extracted_text) VALUES (?,?,?,?)`).run(
      r.id,
      r.original_name || '',
      r.note || '',
      r.extracted_text || ''
    );
  }
})();

// ---- Seed default product option lists (mount styles, rail types, colors,
// cabinet types) from the real G-O Manufacturing wholesale order form, so
// the dropdowns are useful out of the box. Only seeds if a category is
// completely empty, so it never overwrites anything you've customized. ----
(function seedProductOptions() {
  const defaults = {
    cabinet_type: ['Large Food Pantry', 'Small Pantry', 'Base Cabinet', 'Upper Cabinet', 'Vanity'],
    type_code: ['S1', 'S2', 'S3', 'S4', 'D1', 'D2', 'D3', 'D4', 'T1', 'T2', 'T3', 'T4', 'TB1', 'SM1', 'SM2'],
    mount_style: ['ST EFS', 'ST NHS', 'ST NFS', 'FM EHS', 'FM NHS', 'BM EHS', 'BM NHS', 'SM EHS', 'OTHER'],
    rail_type: ['FE', '0.75', 'Other', 'None'],
    color: ['W', 'B'],
  };
  for (const [category, codes] of Object.entries(defaults)) {
    const count = db.prepare(`SELECT COUNT(*) as n FROM product_options WHERE category = ?`).get(category).n;
    if (count > 0) continue;
    codes.forEach((code, i) => {
      db.prepare(
        `INSERT INTO product_options (id, category, code, label, sort_order, active, created_at) VALUES (?,?,?,?,?,1,?)`
      ).run(newId(), category, code, code, i, nowIso());
    });
  }
})();

// ============================================================================
// Phase 2 (Customer Operations + KPI/marketing/bookkeeping capture) schema.
// All additive. New tables use CREATE TABLE IF NOT EXISTS; new columns on
// existing tables use the same guarded ALTER pattern as migrateProductsTable
// so a populated production database upgrades in place with no data loss.
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,           -- 'customer' | 'appointment' | 'job' | 'followup' | 'expense' | ...
  entity_id TEXT NOT NULL,
  customer_id TEXT,                    -- denormalized so a customer's whole history is one indexed query
  field TEXT,                          -- what changed, e.g. 'sales_stage'
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  actor TEXT NOT NULL DEFAULT 'system', -- 'user:andrew' | 'assistant' | 'system' | 'public'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_customer ON activity_log(customer_id, created_at);

CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL DEFAULT 'next_action',  -- next_action | follow_up | estimate | referrals | reschedule | custom
  title TEXT NOT NULL,
  detail TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',        -- open | done | dismissed
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  completed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_followups_open ON followups(status, due_at);

CREATE TABLE IF NOT EXISTS marketing_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES marketing_sources(id),
  name TEXT NOT NULL,
  tracking_phone TEXT,                 -- dedicated inbound number; stored normalized (+1XXXXXXXXXX)
  start_date TEXT,
  end_date TEXT,
  cost REAL,                           -- total spend for the campaign
  status TEXT NOT NULL DEFAULT 'active', -- active | ended | planned
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_tracking_phone ON marketing_campaigns(tracking_phone);

-- Append-only. The FIRST row for a customer is their original attribution and
-- is never rewritten; later rows record re-attribution with who/when/why.
CREATE TABLE IF NOT EXISTS customer_attribution (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  source_id TEXT REFERENCES marketing_sources(id),
  campaign_id TEXT REFERENCES marketing_campaigns(id),
  tracking_phone TEXT,
  note TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attribution_customer ON customer_attribution(customer_id, created_at);

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'expense', -- expense | income | asset | liability | equity
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Home Show / event salespeople. A consultant "captures" a lead and may "book"
-- a design appointment on the spot; both are credited to them (spec 9). No
-- commission math here - just the attribution and the counts behind it.
CREATE TABLE IF NOT EXISTS sales_consultants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
`);

(function migrateCustomersTable() {
  const existing = new Set(db.prepare(`PRAGMA table_info(customers)`).all().map((c) => c.name));
  const cols = [
    ['sales_stage', 'TEXT'],
    ['stage_substatus', 'TEXT'],
    ['dormant', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'TEXT'],
    ['source_id', 'TEXT'],
    ['campaign_id', 'TEXT'],
    ['first_contact_at', 'TEXT'], // when they became a Bona Fide Lead (KPI denominator anchor)
    ['consultant_id', 'TEXT'], // Home Show / event salesperson who captured them (spec 9)
  ];
  for (const [col, type] of cols) if (!existing.has(col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} ${type}`);
})();

(function migrateAppointmentsTable() {
  const existing = new Set(db.prepare(`PRAGMA table_info(appointments)`).all().map((c) => c.name));
  const cols = [
    ['updated_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['google_event_id', 'TEXT'], // reserved: Google Calendar becomes authoritative later
    ['created_by', 'TEXT'],
    ['consultant_id', 'TEXT'], // consultant who booked this design appointment (spec 9)
  ];
  for (const [col, type] of cols) if (!existing.has(col)) db.exec(`ALTER TABLE appointments ADD COLUMN ${col} ${type}`);
})();

(function migrateLeadsConsultant() {
  const existing = new Set(db.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name));
  if (!existing.has('consultant_id')) db.exec(`ALTER TABLE leads ADD COLUMN consultant_id TEXT`);
})();

(function migrateExpensesTable() {
  const existing = new Set(db.prepare(`PRAGMA table_info(expenses)`).all().map((c) => c.name));
  const cols = [
    ['merchant', 'TEXT'],
    ['memo', 'TEXT'],
    ['coa_account', 'TEXT'],           // Chart of Accounts name; null => needs review
    ['payment_account', 'TEXT'],       // "Business checking", "Amex", etc.
    ['entry_source', 'TEXT'],          // manual | voice | upload | assistant | email | bank_import
    ['reconciliation_status', "TEXT NOT NULL DEFAULT 'unreconciled'"], // unreconciled | matched | reconciled
    ['receipt_file_id', 'TEXT'],       // customer_files.id of an attached receipt
    ['external_ref', 'TEXT'],          // bank/card transaction id, for future match-not-duplicate
    ['expense_at', 'TEXT'],            // full timestamp (expense_date stays for back-compat)
    ['needs_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['created_by', 'TEXT'],
  ];
  for (const [col, type] of cols) if (!existing.has(col)) db.exec(`ALTER TABLE expenses ADD COLUMN ${col} ${type}`);
})();

// ---- Migration: "waiting on someone" state for follow-ups (spec E8) - a
// separate free-text note, not a new status value, since much of the app
// filters on followups.status = 'open'. ----
(function migrateFollowupsWaiting() {
  const existing = new Set(db.prepare(`PRAGMA table_info(followups)`).all().map((c) => c.name));
  if (!existing.has('waiting_on')) db.exec(`ALTER TABLE followups ADD COLUMN waiting_on TEXT`);
})();

// ---- Migration: tax on payments (spec E10) - the tax portion of a deposit,
// separate from the payment amount itself. Additive, nullable. ----
(function migratePaymentsTax() {
  const existing = new Set(db.prepare(`PRAGMA table_info(payments)`).all().map((c) => c.name));
  if (!existing.has('tax')) db.exec(`ALTER TABLE payments ADD COLUMN tax REAL`);
})();

(function migrateCustomerFilesSoftDelete() {
  const existing = new Set(db.prepare(`PRAGMA table_info(customer_files)`).all().map((c) => c.name));
  if (!existing.has('deleted_at')) db.exec(`ALTER TABLE customer_files ADD COLUMN deleted_at TEXT`);
  if (!existing.has('deleted_by')) db.exec(`ALTER TABLE customer_files ADD COLUMN deleted_by TEXT`);
})();

// ---- Migration: file-filing state for assistant uploads (spec B4, 2026-09-18).
// assignment_status is null for every file uploaded the normal way (the
// customer/job Files panel - customer_id was explicit and unambiguous).
// Assistant-widget uploads instead start 'needs_review' with customer_id NULL,
// and get resolved to 'confirmed' (named customer, or manually assigned) or
// 'unconfirmed' (suggested_customer_id set to the on-screen customer, pending
// Andrew's Confirm/Undo) once the accompanying message is sent. ----
(function migrateCustomerFilesAssignmentStatus() {
  const existing = new Set(db.prepare(`PRAGMA table_info(customer_files)`).all().map((c) => c.name));
  if (!existing.has('assignment_status')) db.exec(`ALTER TABLE customer_files ADD COLUMN assignment_status TEXT`);
  if (!existing.has('suggested_customer_id')) db.exec(`ALTER TABLE customer_files ADD COLUMN suggested_customer_id TEXT`);
})();

// ---- Migration: customer_files.customer_id must be NULLABLE. A file uploaded
// through the Assistant chat while Andrew is NOT on a customer page (Overview,
// KPI, etc.) has no customer to attach to yet - the old NOT NULL constraint
// made that insert throw, which surfaced in the widget as the generic
// "Could not reach the assistant." Rebuild the table (SQLite can't ALTER a
// column constraint) preserving every column, dropping NOT NULL on
// customer_id, and making the FK ON DELETE SET NULL. Guarded: only runs while
// the column is still NOT NULL. ----
(function migrateCustomerFilesNullableCustomer() {
  const info = db.prepare(`PRAGMA table_info(customer_files)`).all();
  const cid = info.find((c) => c.name === 'customer_id');
  if (!cid || cid.notnull === 0) return; // table absent or already nullable

  const cols = info.map((c) => c.name);
  const defs = info.map((c) => {
    if (c.pk) return `${c.name} ${c.type || 'TEXT'} PRIMARY KEY`;
    if (c.name === 'customer_id') return `customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL`;
    let d = `${c.name} ${c.type || 'TEXT'}`;
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
    return d;
  });

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  try {
    db.exec(`CREATE TABLE customer_files_new (\n  ${defs.join(',\n  ')}\n);`);
    db.exec(`INSERT INTO customer_files_new (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM customer_files;`);
    db.exec('DROP TABLE customer_files;');
    db.exec('ALTER TABLE customer_files_new RENAME TO customer_files;');
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    db.exec('PRAGMA foreign_keys = ON;');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON;');
})();

// ---- Migration: appointments get a private public_token (like jobs already
// have) and a separate `confirmed` flag (spec G2.4) - NOT a new status value,
// since much of the app filters on status = 'scheduled'. Additive/backfilled. ----
(function migrateAppointmentsTokenAndConfirmed() {
  const existing = new Set(db.prepare(`PRAGMA table_info(appointments)`).all().map((c) => c.name));
  if (!existing.has('public_token')) db.exec(`ALTER TABLE appointments ADD COLUMN public_token TEXT`);
  if (!existing.has('confirmed')) db.exec(`ALTER TABLE appointments ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0`);
  const missingToken = db.prepare(`SELECT id FROM appointments WHERE public_token IS NULL`).all();
  for (const row of missingToken) {
    db.prepare(`UPDATE appointments SET public_token = ? WHERE id = ?`).run(newToken(), row.id);
  }
})();

// ---- Migration: messages.customer_id must be NULLABLE (spec F2.3) - a
// send-to-anyone message (F3) or an inbound message from an unrecognized
// sender has no customer to attach to. Same rebuild approach as
// customer_files above (SQLite can't ALTER a column constraint away). ----
(function migrateMessagesNullableCustomer() {
  const info = db.prepare(`PRAGMA table_info(messages)`).all();
  const cid = info.find((c) => c.name === 'customer_id');
  if (!cid || cid.notnull === 0) return; // table absent or already nullable

  const cols = info.map((c) => c.name);
  const defs = info.map((c) => {
    if (c.pk) return `${c.name} ${c.type || 'TEXT'} PRIMARY KEY`;
    if (c.name === 'customer_id') return `customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL`;
    let d = `${c.name} ${c.type || 'TEXT'}`;
    if (c.notnull) d += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
    return d;
  });

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN;');
  try {
    db.exec(`CREATE TABLE messages_new (\n  ${defs.join(',\n  ')}\n);`);
    db.exec(`INSERT INTO messages_new (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM messages;`);
    db.exec('DROP TABLE messages;');
    db.exec('ALTER TABLE messages_new RENAME TO messages;');
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    db.exec('PRAGMA foreign_keys = ON;');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON;');
})();

// ---- Migration: messages gains subject (email) and to_address (F2/F3) -
// who a no-customer send actually went to, since there's no customer record
// to look the address up on - plus the full provider response (F1.1), so
// Communication History can show more than a bare "sent". Additive/nullable. ----
(function migrateMessagesColumns() {
  const existing = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name));
  if (!existing.has('subject')) db.exec(`ALTER TABLE messages ADD COLUMN subject TEXT`);
  if (!existing.has('to_address')) db.exec(`ALTER TABLE messages ADD COLUMN to_address TEXT`);
  if (!existing.has('provider_response')) db.exec(`ALTER TABLE messages ADD COLUMN provider_response TEXT`);
})();

// ---- Chart of Accounts seed (only if empty). Small-shop Schedule-C shaped
// buckets; editable later. ----
(function seedChartOfAccounts() {
  const n = db.prepare(`SELECT COUNT(*) as n FROM chart_of_accounts`).get().n;
  if (n > 0) return;
  const accounts = [
    ['4000', 'Job Revenue', 'income'],
    ['4100', 'Other Income', 'income'],
    ['5000', 'Materials & Supplies', 'expense'],
    ['5100', 'Subcontractors & Labor', 'expense'],
    ['5200', 'Cabinet Hardware', 'expense'],
    ['5300', 'Tools & Equipment', 'expense'],
    ['6000', 'Vehicle & Fuel', 'expense'],
    ['6100', 'Insurance', 'expense'],
    ['6200', 'Rent & Utilities', 'expense'],
    ['6300', 'Marketing & Advertising', 'expense'],
    ['6400', 'Software & Office', 'expense'],
    ['6500', 'Professional Fees (legal/accounting)', 'expense'],
    ['6600', 'Bank & Merchant Fees', 'expense'],
    ['6700', 'Meals', 'expense'],
    ['6800', 'Shipping & Freight', 'expense'],
    ['9000', 'Uncategorized / Needs Review', 'expense'],
    ['9900', 'Other', 'expense'],
  ];
  accounts.forEach(([code, name, type], i) => {
    db.prepare(`INSERT INTO chart_of_accounts (id, code, name, type, active, sort_order, created_at) VALUES (?,?,?,?,1,?,?)`)
      .run(newId(), code, name, type, i, nowIso());
  });
})();

// ---- Funnel / job stage config ----
// LEGACY lead stages - kept so the old leads table + funnel keep working while
// the customer-level sales model (SALES_STAGES below) becomes the source of truth.
// There is deliberately NO "Lost" (spec 001): not buying is not "lost", and
// "Closed / We Declined Customer" means we walked away. Old lead rows that still
// carry the retired value are left exactly as they are (no history rewrite);
// they simply aren't a valid stage to set, and they never count as an open lead.
const LEAD_STAGES = ['New Lead', 'Contacted', 'Quoted', 'Sold'];
// A lead still in play = every legacy stage except Sold. A booking reuses one of
// these; anything else (Sold, or a retired legacy value) gets a fresh lead.
const OPEN_LEAD_STAGES = LEAD_STAGES.filter((s) => s !== 'Sold');
function assertLeadStage(stage) {
  if (!LEAD_STAGES.includes(stage)) throw new Error(`Unknown lead stage: ${stage}. Valid: ${LEAD_STAGES.join(', ')}`);
}

// ---- Sales model (Phase 2) -------------------------------------------------
// The PRIMARY, measurable stage of the opportunity. There is deliberately no
// generic "Lost": a customer that hasn't bought is still active/dormant, not
// lost. The only terminal negative is an explicit mutual "Closed / We Declined".
const SALES_STAGES = [
  'Bona Fide Lead',
  'Design Appointment Set',
  'Design Appointment Completed',
  'Estimate Presented',
  'Sold',
  'Closed / We Declined Customer',
];
// The forward funnel for KPI conversion math (excludes the terminal disposition).
const SALES_FUNNEL = SALES_STAGES.slice(0, 5);

// Attention sub-statuses are advisory and stage-scoped. They say what needs
// doing; they do NOT move the KPI stage. '' / null means "nothing flagged".
const STAGE_SUBSTATUSES = {
  'Bona Fide Lead': ['New - needs first contact', 'Attempting contact', 'Waiting on customer', 'Dormant'],
  'Design Appointment Set': ['Upcoming', 'Past / Missed', 'Reschedule Needed'],
  'Design Appointment Completed': [
    'Estimate Promised',
    'Estimate Being Prepared',
    'Estimate Due Soon',
    'Estimate Overdue',
    'No Estimate Required',
  ],
  'Estimate Presented': [
    'Needs Further Action',
    'Follow-up Scheduled',
    'Follow-up Due',
    'Follow-up Overdue',
    'Revision Needed',
    'Customer Requested Information',
    'Send Referrals',
    'Waiting on Customer',
    'No Further Action / Dormant',
  ],
  Sold: [],
  'Closed / We Declined Customer': [],
};

// ---- One-time backfill: derive each customer's sales_stage from whatever
// signal we already have (jobs > completed design appt > scheduled design
// appt > legacy lead stage). Only runs for customers whose sales_stage is
// still NULL, so it never overwrites a stage that's been set intentionally. ----
(function backfillSalesStage() {
  // Legacy-row translation only: an old leads row that still says 'Lost' (retired,
  // spec 001) maps to the customer-level closed stage. Nothing can SET Lost any more.
  const legacyMap = {
    'New Lead': 'Bona Fide Lead',
    Contacted: 'Bona Fide Lead',
    Quoted: 'Estimate Presented',
    Sold: 'Sold',
    Lost: 'Closed / We Declined Customer',
  };
  const rows = db.prepare(`SELECT id, created_at FROM customers WHERE sales_stage IS NULL`).all();
  for (const c of rows) {
    let stage = 'Bona Fide Lead';
    const legacy = db
      .prepare(`SELECT stage FROM leads WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(c.id);
    if (legacy && legacyMap[legacy.stage]) stage = legacyMap[legacy.stage];
    const hasJob = db.prepare(`SELECT 1 FROM jobs WHERE customer_id = ? LIMIT 1`).get(c.id);
    const designTypes = "('Short Design Consultation','Long Design Consultation','Design Review','Design Appointment','Consultation')";
    const completedDesign = db
      .prepare(`SELECT 1 FROM appointments WHERE customer_id = ? AND status = 'completed' AND type IN ${designTypes} LIMIT 1`)
      .get(c.id);
    const scheduledDesign = db
      .prepare(`SELECT 1 FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND type IN ${designTypes} LIMIT 1`)
      .get(c.id);
    const order = SALES_STAGES;
    const atLeast = (candidate) => {
      if (order.indexOf(candidate) > order.indexOf(stage)) stage = candidate;
    };
    if (scheduledDesign) atLeast('Design Appointment Set');
    if (completedDesign) atLeast('Design Appointment Completed');
    if (hasJob) atLeast('Sold');
    db.prepare(`UPDATE customers SET sales_stage = ?, updated_at = COALESCE(updated_at, ?), first_contact_at = COALESCE(first_contact_at, ?) WHERE id = ?`)
      .run(stage, c.created_at, c.created_at, c.id);
  }
})();

const JOB_STAGES = [
  'Order Confirmed',
  'Measuring Scheduled',
  'Measured',
  'In Production',
  'Ready for Install',
  'Install Scheduled',
  'Complete',
];

// ---- Migration: the "Install Scheduled" stage used to be called "Installing".
// Rename any existing rows so old jobs still match a valid JOB_STAGES entry
// (the public status-timeline page indexes into JOB_STAGES by name). ----
(function migrateInstallingStatus() {
  db.prepare(`UPDATE jobs SET status = 'Install Scheduled' WHERE status = 'Installing'`).run();
  db.prepare(`UPDATE job_status_history SET status = 'Install Scheduled' WHERE status = 'Installing'`).run();
})();
// ---- Migration (spec 033): optional estimated install date on a job. Additive,
// nullable, never back-filled - it is only ever set by a person (or a later,
// explicit feature), never derived from measurements. ----
(function migrateJobsEstimatedInstall() {
  const existing = new Set(db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name));
  if (!existing.has('estimated_install_at')) db.exec(`ALTER TABLE jobs ADD COLUMN estimated_install_at TEXT`);
})();
const APPT_TYPES = ['Short Design Consultation', 'Long Design Consultation', 'Design Review', 'Repair or Warranty', 'Measure', 'Install'];
// Internal-only types (spec 034): scheduled from the dashboard, never offered on
// the public /book page, and never counted as a design appointment (the KPI
// funnel reads customers.sales_stage; stage auto-advance only fires for
// design/consultation types; consultant stats skip 'Measure').
const INTERNAL_APPT_TYPES = ['Measure', 'Install'];

// Per-product factory pipeline - separate from JOB_STAGES (the coarse,
// customer-facing status). This is the internal, per-piece tracking that
// feeds the Factory Queue.
const PRODUCT_STAGES = ['Queued for Factory', 'Sent to Factory', 'In Production', 'Ready for Delivery', 'Delivered'];

// ---- Sale packet completion (spec 034) -------------------------------------
// Runs when a packet is signed on this device OR emailed (with confirmation).
// Either way, exactly the same outcome:
//   - customer sales_stage -> Sold (and their open legacy lead -> Sold)
//   - a job exists (reuse the customer's newest unfinished job, else create one)
//   - that job's status -> Measuring Scheduled (never moves a job BACKWARD)
//   - one open follow-up "Schedule measure" (never a duplicate)
// It deliberately sends NOTHING. The caller decides, on Andrew's explicit yes,
// whether to also fire automations.onJobCreated (the customer text/email).
// Safe to run twice: every step is a no-op if it's already true.
const SALE_PACKET_FOLLOWUP_TITLE = 'Schedule measure';
function completeSalePacket(customer_id, { actor, via } = {}) {
  const c = getCustomer(customer_id);
  if (!c) throw new Error('Customer not found');
  const who = actor || 'user';
  const note = `Sale packet ${via || 'completed'}`;
  const out = { customer_id, stage_changed: false, job: null, job_created: false, job_status_changed: false, followup_created: false };
  db.exec('BEGIN;');
  try {
    if (c.sales_stage !== 'Sold') {
      setSalesStage(customer_id, 'Sold', { substatus: null, actor: who, note });
      out.stage_changed = true;
    }
    const leads = listLeads().filter((l) => l.customer_id === customer_id);
    const openLead = leads.find((l) => OPEN_LEAD_STAGES.includes(l.stage));
    if (openLead) updateLeadStage(openLead.id, 'Sold');

    let job = listJobs()
      .filter((j) => j.customer_id === customer_id && j.status !== 'Complete')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!job) {
      const lead = openLead || leads.find((l) => l.stage === 'Sold') || null;
      job = createJob({ lead_id: lead ? lead.id : null, customer_id, sold_amount: lead ? lead.estimate_value : null });
      out.job_created = true;
    }
    if (JOB_STAGES.indexOf(job.status) < JOB_STAGES.indexOf('Measuring Scheduled')) {
      job = updateJobStatus(job.id, 'Measuring Scheduled', note);
      out.job_status_changed = true;
    }
    out.job = getJob(job.id);

    if (!listFollowups(customer_id).some((f) => f.title === SALE_PACKET_FOLLOWUP_TITLE)) {
      createFollowup({
        customer_id,
        kind: 'next_action',
        title: SALE_PACKET_FOLLOWUP_TITLE,
        due_at: dateInputToIso(etDateString()),
        created_by: who,
      });
      out.followup_created = true;
    }
    logActivity({ entity_type: 'customer', entity_id: customer_id, customer_id, field: 'sale_packet_completed', new_value: via || 'completed', actor: who });
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  return out;
}

// ---- Bookkeeping categories ----
// Loosely mirrors Schedule C style line items, simplified for a small shop.
// Not tax advice - just consistent buckets so year-end totals are easy to hand off.
const INCOME_CATEGORIES = ['Job Revenue', 'Other Income'];
const EXPENSE_CATEGORIES = [
  'Materials & Supplies',
  'Subcontractors & Labor',
  'Tools & Equipment',
  'Vehicle & Fuel',
  'Insurance',
  'Rent & Utilities',
  'Marketing & Advertising',
  'Software & Office',
  'Professional Fees (legal/accounting)',
  'Bank & Merchant Fees',
  'Other',
];

// ---- Customers ----
function createCustomer({ name, phone, email, address, notes, sales_stage, source_id, campaign_id, actor }) {
  const id = newId();
  const ts = nowIso();
  const stage = sales_stage && SALES_STAGES.includes(sales_stage) ? sales_stage : 'Bona Fide Lead';
  db.prepare(
    `INSERT INTO customers (id, name, phone, email, address, notes, created_at, sales_stage, stage_substatus,
       dormant, updated_at, source_id, campaign_id, first_contact_at)
     VALUES (?,?,?,?,?,?,?,?,?, 0, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    phone || null,
    email || null,
    address || null,
    notes || null,
    ts,
    stage,
    null,
    ts,
    source_id || null,
    campaign_id || null,
    ts
  );
  logActivity({
    entity_type: 'customer',
    entity_id: id,
    customer_id: id,
    field: 'created',
    new_value: name,
    actor: actor || 'user',
  });
  if (source_id || campaign_id) {
    setCustomerAttribution({ customer_id: id, source_id, campaign_id, note: 'set at customer creation', actor: actor || 'user' });
  }
  return getCustomer(id);
}
function getCustomer(id) {
  return db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}
function findCustomerByPhoneOrEmail(phone, email) {
  if (phone) {
    const r = db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(phone);
    if (r) return r;
  }
  if (email) {
    const r = db.prepare(`SELECT * FROM customers WHERE email = ?`).get(email);
    if (r) return r;
  }
  return null;
}
function listCustomers() {
  return db.prepare(`SELECT * FROM customers ORDER BY created_at DESC`).all();
}
function updateCustomer(id, { name, phone, email, address, notes }, { actor } = {}) {
  const prev = getCustomer(id);
  db.prepare(
    `UPDATE customers SET name=?, phone=?, email=?, address=?, notes=?, updated_at=? WHERE id=?`
  ).run(name, phone || null, email || null, address || null, notes || null, nowIso(), id);
  if (prev) {
    for (const f of ['name', 'phone', 'email', 'address']) {
      const nv = { name, phone, email, address }[f] || null;
      if ((prev[f] || null) !== (nv || null)) {
        logActivity({ entity_type: 'customer', entity_id: id, customer_id: id, field: f, old_value: prev[f], new_value: nv, actor: actor || 'user' });
      }
    }
  }
  return getCustomer(id);
}

// ---- Leads ----
function createLead({ customer_id, stage, source, estimate_value, notes, consultant_id }) {
  if (stage) assertLeadStage(stage);
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO leads (id, customer_id, stage, source, estimate_value, notes, created_at, updated_at, consultant_id) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, customer_id, stage || 'New Lead', source || null, estimate_value || null, notes || null, ts, ts, consultant_id || null);
  return getLead(id);
}
function getLead(id) {
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
}
function listLeads() {
  return db
    .prepare(
      `SELECT leads.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email
       FROM leads JOIN customers ON customers.id = leads.customer_id
       ORDER BY leads.updated_at DESC`
    )
    .all();
}
function updateLeadStage(id, stage) {
  assertLeadStage(stage);
  db.prepare(`UPDATE leads SET stage=?, updated_at=? WHERE id=?`).run(stage, nowIso(), id);
  return getLead(id);
}
function updateLead(id, { estimate_value, notes, source }) {
  db.prepare(`UPDATE leads SET estimate_value=?, notes=?, source=?, updated_at=? WHERE id=?`).run(
    estimate_value || null,
    notes || null,
    source || null,
    nowIso(),
    id
  );
  return getLead(id);
}

// ---- Appointments ----
function createAppointment({ customer_id, lead_id, type, scheduled_at, duration_min, notes, created_by, consultant_id }) {
  const id = newId();
  const ts = nowIso();
  const token = newToken();
  db.prepare(
    `INSERT INTO appointments (id, customer_id, lead_id, type, scheduled_at, duration_min, status, reminder_sent, notes, created_at, updated_at, created_by, consultant_id, public_token, confirmed)
     VALUES (?,?,?,?,?,?, 'scheduled', 0, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, customer_id, lead_id || null, type || 'Consultation', scheduled_at, duration_min || 60, notes || null, ts, ts, created_by || 'user', consultant_id || null, token);
  logActivity({
    entity_type: 'appointment',
    entity_id: id,
    customer_id,
    field: 'created',
    new_value: `${type || 'Consultation'} @ ${scheduled_at}`,
    actor: created_by || 'user',
  });
  return getAppointment(id);
}
function getAppointment(id) {
  return db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
}
function getAppointmentByToken(token) {
  return db.prepare(`SELECT * FROM appointments WHERE public_token = ?`).get(token);
}
function confirmAppointment(id) {
  db.prepare(`UPDATE appointments SET confirmed = 1 WHERE id = ?`).run(id);
  return getAppointment(id);
}
function listAppointments({ upcomingOnly } = {}) {
  let sql = `SELECT appointments.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email
             FROM appointments JOIN customers ON customers.id = appointments.customer_id`;
  if (upcomingOnly) sql += ` WHERE appointments.status = 'scheduled' AND appointments.scheduled_at >= datetime('now', '-1 hour')`;
  sql += ` ORDER BY appointments.scheduled_at ASC`;
  return db.prepare(sql).all();
}
function listAppointmentsBetween(startIso, endIso) {
  return db
    .prepare(
      `SELECT appointments.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email
       FROM appointments JOIN customers ON customers.id = appointments.customer_id
       WHERE appointments.status = 'scheduled' AND appointments.scheduled_at BETWEEN ? AND ?`
    )
    .all(startIso, endIso);
}
function markReminderSent(id) {
  db.prepare(`UPDATE appointments SET reminder_sent = 1 WHERE id = ?`).run(id);
}
function updateAppointmentStatus(id, status) {
  db.prepare(`UPDATE appointments SET status=? WHERE id=?`).run(status, id);
  return getAppointment(id);
}

// ---- Jobs ----
function createJob({ lead_id, customer_id, sold_amount, notes }) {
  const id = newId();
  const ts = nowIso();
  const token = newToken();
  db.prepare(
    `INSERT INTO jobs (id, lead_id, customer_id, public_token, status, sold_amount, notes, created_at, updated_at)
     VALUES (?,?,?,?, 'Order Confirmed', ?, ?, ?, ?)`
  ).run(id, lead_id || null, customer_id, token, sold_amount || null, notes || null, ts, ts);
  addJobStatusHistory(id, 'Order Confirmed', 'Job created');
  return getJob(id);
}
function updateJobSoldAmount(id, sold_amount) {
  db.prepare(`UPDATE jobs SET sold_amount = ?, updated_at = ? WHERE id = ?`).run(
    sold_amount === undefined || sold_amount === null || sold_amount === '' ? null : Number(sold_amount),
    nowIso(),
    id
  );
  return getJob(id);
}
// Set / change / clear (blank) the estimated install date. Stored the same way
// as other due dates: an ISO timestamp at noon UTC, so it is the same calendar
// day in Eastern time. Audited in the activity log.
function updateJobEstimatedInstall(id, value, actor) {
  const job = getJob(id);
  if (!job) return null;
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw && !isCalendarDate(raw)) throw new Error('Not a valid date');
  const iso = raw ? dateInputToIso(raw) : null;
  if ((job.estimated_install_at || null) === iso) return job;
  db.prepare(`UPDATE jobs SET estimated_install_at = ?, updated_at = ? WHERE id = ?`).run(iso, nowIso(), id);
  logActivity({
    entity_type: 'job',
    entity_id: id,
    customer_id: job.customer_id,
    field: 'estimated_install_at',
    old_value: job.estimated_install_at || null,
    new_value: iso,
    actor: actor || 'user',
  });
  return getJob(id);
}
function getJob(id) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}
function getJobByToken(token) {
  return db.prepare(`SELECT * FROM jobs WHERE public_token = ?`).get(token);
}
function listJobs() {
  return db
    .prepare(
      `SELECT jobs.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email
       FROM jobs JOIN customers ON customers.id = jobs.customer_id
       ORDER BY jobs.updated_at DESC`
    )
    .all();
}
function updateJobStatus(id, status, note) {
  db.prepare(`UPDATE jobs SET status=?, updated_at=? WHERE id=?`).run(status, nowIso(), id);
  addJobStatusHistory(id, status, note || null);
  return getJob(id);
}
function addJobStatusHistory(job_id, status, note) {
  db.prepare(`INSERT INTO job_status_history (job_id, status, note, created_at) VALUES (?,?,?,?)`).run(
    job_id,
    status,
    note || null,
    nowIso()
  );
}
function getJobHistory(job_id) {
  return db.prepare(`SELECT * FROM job_status_history WHERE job_id = ? ORDER BY created_at ASC`).all(job_id);
}

// ---- Products (factory order line items) ----
function createProduct({
  job_id,
  name,
  measurements,
  quantity,
  factory,
  deadline,
  notes,
  cabinet_type,
  type_code,
  mount_style,
  rail_type,
  color,
  divider,
  opening_width_mm,
  unit_price,
}) {
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO products (
       id, job_id, name, measurements, quantity, factory, deadline, status, notes, created_at, updated_at,
       cabinet_type, type_code, mount_style, rail_type, color, divider, opening_width_mm, unit_price
     ) VALUES (?,?,?,?,?,?,?, 'Queued for Factory', ?, ?, ?, ?,?,?,?,?,?,?,?)`
  ).run(
    id,
    job_id,
    name,
    measurements || null,
    quantity || 1,
    factory || null,
    deadline || null,
    notes || null,
    ts,
    ts,
    cabinet_type || null,
    type_code || null,
    mount_style || null,
    rail_type || null,
    color || null,
    divider || null,
    opening_width_mm || null,
    unit_price || null
  );
  addProductStatusHistory(id, 'Queued for Factory', 'Added to order');
  return getProduct(id);
}
function getProduct(id) {
  return db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
}
function listProductsForJob(job_id) {
  return db.prepare(`SELECT * FROM products WHERE job_id = ? ORDER BY created_at ASC`).all(job_id);
}
// Cross-job queue for the factory floor. Excludes Delivered by default so the
// queue only shows what's still active; pass includeDelivered to see everything.
function listProductionQueue({ includeDelivered } = {}) {
  let sql = `SELECT products.*, jobs.customer_id as job_customer_id, customers.name as customer_name
      FROM products
      JOIN jobs ON jobs.id = products.job_id
      JOIN customers ON customers.id = jobs.customer_id`;
  if (!includeDelivered) sql += ` WHERE products.status != 'Delivered'`;
  sql += ` ORDER BY (products.deadline IS NULL), products.deadline ASC, products.created_at ASC`;
  return db.prepare(sql).all();
}
function updateProductStatus(id, status, note) {
  db.prepare(`UPDATE products SET status=?, updated_at=? WHERE id=?`).run(status, nowIso(), id);
  addProductStatusHistory(id, status, note || null);
  return getProduct(id);
}
function updateProduct(
  id,
  { name, measurements, quantity, factory, deadline, notes, cabinet_type, type_code, mount_style, rail_type, color, divider, opening_width_mm, unit_price }
) {
  db.prepare(
    `UPDATE products SET name=?, measurements=?, quantity=?, factory=?, deadline=?, notes=?, updated_at=?,
       cabinet_type=?, type_code=?, mount_style=?, rail_type=?, color=?, divider=?, opening_width_mm=?, unit_price=?
     WHERE id=?`
  ).run(
    name,
    measurements || null,
    quantity || 1,
    factory || null,
    deadline || null,
    notes || null,
    nowIso(),
    cabinet_type || null,
    type_code || null,
    mount_style || null,
    rail_type || null,
    color || null,
    divider || null,
    opening_width_mm || null,
    unit_price || null,
    id
  );
  return getProduct(id);
}

// ---- Product options (editable dropdown lists: cabinet types, type codes,
// mount styles, rail types, colors) - lets Andrew add/remove choices from the
// dashboard without needing a code change. ----
const PRODUCT_OPTION_CATEGORIES = [
  { key: 'cabinet_type', label: 'Cabinet / Product Types' },
  { key: 'type_code', label: 'Type Codes' },
  { key: 'mount_style', label: 'Mount Styles' },
  { key: 'rail_type', label: 'Rail Types' },
  { key: 'color', label: 'Colors' },
  { key: 'divider', label: 'Dividers' },
];
function listProductOptions(category) {
  return db
    .prepare(`SELECT * FROM product_options WHERE category = ? AND active = 1 ORDER BY sort_order ASC, code ASC`)
    .all(category);
}
function listAllProductOptionsGrouped() {
  const out = {};
  for (const cat of PRODUCT_OPTION_CATEGORIES) out[cat.key] = listProductOptions(cat.key);
  return out;
}
function createProductOption({ category, code, label }) {
  const id = newId();
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as m FROM product_options WHERE category = ?`).get(category).m;
  db.prepare(
    `INSERT INTO product_options (id, category, code, label, sort_order, active, created_at) VALUES (?,?,?,?,?,1,?)`
  ).run(id, category, code, label || code, maxOrder + 1, nowIso());
  return id;
}
function deleteProductOption(id) {
  db.prepare(`UPDATE product_options SET active = 0 WHERE id = ?`).run(id);
}
function addProductStatusHistory(product_id, status, note) {
  db.prepare(`INSERT INTO product_status_history (product_id, status, note, created_at) VALUES (?,?,?,?)`).run(
    product_id,
    status,
    note || null,
    nowIso()
  );
}
function getProductHistory(product_id) {
  return db.prepare(`SELECT * FROM product_status_history WHERE product_id = ? ORDER BY created_at ASC`).all(product_id);
}

// ---- Customer files ----
// Actual bytes live on disk under DATA_DIR/uploads/<customer_id>/<stored_name>
// (see UPLOADS_DIR below); this table just tracks the metadata so it can be
// listed/served/deleted per customer.
function syncFileSearch(id) {
  const f = db.prepare(`SELECT id, original_name, note, extracted_text, deleted_at FROM customer_files WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM file_search WHERE file_id = ?`).run(id);
  if (!f || f.deleted_at) return;
  db.prepare(`INSERT INTO file_search (file_id, original_name, note, extracted_text) VALUES (?,?,?,?)`).run(
    f.id,
    f.original_name || '',
    f.note || '',
    f.extracted_text || ''
  );
}
function createCustomerFile({ customer_id, job_id, stored_name, original_name, mime_type, size, note, assignment_status, suggested_customer_id }) {
  const id = newId();
  db.prepare(
    `INSERT INTO customer_files (id, customer_id, job_id, stored_name, original_name, mime_type, size, note, created_at, assignment_status, suggested_customer_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    customer_id || null,
    job_id || null,
    stored_name,
    original_name,
    mime_type || null,
    size || 0,
    note || null,
    nowIso(),
    assignment_status || null,
    suggested_customer_id || null
  );
  syncFileSearch(id);
  return id;
}
// Resolves (or corrects) which customer an assistant-uploaded file belongs
// to. Passing customer_id clears suggested_customer_id and marks 'confirmed'
// unless a different status is given explicitly (used to move a file back to
// 'needs_review' on Undo).
function setFileAssignment(id, { customer_id, assignment_status, suggested_customer_id }) {
  db.prepare(`UPDATE customer_files SET customer_id = ?, assignment_status = ?, suggested_customer_id = ? WHERE id = ?`).run(
    customer_id || null,
    assignment_status || null,
    suggested_customer_id || null,
    id
  );
  return getCustomerFile(id);
}
function listFilesNeedingReview() {
  return db
    .prepare(
      `SELECT customer_files.*, customers.name as suggested_customer_name
       FROM customer_files LEFT JOIN customers ON customers.id = customer_files.suggested_customer_id
       WHERE customer_files.deleted_at IS NULL AND customer_files.assignment_status IN ('unconfirmed', 'needs_review')
       ORDER BY customer_files.created_at DESC`
    )
    .all();
}
// A simple, deliberately conservative name match: only fires when exactly one
// customer's full name appears in the text, so an ambiguous or absent name
// never causes a guess (spec B4 - "never the sole basis" without confidence).
function findConfidentCustomerByName(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const matches = listCustomers().filter((c) => c.name && lower.includes(c.name.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}
// Pure decision for where an unfiled assistant upload should land (spec B4):
// a customer named in the message always wins, even over the on-screen
// customer; the on-screen customer alone only ever produces an unconfirmed
// suggestion; neither signal means Needs Review, never a guess.
function decideFileAssignment({ message, ctxCustomer }) {
  const named = findConfidentCustomerByName(message);
  if (named) return { customer_id: named.id, assignment_status: 'confirmed', suggested_customer_id: null, customer: named };
  if (ctxCustomer) return { customer_id: null, assignment_status: 'unconfirmed', suggested_customer_id: ctxCustomer.id, customer: ctxCustomer };
  return { customer_id: null, assignment_status: 'needs_review', suggested_customer_id: null, customer: null };
}
function listCustomerFiles(customer_id, { includeDeleted } = {}) {
  return db
    .prepare(
      `SELECT customer_files.*, jobs.status as job_status
       FROM customer_files LEFT JOIN jobs ON jobs.id = customer_files.job_id
       WHERE customer_files.customer_id = ?${includeDeleted ? '' : ' AND customer_files.deleted_at IS NULL'}
       ORDER BY customer_files.created_at DESC`
    )
    .all(customer_id);
}
function listJobFiles(job_id) {
  return db
    .prepare(`SELECT * FROM customer_files WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .all(job_id);
}
function getCustomerFile(id) {
  return db.prepare(`SELECT * FROM customer_files WHERE id = ?`).get(id) || null;
}
function attachFileToJob(id, job_id) {
  db.prepare(`UPDATE customer_files SET job_id = ? WHERE id = ?`).run(job_id || null, id);
  return getCustomerFile(id);
}
function setFileExtraction(id, { extracted_text, extracted_json, status }) {
  db.prepare(
    `UPDATE customer_files SET extracted_text = ?, extracted_json = ?, extraction_status = ?, extracted_at = ? WHERE id = ?`
  ).run(
    extracted_text || null,
    extracted_json ? (typeof extracted_json === 'string' ? extracted_json : JSON.stringify(extracted_json)) : null,
    status || 'done',
    nowIso(),
    id
  );
  syncFileSearch(id);
  return getCustomerFile(id);
}
// Turns free user text into a safe FTS5 MATCH string: each whitespace-separated
// token becomes a quoted prefix term, so punctuation in the query can't produce
// an FTS syntax error. Empty query -> null (caller should skip the search).
function toFtsQuery(raw) {
  const tokens = String(raw || '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
function searchFiles(query) {
  const match = toFtsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT customer_files.*, customers.name as customer_name, jobs.status as job_status,
         snippet(file_search, 3, '[', ']', ' … ', 12) as snippet
       FROM file_search
       JOIN customer_files ON customer_files.id = file_search.file_id
       LEFT JOIN customers ON customers.id = customer_files.customer_id
       LEFT JOIN jobs ON jobs.id = customer_files.job_id
       WHERE file_search MATCH ?
       ORDER BY rank
       LIMIT 50`
    )
    .all(match);
}
// Newest files first, for the Files page when nothing has been typed yet (spec 025).
// Same shape as searchFiles() rows so one renderer serves both; snippet is null.
function listRecentFiles(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return db
    .prepare(
      `SELECT customer_files.*, customers.name as customer_name, jobs.status as job_status, NULL as snippet
       FROM customer_files
       LEFT JOIN customers ON customers.id = customer_files.customer_id
       LEFT JOIN jobs ON jobs.id = customer_files.job_id
       WHERE customer_files.deleted_at IS NULL
       ORDER BY customer_files.created_at DESC, customer_files.rowid DESC
       LIMIT ?`
    )
    .all(n);
}
function deleteCustomerFile(id) {
  db.prepare(`DELETE FROM customer_files WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM file_search WHERE file_id = ?`).run(id);
}

// ---- Sales training ----
// Deliberately no separate "proficiency" table - a rep's current standing is
// derived by reading their recent session log, not maintained as a second,
// easily-drifting source of truth. session_type is 'roleplay' | 'quiz' |
// 'real_sale'; outcome is only meaningful for 'real_sale' ('won'/'lost').
function createSalesRep({ name }) {
  const id = newId();
  db.prepare(`INSERT INTO sales_reps (id, name, created_at) VALUES (?,?,?)`).run(id, name, nowIso());
  return { id, name };
}
function listSalesReps() {
  return db.prepare(`SELECT * FROM sales_reps ORDER BY name ASC`).all();
}
function findSalesRepByName(name) {
  return db.prepare(`SELECT * FROM sales_reps WHERE name = ? COLLATE NOCASE`).get(name) || null;
}
function createTrainingSession({ rep_id, session_type, appointment_id, summary, techniques, outcome }) {
  const id = newId();
  db.prepare(
    `INSERT INTO training_sessions (id, rep_id, session_type, appointment_id, summary, techniques_json, outcome, created_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    rep_id,
    session_type,
    appointment_id || null,
    summary || null,
    techniques ? JSON.stringify(techniques) : null,
    outcome || null,
    nowIso()
  );
  return id;
}
function listTrainingSessions(rep_id, limit = 20) {
  return db
    .prepare(`SELECT * FROM training_sessions WHERE rep_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(rep_id, limit)
    .map((s) => ({ ...s, techniques: s.techniques_json ? JSON.parse(s.techniques_json) : null }));
}

// ---- Messages ----
function logMessage({ customer_id, direction, channel, subject, body, status, to_address, provider_response }) {
  const id = newId();
  db.prepare(
    `INSERT INTO messages (id, customer_id, direction, channel, subject, body, status, to_address, provider_response, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    customer_id || null,
    direction || 'out',
    channel || 'sms',
    subject || null,
    body || '',
    status || 'sent',
    to_address || null,
    provider_response || null,
    nowIso()
  );
  return id;
}
function listMessagesForCustomer(customer_id) {
  return db.prepare(`SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at ASC`).all(customer_id);
}
// Every message, newest first, customer optional (spec F2.2/F2.3) - a plain
// LEFT JOIN so a send-to-anyone or unmatched-sender message (no customer_id)
// still shows up instead of silently disappearing from the list.
function listAllMessages({ limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT messages.*, customers.name as customer_name FROM messages
       LEFT JOIN customers ON customers.id = messages.customer_id
       ORDER BY messages.created_at DESC LIMIT ?`
    )
    .all(limit);
}
function getMessage(id) {
  return db
    .prepare(
      `SELECT messages.*, customers.name as customer_name FROM messages
       LEFT JOIN customers ON customers.id = messages.customer_id
       WHERE messages.id = ?`
    )
    .get(id);
}
function listRecentMessages(limit = 50) {
  return db
    .prepare(
      `SELECT messages.*, customers.name as customer_name FROM messages
       JOIN customers ON customers.id = messages.customer_id
       ORDER BY messages.created_at DESC LIMIT ?`
    )
    .all(limit);
}

// ---- Payments / income ----
// job_id is optional - a payment can be logged without a job for misc/other income.
function createPayment({ job_id, customer_id, category, amount, method, note, paid_at, tax }) {
  const id = newId();
  db.prepare(
    `INSERT INTO payments (id, job_id, customer_id, category, amount, method, note, paid_at, created_at, tax) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    job_id || null,
    customer_id || null,
    category || 'Job Revenue',
    amount,
    method || null,
    note || null,
    paid_at || nowIso(),
    nowIso(),
    tax === undefined || tax === null || tax === '' ? null : Number(tax)
  );
  return id;
}
function listPayments({ start, end } = {}) {
  let sql = `SELECT payments.*,
        COALESCE(jobs.customer_id, payments.customer_id) as job_customer_id,
        customers.name as customer_name
      FROM payments
      LEFT JOIN jobs ON jobs.id = payments.job_id
      LEFT JOIN customers ON customers.id = COALESCE(jobs.customer_id, payments.customer_id)`;
  const params = [];
  if (start && end) {
    sql += ` WHERE payments.paid_at BETWEEN ? AND ?`;
    params.push(start, end);
  }
  sql += ` ORDER BY payments.paid_at DESC`;
  return db.prepare(sql).all(...params);
}
function totalIncome() {
  const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments`).get();
  return r.total;
}
function totalIncomeThisMonth() {
  const r = db
    .prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE strftime('%Y-%m', paid_at) = strftime('%Y-%m','now')`)
    .get();
  return r.total;
}
function totalIncomeBetween(start, end) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE paid_at BETWEEN ? AND ?`).get(start, end);
  return r.total;
}
function incomeByCategoryBetween(start, end) {
  return db
    .prepare(
      `SELECT category, COALESCE(SUM(amount),0) as total FROM payments WHERE paid_at BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`
    )
    .all(start, end);
}

// ---- Expenses ----
// Back-compat: old callers pass { job_id, expense_date, category, amount, vendor, method, note }.
// New capture callers also pass { merchant, memo, coa_account, payment_account, entry_source,
// receipt_file_id, external_ref, expense_at, needs_review, created_by }. `coa_account` null
// => the row is flagged needs_review and categorized 'Uncategorized / Needs Review'.
function createExpense(input) {
  const {
    job_id,
    expense_date,
    category,
    amount,
    vendor,
    method,
    note,
    merchant,
    memo,
    coa_account,
    payment_account,
    entry_source,
    receipt_file_id,
    external_ref,
    expense_at,
    needs_review,
    created_by,
  } = input;
  const id = newId();
  const when = expense_at || expense_date || nowIso();
  // Single place the "suggest a category when it's obvious, else flag for
  // review, never guess" rule lives - the route and the assistant both rely
  // on it. An explicit coa_account always wins.
  const acct = coa_account || suggestExpenseAccount(`${merchant || vendor || ''} ${memo || note || ''}`) || null;
  const review = needs_review === undefined ? (acct ? 0 : 1) : needs_review ? 1 : 0;
  const cat = category || acct || 'Uncategorized / Needs Review';
  db.prepare(
    `INSERT INTO expenses (id, job_id, expense_date, category, amount, vendor, method, note, created_at,
       merchant, memo, coa_account, payment_account, entry_source, reconciliation_status, receipt_file_id,
       external_ref, expense_at, needs_review, created_by)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, 'unreconciled', ?,?,?,?,?)`
  ).run(
    id,
    job_id || null,
    when,
    cat,
    Number(amount),
    vendor || merchant || null,
    method || null,
    note || memo || null,
    nowIso(),
    merchant || vendor || null,
    memo || note || null,
    acct,
    payment_account || null,
    entry_source || 'manual',
    receipt_file_id || null,
    external_ref || null,
    when,
    review,
    created_by || 'user'
  );
  logActivity({
    entity_type: 'expense',
    entity_id: id,
    field: 'created',
    new_value: `$${Number(amount).toFixed(2)} ${merchant || vendor || ''}`.trim(),
    note: acct ? acct : 'needs review',
    actor: created_by || 'user',
  });
  return id;
}
function getExpense(id) {
  return db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(id) || null;
}
function updateExpense(id, fields, { actor } = {}) {
  const e = getExpense(id);
  if (!e) return null;
  const m = {
    amount: fields.amount === undefined ? e.amount : Number(fields.amount),
    merchant: fields.merchant === undefined ? e.merchant : fields.merchant || null,
    memo: fields.memo === undefined ? e.memo : fields.memo || null,
    coa_account: fields.coa_account === undefined ? e.coa_account : fields.coa_account || null,
    category: fields.coa_account === undefined ? e.category : fields.coa_account || 'Uncategorized / Needs Review',
    payment_account: fields.payment_account === undefined ? e.payment_account : fields.payment_account || null,
    job_id: fields.job_id === undefined ? e.job_id : fields.job_id || null,
    receipt_file_id: fields.receipt_file_id === undefined ? e.receipt_file_id : fields.receipt_file_id || null,
    reconciliation_status: fields.reconciliation_status || e.reconciliation_status,
    expense_at: fields.expense_at || e.expense_at || e.expense_date,
    needs_review:
      fields.needs_review === undefined
        ? fields.coa_account
          ? 0
          : e.needs_review
        : fields.needs_review
          ? 1
          : 0,
  };
  db.prepare(
    `UPDATE expenses SET amount=?, merchant=?, memo=?, coa_account=?, category=?, payment_account=?, job_id=?,
       receipt_file_id=?, reconciliation_status=?, expense_at=?, expense_date=?, needs_review=?, vendor=?, note=? WHERE id=?`
  ).run(
    m.amount,
    m.merchant,
    m.memo,
    m.coa_account,
    m.category,
    m.payment_account,
    m.job_id,
    m.receipt_file_id,
    m.reconciliation_status,
    m.expense_at,
    m.expense_at,
    m.needs_review,
    m.merchant || e.vendor,
    m.memo || e.note,
    id
  );
  logActivity({ entity_type: 'expense', entity_id: id, field: 'updated', new_value: m.coa_account || 'needs review', actor: actor || 'user' });
  return getExpense(id);
}
function listUncategorizedExpenses() {
  return db.prepare(`SELECT * FROM expenses WHERE needs_review = 1 ORDER BY expense_at DESC, expense_date DESC`).all();
}
// Future-facing: when a bank/card import lands, match a manually-captured
// expense instead of duplicating it. Match = same signed amount within a few
// days and no external_ref yet. Returns candidates, does not auto-apply.
function findExpenseMatchCandidates({ amount, date, days = 4 }) {
  const amt = Number(amount);
  const d = new Date(date || nowIso());
  const lo = new Date(d.getTime() - days * 86400000).toISOString();
  const hi = new Date(d.getTime() + days * 86400000).toISOString();
  return db
    .prepare(
      `SELECT * FROM expenses
       WHERE external_ref IS NULL
         AND ABS(amount - ?) < 0.005
         AND COALESCE(expense_at, expense_date) BETWEEN ? AND ?
       ORDER BY COALESCE(expense_at, expense_date) DESC`
    )
    .all(amt, lo, hi);
}
function listExpenses({ start, end } = {}) {
  let sql = `SELECT expenses.*, jobs.customer_id as job_customer_id, customers.name as job_customer_name
      FROM expenses
      LEFT JOIN jobs ON jobs.id = expenses.job_id
      LEFT JOIN customers ON customers.id = jobs.customer_id`;
  const params = [];
  if (start && end) {
    sql += ` WHERE expenses.expense_date BETWEEN ? AND ?`;
    params.push(start, end);
  }
  sql += ` ORDER BY expenses.expense_date DESC`;
  return db.prepare(sql).all(...params);
}
function totalExpenses() {
  const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses`).get();
  return r.total;
}
function totalExpensesThisMonth() {
  const r = db
    .prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m','now')`)
    .get();
  return r.total;
}
function totalExpensesBetween(start, end) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date BETWEEN ? AND ?`).get(start, end);
  return r.total;
}
function expensesByCategoryBetween(start, end) {
  return db
    .prepare(
      `SELECT category, COALESCE(SUM(amount),0) as total FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`
    )
    .all(start, end);
}

// ---- Cash flow / AR ----
// What's still owed on a job (sold_amount minus whatever's been paid against
// it). Not a bank balance - just the gap between what was sold and what's
// been collected so far.
function getJobBalance(job_id) {
  const job = getJob(job_id);
  if (!job) return null;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE job_id = ?`).get(job_id).total;
  return (job.sold_amount || 0) - paid;
}

// Every job with money still owed, plus - per Andrew's rule - the balance is
// expected the day of that job's Install appointment. If no Install is
// scheduled yet, expected_payment_date is null and the timing is genuinely
// unknown (flag it as such, don't guess a date).
function listOutstandingJobBalances() {
  const jobs = db
    .prepare(
      `SELECT jobs.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email,
         COALESCE((SELECT SUM(amount) FROM payments WHERE payments.job_id = jobs.id), 0) as paid_amount
       FROM jobs JOIN customers ON customers.id = jobs.customer_id`
    )
    .all();
  return jobs
    .map((j) => {
      const balance_due = Math.round(((j.sold_amount || 0) - j.paid_amount) * 100) / 100;
      const installAppt = db
        .prepare(
          `SELECT * FROM appointments WHERE customer_id = ? AND type = 'Install' AND status = 'scheduled'
           ORDER BY scheduled_at ASC LIMIT 1`
        )
        .get(j.customer_id);
      return {
        job_id: j.id,
        customer_id: j.customer_id,
        customer_name: j.customer_name,
        customer_phone: j.customer_phone,
        status: j.status,
        sold_amount: j.sold_amount,
        paid_amount: j.paid_amount,
        balance_due,
        expected_payment_date: installAppt ? installAppt.scheduled_at : null,
        install_scheduled: !!installAppt,
      };
    })
    .filter((j) => j.balance_due > 0.005)
    .sort((a, b) => {
      // Jobs with a known due date first (soonest first), then unscheduled ones.
      if (a.expected_payment_date && b.expected_payment_date) return a.expected_payment_date.localeCompare(b.expected_payment_date);
      if (a.expected_payment_date) return -1;
      if (b.expected_payment_date) return 1;
      return 0;
    });
}

// Average monthly expense run-rate over the trailing N months (default 3) -
// a rough baseline for projecting near-term outflow, not a guarantee future
// spending matches the past.
function averageMonthlyExpenses(months = 3) {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const total = totalExpensesBetween(startIso, endIso);
  return {
    months,
    start: startIso,
    end: endIso,
    total_expenses: total,
    average_per_month: Math.round((total / months) * 100) / 100,
    by_category: expensesByCategoryBetween(startIso, endIso),
  };
}

// ---- Reports ----
// Profit & Loss for an arbitrary date range (ISO date strings, inclusive).
function profitLoss(start, end) {
  const income = totalIncomeBetween(start, end);
  const expenses = totalExpensesBetween(start, end);
  return {
    start,
    end,
    income,
    expenses,
    net: income - expenses,
    incomeByCategory: incomeByCategoryBetween(start, end),
    expensesByCategory: expensesByCategoryBetween(start, end),
  };
}

// Month-by-month cash flow across a date range, with a running balance.
function cashFlowByMonth(start, end) {
  const rows = db
    .prepare(
      `SELECT month, SUM(amount) as income, 0 as expenses FROM (
         SELECT strftime('%Y-%m', paid_at) as month, amount FROM payments WHERE paid_at BETWEEN ? AND ?
       ) GROUP BY month
       UNION ALL
       SELECT month, 0 as income, SUM(amount) as expenses FROM (
         SELECT strftime('%Y-%m', expense_date) as month, amount FROM expenses WHERE expense_date BETWEEN ? AND ?
       ) GROUP BY month`
    )
    .all(start, end, start, end);

  const byMonth = {};
  for (const r of rows) {
    if (!byMonth[r.month]) byMonth[r.month] = { month: r.month, income: 0, expenses: 0 };
    byMonth[r.month].income += r.income;
    byMonth[r.month].expenses += r.expenses;
  }
  const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  let running = 0;
  for (const m of months) {
    m.net = m.income - m.expenses;
    running += m.net;
    m.runningBalance = running;
  }
  return months;
}

// Annual summary for taxes: income + expenses by category for a calendar year.
function taxYearSummary(year) {
  const start = `${year}-01-01T00:00:00.000Z`;
  const end = `${year}-12-31T23:59:59.999Z`;
  return { year: Number(year), ...profitLoss(start, end) };
}

// ============================================================================
// Phase 2 query layer. Every write that matters for KPI or history also writes
// an activity_log row, so the "who changed what, when, from what, to what"
// requirement holds regardless of whether the change came from a form or the
// assistant. Callers pass an `actor` string ('user' | 'assistant' | 'public').
// ============================================================================

// ---- Activity log ----
function logActivity({ entity_type, entity_id, customer_id, field, old_value, new_value, note, actor }) {
  const id = newId();
  db.prepare(
    `INSERT INTO activity_log (id, entity_type, entity_id, customer_id, field, old_value, new_value, note, actor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    entity_type,
    entity_id,
    customer_id || null,
    field || null,
    old_value === undefined || old_value === null ? null : String(old_value),
    new_value === undefined || new_value === null ? null : String(new_value),
    note || null,
    actor || 'system',
    nowIso()
  );
  return id;
}
function listActivityForCustomer(customer_id, limit = 100) {
  return db
    .prepare(`SELECT * FROM activity_log WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(customer_id, limit);
}
function listRecentActivity(limit = 50) {
  return db
    .prepare(
      `SELECT activity_log.*, customers.name as customer_name
       FROM activity_log LEFT JOIN customers ON customers.id = activity_log.customer_id
       ORDER BY activity_log.created_at DESC LIMIT ?`
    )
    .all(limit);
}

// ---- Customer: sales stage + attention ----
function touchCustomer(id) {
  db.prepare(`UPDATE customers SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
}
function setSalesStage(customer_id, stage, { substatus, actor, note } = {}) {
  const c = getCustomer(customer_id);
  if (!c) return null;
  if (!SALES_STAGES.includes(stage)) throw new Error(`Unknown sales stage: ${stage}`);
  const prev = c.sales_stage || null;
  const prevSub = c.stage_substatus || null;
  const nextSub = substatus === undefined ? c.stage_substatus : substatus || null;
  const firstContact = c.first_contact_at || (stage === 'Bona Fide Lead' ? nowIso() : c.created_at);
  db.prepare(
    `UPDATE customers SET sales_stage = ?, stage_substatus = ?, first_contact_at = COALESCE(first_contact_at, ?), updated_at = ? WHERE id = ?`
  ).run(stage, nextSub, firstContact, nowIso(), customer_id);
  if (prev !== stage) {
    logActivity({
      entity_type: 'customer',
      entity_id: customer_id,
      customer_id,
      field: 'sales_stage',
      old_value: prev,
      new_value: stage,
      note: note || null,
      actor: actor || 'user',
    });
  }
  if ((prevSub || null) !== (nextSub || null)) {
    logActivity({
      entity_type: 'customer',
      entity_id: customer_id,
      customer_id,
      field: 'stage_substatus',
      old_value: prevSub,
      new_value: nextSub,
      actor: actor || 'user',
    });
  }
  return getCustomer(customer_id);
}
function setStageSubstatus(customer_id, substatus, { actor } = {}) {
  const c = getCustomer(customer_id);
  if (!c) return null;
  return setSalesStage(customer_id, c.sales_stage || 'Bona Fide Lead', { substatus, actor });
}
function setCustomerDormant(customer_id, dormant, { actor } = {}) {
  const c = getCustomer(customer_id);
  if (!c) return null;
  const val = dormant ? 1 : 0;
  db.prepare(`UPDATE customers SET dormant = ?, updated_at = ? WHERE id = ?`).run(val, nowIso(), customer_id);
  logActivity({
    entity_type: 'customer',
    entity_id: customer_id,
    customer_id,
    field: 'dormant',
    old_value: c.dormant,
    new_value: val,
    actor: actor || 'user',
  });
  return getCustomer(customer_id);
}
function getCustomerStageHistory(customer_id) {
  return db
    .prepare(
      `SELECT * FROM activity_log WHERE customer_id = ? AND field IN ('sales_stage','stage_substatus','dormant')
       ORDER BY created_at ASC`
    )
    .all(customer_id);
}

// ---- Follow-ups / next actions ----
function createFollowup({ customer_id, kind, title, detail, due_at, created_by }) {
  const id = newId();
  db.prepare(
    `INSERT INTO followups (id, customer_id, kind, title, detail, due_at, status, created_by, created_at)
     VALUES (?,?,?,?,?,?, 'open', ?, ?)`
  ).run(id, customer_id, kind || 'next_action', title, detail || null, due_at || null, created_by || 'user', nowIso());
  logActivity({
    entity_type: 'followup',
    entity_id: id,
    customer_id,
    field: 'created',
    new_value: title,
    note: due_at ? `due ${due_at}` : null,
    actor: created_by || 'user',
  });
  return getFollowup(id);
}
function getFollowup(id) {
  return db.prepare(`SELECT * FROM followups WHERE id = ?`).get(id) || null;
}
function listFollowups(customer_id, { includeClosed } = {}) {
  let sql = `SELECT * FROM followups WHERE customer_id = ?`;
  if (!includeClosed) sql += ` AND status = 'open'`;
  sql += ` ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`;
  return db.prepare(sql).all(customer_id);
}
// All open follow-ups across every customer, soonest/overdue first - the raw
// material for the attention lists on Overview and the customer header.
function listOpenFollowups() {
  return db
    .prepare(
      `SELECT followups.*, customers.name as customer_name, customers.phone as customer_phone
       FROM followups JOIN customers ON customers.id = followups.customer_id
       WHERE followups.status = 'open'
       ORDER BY (followups.due_at IS NULL), followups.due_at ASC`
    )
    .all();
}
// Snooze/reschedule (spec E8) - just moves due_at, doesn't touch status.
function setFollowupDueDate(id, due_at, actor) {
  const f = getFollowup(id);
  if (!f) return null;
  db.prepare(`UPDATE followups SET due_at = ? WHERE id = ?`).run(due_at || null, id);
  logActivity({ entity_type: 'followup', entity_id: id, customer_id: f.customer_id, field: 'due_at', old_value: f.due_at, new_value: due_at || null, actor: actor || 'user' });
  return getFollowup(id);
}
// "Waiting on someone" (spec E8) - a note, not a new status; empty string clears it.
function setFollowupWaiting(id, waiting_on, actor) {
  const f = getFollowup(id);
  if (!f) return null;
  const value = (waiting_on || '').trim() || null;
  db.prepare(`UPDATE followups SET waiting_on = ? WHERE id = ?`).run(value, id);
  logActivity({ entity_type: 'followup', entity_id: id, customer_id: f.customer_id, field: 'waiting_on', old_value: f.waiting_on, new_value: value, actor: actor || 'user' });
  return getFollowup(id);
}
function closeFollowup(id, status, actor) {
  const f = getFollowup(id);
  if (!f) return null;
  db.prepare(`UPDATE followups SET status = ?, completed_at = ?, completed_by = ? WHERE id = ?`).run(
    status,
    nowIso(),
    actor || 'user',
    id
  );
  logActivity({
    entity_type: 'followup',
    entity_id: id,
    customer_id: f.customer_id,
    field: 'status',
    old_value: f.status,
    new_value: status,
    note: f.title,
    actor: actor || 'user',
  });
  return getFollowup(id);
}

// ---- Home Show / event sales consultants (spec 9) ----
function listConsultants({ includeInactive } = {}) {
  const sql = `SELECT * FROM sales_consultants${includeInactive ? '' : ' WHERE active = 1'} ORDER BY name ASC`;
  return db.prepare(sql).all();
}
function getConsultant(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM sales_consultants WHERE id = ?`).get(id) || null;
}
function findConsultantByName(name) {
  if (!name) return null;
  return db.prepare(`SELECT * FROM sales_consultants WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`).get(name) || null;
}
function createConsultant({ name }) {
  const id = newId();
  db.prepare(`INSERT INTO sales_consultants (id, name, active, created_at) VALUES (?,?,1,?)`).run(id, String(name).trim(), nowIso());
  return getConsultant(id);
}
// Find a consultant by name or make one - used by the booking flow / assistant
// so "Andrew at the Home Show" just works without a setup step.
function upsertConsultantByName(name) {
  if (!name || !String(name).trim()) return null;
  return findConsultantByName(name) || createConsultant({ name });
}
function setConsultantActive(id, active) {
  db.prepare(`UPDATE sales_consultants SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  return getConsultant(id);
}
// Attach (or change) the consultant credited with a customer, and cascade to
// their open lead. Logged so the credit history is visible.
function setCustomerConsultant(customer_id, consultant_id, { actor } = {}) {
  const c = getCustomer(customer_id);
  if (!c) return null;
  if ((c.consultant_id || null) === (consultant_id || null)) return c;
  db.prepare(`UPDATE customers SET consultant_id = ?, updated_at = ? WHERE id = ?`).run(consultant_id || null, nowIso(), customer_id);
  db.prepare(`UPDATE leads SET consultant_id = ? WHERE customer_id = ? AND (consultant_id IS NULL OR consultant_id = ?)`)
    .run(consultant_id || null, customer_id, c.consultant_id || null);
  const con = getConsultant(consultant_id);
  logActivity({
    entity_type: 'customer',
    entity_id: customer_id,
    customer_id,
    field: 'sales_consultant',
    old_value: c.consultant_id ? (getConsultant(c.consultant_id) || {}).name || c.consultant_id : null,
    new_value: con ? con.name : null,
    actor: actor || 'user',
  });
  return getCustomer(customer_id);
}

// Per-consultant scoreboard (spec 9). Counts only - no commission math.
//   leads_captured        - customers this consultant is credited with
//   appointments_booked    - design appointments they booked
//   appointments_completed - of those, marked completed  (show rate = completed / booked)
//   jobs_sold / revenue    - jobs for their customers, and the sold contract value
// `start`/`end` are ISO datetimes filtering on when the lead/appt/job was created.
function consultantScoreboard({ start, end } = {}) {
  const inRange = (col) => {
    const parts = [];
    if (start) parts.push(`${col} >= '${start}'`);
    if (end) parts.push(`${col} <= '${end}'`);
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  };
  const consultants = listConsultants({ includeInactive: true });
  return consultants
    .map((con) => {
      const leads_captured = db
        .prepare(`SELECT COUNT(*) n FROM customers WHERE consultant_id = ?${inRange('COALESCE(first_contact_at, created_at)')}`)
        .get(con.id).n;
      const appts = db
        .prepare(`SELECT status FROM appointments WHERE consultant_id = ? AND type != 'Measure'${inRange('created_at')}`)
        .all(con.id);
      const appointments_booked = appts.length;
      const appointments_completed = appts.filter((a) => a.status === 'completed').length;
      const jobRows = db
        .prepare(
          `SELECT jobs.sold_amount FROM jobs JOIN customers ON customers.id = jobs.customer_id
           WHERE customers.consultant_id = ?${inRange('jobs.created_at')}`
        )
        .all(con.id);
      const jobs_sold = jobRows.length;
      const revenue = jobRows.reduce((s, j) => s + (Number(j.sold_amount) || 0), 0);
      return {
        id: con.id,
        name: con.name,
        active: !!con.active,
        leads_captured,
        appointments_booked,
        appointments_completed,
        show_rate: appointments_booked ? appointments_completed / appointments_booked : null,
        jobs_sold,
        revenue,
      };
    })
    .sort((a, b) => b.leads_captured - a.leads_captured || b.appointments_booked - a.appointments_booked);
}

// ---- Marketing sources & campaigns ----
// The marketing source every Home Show booking is attributed to (spec 9).
function homeShowSourceId() {
  const existing = db.prepare(`SELECT id FROM marketing_sources WHERE lower(name) = 'home show' LIMIT 1`).get();
  if (existing) return existing.id;
  const id = newId();
  db.prepare(`INSERT INTO marketing_sources (id, name, notes, active, created_at) VALUES (?,?,?,1,?)`).run(
    id,
    'Home Show',
    'Auto-created for Home Show consultant attribution',
    nowIso()
  );
  return id;
}
function createSource({ name, notes }) {
  const id = newId();
  db.prepare(`INSERT INTO marketing_sources (id, name, notes, active, created_at) VALUES (?,?,?,1,?)`).run(
    id,
    name,
    notes || null,
    nowIso()
  );
  return getSource(id);
}
function getSource(id) {
  return db.prepare(`SELECT * FROM marketing_sources WHERE id = ?`).get(id) || null;
}
function listSources({ includeInactive } = {}) {
  let sql = `SELECT * FROM marketing_sources`;
  if (!includeInactive) sql += ` WHERE active = 1`;
  sql += ` ORDER BY name ASC`;
  return db.prepare(sql).all();
}
function updateSource(id, { name, notes, active }) {
  const s = getSource(id);
  if (!s) return null;
  db.prepare(`UPDATE marketing_sources SET name = ?, notes = ?, active = ? WHERE id = ?`).run(
    name ?? s.name,
    notes ?? s.notes,
    active === undefined ? s.active : active ? 1 : 0,
    id
  );
  return getSource(id);
}
function createCampaign({ source_id, name, tracking_phone, start_date, end_date, cost, status, notes }) {
  const id = newId();
  db.prepare(
    `INSERT INTO marketing_campaigns (id, source_id, name, tracking_phone, start_date, end_date, cost, status, notes, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?)`
  ).run(
    id,
    source_id,
    name,
    tracking_phone || null,
    start_date || null,
    end_date || null,
    cost === undefined || cost === '' ? null : Number(cost),
    status || 'active',
    notes || null,
    nowIso()
  );
  return getCampaign(id);
}
function getCampaign(id) {
  return db
    .prepare(
      `SELECT marketing_campaigns.*, marketing_sources.name as source_name
       FROM marketing_campaigns LEFT JOIN marketing_sources ON marketing_sources.id = marketing_campaigns.source_id
       WHERE marketing_campaigns.id = ?`
    )
    .get(id) || null;
}
function listCampaigns({ includeInactive } = {}) {
  let sql = `SELECT marketing_campaigns.*, marketing_sources.name as source_name
             FROM marketing_campaigns LEFT JOIN marketing_sources ON marketing_sources.id = marketing_campaigns.source_id`;
  if (!includeInactive) sql += ` WHERE marketing_campaigns.active = 1`;
  sql += ` ORDER BY (marketing_campaigns.start_date IS NULL), marketing_campaigns.start_date DESC, marketing_campaigns.name ASC`;
  return db.prepare(sql).all();
}
function updateCampaign(id, fields) {
  const c = getCampaign(id);
  if (!c) return null;
  const merged = {
    source_id: fields.source_id ?? c.source_id,
    name: fields.name ?? c.name,
    tracking_phone: fields.tracking_phone === undefined ? c.tracking_phone : fields.tracking_phone || null,
    start_date: fields.start_date === undefined ? c.start_date : fields.start_date || null,
    end_date: fields.end_date === undefined ? c.end_date : fields.end_date || null,
    cost: fields.cost === undefined ? c.cost : fields.cost === '' ? null : Number(fields.cost),
    status: fields.status ?? c.status,
    notes: fields.notes === undefined ? c.notes : fields.notes || null,
    active: fields.active === undefined ? c.active : fields.active ? 1 : 0,
  };
  db.prepare(
    `UPDATE marketing_campaigns SET source_id=?, name=?, tracking_phone=?, start_date=?, end_date=?, cost=?, status=?, notes=?, active=? WHERE id=?`
  ).run(
    merged.source_id,
    merged.name,
    merged.tracking_phone,
    merged.start_date,
    merged.end_date,
    merged.cost,
    merged.status,
    merged.notes,
    merged.active,
    id
  );
  return getCampaign(id);
}
// Given an inbound number a call arrived on, find the campaign that owns it.
// This is the hook a future answering-AI uses to auto-attribute a lead.
function findCampaignByTrackingPhone(phone) {
  if (!phone) return null;
  return db.prepare(`SELECT * FROM marketing_campaigns WHERE tracking_phone = ? AND active = 1 LIMIT 1`).get(phone) || null;
}

// ---- Customer attribution (append-only history; original is never rewritten) ----
function setCustomerAttribution({ customer_id, source_id, campaign_id, tracking_phone, note, actor }) {
  const id = newId();
  db.prepare(
    `INSERT INTO customer_attribution (id, customer_id, source_id, campaign_id, tracking_phone, note, actor, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, customer_id, source_id || null, campaign_id || null, tracking_phone || null, note || null, actor || 'user', nowIso());
  // Keep the fast-path columns on customers pointing at the CURRENT attribution.
  db.prepare(`UPDATE customers SET source_id = ?, campaign_id = ?, updated_at = ? WHERE id = ?`).run(
    source_id || null,
    campaign_id || null,
    nowIso(),
    customer_id
  );
  logActivity({
    entity_type: 'customer',
    entity_id: customer_id,
    customer_id,
    field: 'attribution',
    new_value: [source_id, campaign_id].filter(Boolean).join(' / ') || tracking_phone || 'set',
    note: note || null,
    actor: actor || 'user',
  });
  return id;
}
function getCustomerAttribution(customer_id) {
  const history = db
    .prepare(
      `SELECT ca.*, s.name as source_name, mc.name as campaign_name
       FROM customer_attribution ca
       LEFT JOIN marketing_sources s ON s.id = ca.source_id
       LEFT JOIN marketing_campaigns mc ON mc.id = ca.campaign_id
       WHERE ca.customer_id = ? ORDER BY ca.created_at ASC`
    )
    .all(customer_id);
  return {
    original: history[0] || null,
    current: history[history.length - 1] || null,
    history,
  };
}

// ---- Chart of Accounts + expense categorization ----
function chartOfAccounts({ type } = {}) {
  let sql = `SELECT * FROM chart_of_accounts WHERE active = 1`;
  const params = [];
  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }
  sql += ` ORDER BY sort_order ASC, name ASC`;
  return db.prepare(sql).all(...params);
}
// Deliberately conservative keyword matcher. Returns an account NAME when a
// merchant/memo pretty clearly implies one, else null => caller stores it as
// "Uncategorized / Needs Review". Never guesses a category it isn't sure of.
const EXPENSE_KEYWORDS = [
  [/lowe'?s|home depot|menards|ace hardware|hardware|screws?|hinges?|drawer slide|blum|rev-?a-?shelf/i, 'Cabinet Hardware'],
  [/lumber|plywood|mdf|baltic birch|wood|stain|paint|primer|sandpaper|glue|finish/i, 'Materials & Supplies'],
  [/gas|fuel|shell|exxon|chevron|bp |wawa|sheetz|sunoco/i, 'Vehicle & Fuel'],
  [/uship|freight|shipping|fedex|ups |usps|postage/i, 'Shipping & Freight'],
  [/insurance|geico|state farm|progressive|hiscox|next insurance/i, 'Insurance'],
  [/facebook|meta|google ads|adwords|yelp|angi|thumbtack|nextdoor|mailer|postcard|printing|vistaprint/i, 'Marketing & Advertising'],
  [/adobe|microsoft|google workspace|quickbooks|dropbox|zoom|godaddy|namecheap|render\.com|twilio|anthropic|openai/i, 'Software & Office'],
  [/accountant|cpa|bookkeep|attorney|lawyer|legal/i, 'Professional Fees (legal/accounting)'],
  [/bank fee|wire fee|stripe|square fee|merchant fee|interest charge/i, 'Bank & Merchant Fees'],
  [/restaurant|cafe|coffee|starbucks|mcdonald|chipotle|lunch|dinner/i, 'Meals'],
  [/dewalt|milwaukee|makita|festool|tool|sawstop|blade|router bit/i, 'Tools & Equipment'],
  [/sub ?contractor|installer|helper|1099|labor/i, 'Subcontractors & Labor'],
];
function suggestExpenseAccount(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [re, name] of EXPENSE_KEYWORDS) if (re.test(t)) return name;
  return null;
}

// ---- Appointments: edit / reschedule / complete ----
function updateAppointment(id, { type, scheduled_at, duration_min, notes }, { actor } = {}) {
  const a = getAppointment(id);
  if (!a) return null;
  const next = {
    type: type ?? a.type,
    scheduled_at: scheduled_at ?? a.scheduled_at,
    duration_min: duration_min === undefined ? a.duration_min : Number(duration_min) || 60,
    notes: notes === undefined ? a.notes : notes || null,
  };
  const rescheduled = next.scheduled_at !== a.scheduled_at;
  db.prepare(
    `UPDATE appointments SET type=?, scheduled_at=?, duration_min=?, notes=?, reminder_sent = CASE WHEN ? THEN 0 ELSE reminder_sent END, updated_at=? WHERE id=?`
  ).run(next.type, next.scheduled_at, next.duration_min, next.notes, rescheduled ? 1 : 0, nowIso(), id);
  logActivity({
    entity_type: 'appointment',
    entity_id: id,
    customer_id: a.customer_id,
    field: rescheduled ? 'rescheduled' : 'edited',
    old_value: rescheduled ? a.scheduled_at : null,
    new_value: rescheduled ? next.scheduled_at : next.type,
    actor: actor || 'user',
  });
  return getAppointment(id);
}
function setAppointmentStatusTracked(id, status, { actor, note } = {}) {
  const a = getAppointment(id);
  if (!a) return null;
  db.prepare(`UPDATE appointments SET status=?, completed_at = CASE WHEN ?='completed' THEN ? ELSE completed_at END, updated_at=? WHERE id=?`)
    .run(status, status, nowIso(), nowIso(), id);
  logActivity({
    entity_type: 'appointment',
    entity_id: id,
    customer_id: a.customer_id,
    field: 'status',
    old_value: a.status,
    new_value: status,
    note: note || null,
    actor: actor || 'user',
  });
  return getAppointment(id);
}
function listAppointmentsForCustomer(customer_id) {
  return db.prepare(`SELECT * FROM appointments WHERE customer_id = ? ORDER BY scheduled_at DESC`).all(customer_id);
}
// A scheduled appointment whose time has passed and that was never
// completed/cancelled/rescheduled - the "missed appointment" attention item.
function listPastUncompletedAppointments() {
  return db
    .prepare(
      `SELECT appointments.*, customers.name as customer_name, customers.phone as customer_phone
       FROM appointments JOIN customers ON customers.id = appointments.customer_id
       WHERE appointments.status = 'scheduled' AND appointments.scheduled_at < datetime('now')
       ORDER BY appointments.scheduled_at DESC`
    )
    .all();
}

// ---- Files: soft delete ----
function softDeleteCustomerFile(id, actor) {
  const f = getCustomerFile(id);
  if (!f) return null;
  db.prepare(`UPDATE customer_files SET deleted_at = ?, deleted_by = ? WHERE id = ?`).run(nowIso(), actor || 'user', id);
  db.prepare(`DELETE FROM file_search WHERE file_id = ?`).run(id); // hide from search while deleted
  logActivity({
    entity_type: 'file',
    entity_id: id,
    customer_id: f.customer_id,
    field: 'deleted',
    new_value: f.original_name,
    actor: actor || 'user',
  });
  return getCustomerFile(id);
}
function restoreCustomerFile(id, actor) {
  const f = getCustomerFile(id);
  if (!f) return null;
  db.prepare(`UPDATE customer_files SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(id);
  syncFileSearch(id);
  logActivity({
    entity_type: 'file',
    entity_id: id,
    customer_id: f.customer_id,
    field: 'restored',
    new_value: f.original_name,
    actor: actor || 'user',
  });
  return getCustomerFile(id);
}
function listDeletedFiles() {
  return db
    .prepare(
      `SELECT customer_files.*, customers.name as customer_name
       FROM customer_files LEFT JOIN customers ON customers.id = customer_files.customer_id
       WHERE customer_files.deleted_at IS NOT NULL ORDER BY customer_files.deleted_at DESC`
    )
    .all();
}

// ---- KPI: primary funnel with DOCUMENTED denominators ----
//
// COHORT: customers whose first_contact_at (fallback created_at) is in
//   [start, end]. Every cohort member is, by definition, a Bona Fide Lead.
//
// "REACHED stage X": the customer's FURTHEST FORWARD forward-funnel stage is at
//   or past X. Furthest forward = max over (current sales_stage, every
//   sales_stage value ever recorded in activity_log for that customer),
//   restricted to the 5 forward stages. "Closed / We Declined Customer" is a
//   terminal disposition, NOT forward progress: a customer we closed still
//   counts toward whatever forward stage they had reached before we closed
//   them (e.g. a closed customer who had a completed design appt counts in
//   design_appointments_completed but not in sales).
//
// REVENUE: payments.paid_at in [start, end] (cash basis). sold_contract_value
//   and jobs_created use jobs.created_at in [start, end]. Revenue is NOT
//   filtered to the cohort - it answers "what came in during this window".
//
// Every conversion rate below is numerator / denominator * 100 and ships its
// own `denominator_label` so the meaning can't drift.
function kpiFunnel({ start, end } = {}) {
  const s = start || '0000-01-01';
  const e = end || '9999-12-31';
  const customers = db
    .prepare(`SELECT * FROM customers WHERE COALESCE(first_contact_at, created_at) BETWEEN ? AND ?`)
    .all(s, e);
  const fwdIdx = (stage) => SALES_FUNNEL.indexOf(stage); // -1 for Closed or unknown
  const historyByCustomer = {};
  if (customers.length) {
    const rows = db
      .prepare(`SELECT customer_id, new_value FROM activity_log WHERE field = 'sales_stage'`)
      .all();
    for (const r of rows) {
      (historyByCustomer[r.customer_id] = historyByCustomer[r.customer_id] || []).push(r.new_value);
    }
  }
  const furthest = (c) => {
    let best = fwdIdx(c.sales_stage);
    for (const v of historyByCustomer[c.id] || []) best = Math.max(best, fwdIdx(v));
    // Closed customers: current stage is Closed (idx -1) but their history may
    // hold the forward stage they'd reached. best already reflects that.
    return best;
  };
  const withStage = customers.map((c) => ({ ...c, _fwd: furthest(c) }));
  const reachedIdx = (i) => withStage.filter((c) => c._fwd >= i).length;

  const bonaFide = customers.length;
  const apptSet = reachedIdx(fwdIdx('Design Appointment Set'));
  const apptDone = reachedIdx(fwdIdx('Design Appointment Completed'));
  const estPresented = reachedIdx(fwdIdx('Estimate Presented'));
  const soldCount = withStage.filter((c) => c.sales_stage === 'Sold').length;
  const closedDeclined = customers.filter((c) => c.sales_stage === 'Closed / We Declined Customer').length;

  const revenueRow = db
    .prepare(`SELECT COALESCE(SUM(amount),0) as total, COUNT(DISTINCT job_id) as jobs FROM payments WHERE paid_at BETWEEN ? AND ?`)
    .get(s, e);
  const soldJobsRow = db
    .prepare(
      `SELECT COUNT(*) as n, COALESCE(SUM(sold_amount),0) as total FROM jobs
       WHERE created_at BETWEEN ? AND ?`
    )
    .get(s, e);

  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  return {
    window: { start: s, end: e },
    counts: {
      bona_fide_leads: bonaFide,
      design_appointments_set: apptSet,
      design_appointments_completed: apptDone,
      estimates_presented: estPresented,
      sales: soldCount,
      closed_we_declined: closedDeclined,
    },
    revenue: {
      collected: revenueRow.total,                 // sum of payments.paid_at in window
      sold_contract_value: soldJobsRow.total,      // sum of jobs.sold_amount created in window
      jobs_created: soldJobsRow.n,
      average_sale: soldJobsRow.n > 0 ? Math.round((soldJobsRow.total / soldJobsRow.n) * 100) / 100 : 0,
    },
    conversion: {
      // Each rate is num / den * 100. Denominator named explicitly.
      lead_to_appointment: { rate: pct(apptSet, bonaFide), numerator: apptSet, denominator: bonaFide, denominator_label: 'bona fide leads in cohort' },
      appointment_to_completed: { rate: pct(apptDone, apptSet), numerator: apptDone, denominator: apptSet, denominator_label: 'design appointments set' },
      completed_to_estimate: { rate: pct(estPresented, apptDone), numerator: estPresented, denominator: apptDone, denominator_label: 'design appointments completed' },
      appointment_to_sale: { rate: pct(soldCount, apptSet), numerator: soldCount, denominator: apptSet, denominator_label: 'design appointments set' },
      estimate_to_sale: { rate: pct(soldCount, estPresented), numerator: soldCount, denominator: estPresented, denominator_label: 'estimates presented' },
      lead_to_sale: { rate: pct(soldCount, bonaFide), numerator: soldCount, denominator: bonaFide, denominator_label: 'bona fide leads in cohort' },
    },
  };
}

// KPI broken out by marketing source/campaign. Cohort = customers whose
// first_contact_at is in the window, grouped by their CURRENT attribution.
function kpiByCampaign({ start, end } = {}) {
  const s = start || '0000-01-01';
  const e = end || '9999-12-31';
  const rows = db
    .prepare(
      `SELECT c.id, c.sales_stage, c.campaign_id, c.source_id,
              s.name as source_name, mc.name as campaign_name, mc.cost as campaign_cost
       FROM customers c
       LEFT JOIN marketing_sources s ON s.id = c.source_id
       LEFT JOIN marketing_campaigns mc ON mc.id = c.campaign_id
       WHERE COALESCE(c.first_contact_at, c.created_at) BETWEEN ? AND ?`
    )
    .all(s, e);
  const idx = (stage) => SALES_STAGES.indexOf(stage);
  const groups = new Map();
  for (const r of rows) {
    const key = r.campaign_id || r.source_id || '_none';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: r.campaign_name ? `${r.source_name || '?'} — ${r.campaign_name}` : r.source_name || 'Unattributed',
        campaign_cost: r.campaign_cost || 0,
        leads: 0,
        appointments: 0,
        sales: 0,
        revenue: 0,
      });
    }
    const g = groups.get(key);
    g.leads += 1;
    if (r.sales_stage && (idx(r.sales_stage) >= idx('Design Appointment Set')) && r.sales_stage !== 'Closed / We Declined Customer') g.appointments += 1;
    if (r.sales_stage === 'Sold') g.sales += 1;
  }
  // Revenue per group: payments in the window for jobs whose customer is in the group.
  for (const g of groups.values()) {
    if (g.key === '_none') continue;
  }
  const revRows = db
    .prepare(
      `SELECT c.campaign_id, c.source_id, COALESCE(SUM(p.amount),0) as revenue
       FROM payments p
       JOIN jobs j ON j.id = p.job_id
       JOIN customers c ON c.id = j.customer_id
       WHERE p.paid_at BETWEEN ? AND ?
       GROUP BY c.campaign_id, c.source_id`
    )
    .all(s, e);
  for (const rr of revRows) {
    const key = rr.campaign_id || rr.source_id || '_none';
    if (groups.has(key)) groups.get(key).revenue += rr.revenue;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    cost_per_lead: g.leads > 0 && g.campaign_cost ? Math.round((g.campaign_cost / g.leads) * 100) / 100 : null,
    cost_per_appointment: g.appointments > 0 && g.campaign_cost ? Math.round((g.campaign_cost / g.appointments) * 100) / 100 : null,
    customer_acquisition_cost: g.sales > 0 && g.campaign_cost ? Math.round((g.campaign_cost / g.sales) * 100) / 100 : null,
    roas: g.campaign_cost > 0 ? Math.round((g.revenue / g.campaign_cost) * 100) / 100 : null,
  }));
}

module.exports = {
  db,
  DATA_DIR,
  LEAD_STAGES,
  OPEN_LEAD_STAGES,
  JOB_STAGES,
  APPT_TYPES,
  INTERNAL_APPT_TYPES,
  SALE_PACKET_FOLLOWUP_TITLE,
  completeSalePacket,
  PRODUCT_STAGES,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  SALES_STAGES,
  SALES_FUNNEL,
  STAGE_SUBSTATUSES,
  // Home Show / event consultants (spec 9)
  listConsultants,
  getConsultant,
  findConsultantByName,
  createConsultant,
  upsertConsultantByName,
  setConsultantActive,
  setCustomerConsultant,
  consultantScoreboard,
  homeShowSourceId,
  // activity log
  logActivity,
  listActivityForCustomer,
  listRecentActivity,
  // sales stage / attention
  setSalesStage,
  setStageSubstatus,
  setCustomerDormant,
  getCustomerStageHistory,
  touchCustomer,
  // follow-ups
  createFollowup,
  getFollowup,
  listFollowups,
  listOpenFollowups,
  closeFollowup,
  setFollowupDueDate,
  setFollowupWaiting,
  // marketing
  createSource,
  getSource,
  listSources,
  updateSource,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  findCampaignByTrackingPhone,
  setCustomerAttribution,
  getCustomerAttribution,
  // bookkeeping capture
  chartOfAccounts,
  suggestExpenseAccount,
  getExpense,
  updateExpense,
  listUncategorizedExpenses,
  findExpenseMatchCandidates,
  // appointments
  updateAppointment,
  setAppointmentStatusTracked,
  listAppointmentsForCustomer,
  listPastUncompletedAppointments,
  // files soft-delete
  softDeleteCustomerFile,
  restoreCustomerFile,
  listDeletedFiles,
  // KPI
  kpiFunnel,
  kpiByCampaign,
  createCustomer,
  getCustomer,
  findCustomerByPhoneOrEmail,
  listCustomers,
  updateCustomer,
  createLead,
  getLead,
  listLeads,
  updateLeadStage,
  updateLead,
  createAppointment,
  getAppointment,
  getAppointmentByToken,
  confirmAppointment,
  listAppointments,
  listAppointmentsBetween,
  markReminderSent,
  updateAppointmentStatus,
  createJob,
  updateJobSoldAmount,
  updateJobEstimatedInstall,
  getJob,
  getJobByToken,
  listJobs,
  updateJobStatus,
  getJobHistory,
  createProduct,
  getProduct,
  listProductsForJob,
  listProductionQueue,
  updateProductStatus,
  updateProduct,
  getProductHistory,
  PRODUCT_OPTION_CATEGORIES,
  listProductOptions,
  listAllProductOptionsGrouped,
  createProductOption,
  deleteProductOption,
  createCustomerFile,
  setFileAssignment,
  listFilesNeedingReview,
  findConfidentCustomerByName,
  decideFileAssignment,
  listCustomerFiles,
  listJobFiles,
  getCustomerFile,
  attachFileToJob,
  setFileExtraction,
  searchFiles,
  listRecentFiles,
  deleteCustomerFile,
  createSalesRep,
  listSalesReps,
  findSalesRepByName,
  createTrainingSession,
  listTrainingSessions,
  logMessage,
  listMessagesForCustomer,
  listRecentMessages,
  listAllMessages,
  getMessage,
  createPayment,
  listPayments,
  totalIncome,
  totalIncomeThisMonth,
  totalIncomeBetween,
  incomeByCategoryBetween,
  createExpense,
  listExpenses,
  totalExpenses,
  totalExpensesThisMonth,
  totalExpensesBetween,
  expensesByCategoryBetween,
  profitLoss,
  cashFlowByMonth,
  taxYearSummary,
  getJobBalance,
  listOutstandingJobBalances,
  averageMonthlyExpenses,
};
