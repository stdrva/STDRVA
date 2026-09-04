const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { newId, newToken, nowIso } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 's2d-crm.sqlite3');

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

// ---- Funnel / job stage config ----
const LEAD_STAGES = ['New Lead', 'Contacted', 'Quoted', 'Sold', 'Lost'];
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
const APPT_TYPES = ['Short Design Consultation', 'Long Design Consultation', 'Design Review', 'Repair or Warranty', 'Install'];

// Per-product factory pipeline - separate from JOB_STAGES (the coarse,
// customer-facing status). This is the internal, per-piece tracking that
// feeds the Factory Queue.
const PRODUCT_STAGES = ['Queued for Factory', 'Sent to Factory', 'In Production', 'Ready for Delivery', 'Delivered'];

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
function createCustomer({ name, phone, email, address, notes }) {
  const id = newId();
  db.prepare(
    `INSERT INTO customers (id, name, phone, email, address, notes, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(id, name, phone || null, email || null, address || null, notes || null, nowIso());
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
function updateCustomer(id, { name, phone, email, address, notes }) {
  db.prepare(
    `UPDATE customers SET name=?, phone=?, email=?, address=?, notes=? WHERE id=?`
  ).run(name, phone || null, email || null, address || null, notes || null, id);
  return getCustomer(id);
}

// ---- Leads ----
function createLead({ customer_id, stage, source, estimate_value, notes }) {
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO leads (id, customer_id, stage, source, estimate_value, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, customer_id, stage || 'New Lead', source || null, estimate_value || null, notes || null, ts, ts);
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
function createAppointment({ customer_id, lead_id, type, scheduled_at, duration_min, notes }) {
  const id = newId();
  db.prepare(
    `INSERT INTO appointments (id, customer_id, lead_id, type, scheduled_at, duration_min, status, reminder_sent, notes, created_at)
     VALUES (?,?,?,?,?,?, 'scheduled', 0, ?, ?)`
  ).run(id, customer_id, lead_id || null, type || 'Consultation', scheduled_at, duration_min || 60, notes || null, nowIso());
  return getAppointment(id);
}
function getAppointment(id) {
  return db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
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
  const f = db.prepare(`SELECT id, original_name, note, extracted_text FROM customer_files WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM file_search WHERE file_id = ?`).run(id);
  if (!f) return;
  db.prepare(`INSERT INTO file_search (file_id, original_name, note, extracted_text) VALUES (?,?,?,?)`).run(
    f.id,
    f.original_name || '',
    f.note || '',
    f.extracted_text || ''
  );
}
function createCustomerFile({ customer_id, job_id, stored_name, original_name, mime_type, size, note }) {
  const id = newId();
  db.prepare(
    `INSERT INTO customer_files (id, customer_id, job_id, stored_name, original_name, mime_type, size, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, customer_id, job_id || null, stored_name, original_name, mime_type || null, size || 0, note || null, nowIso());
  syncFileSearch(id);
  return id;
}
function listCustomerFiles(customer_id) {
  return db
    .prepare(
      `SELECT customer_files.*, jobs.status as job_status
       FROM customer_files LEFT JOIN jobs ON jobs.id = customer_files.job_id
       WHERE customer_files.customer_id = ? ORDER BY customer_files.created_at DESC`
    )
    .all(customer_id);
}
function listJobFiles(job_id) {
  return db.prepare(`SELECT * FROM customer_files WHERE job_id = ? ORDER BY created_at DESC`).all(job_id);
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
function logMessage({ customer_id, direction, channel, body, status }) {
  const id = newId();
  db.prepare(
    `INSERT INTO messages (id, customer_id, direction, channel, body, status, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(id, customer_id, direction || 'out', channel || 'sms', body || '', status || 'sent', nowIso());
  return id;
}
function listMessagesForCustomer(customer_id) {
  return db.prepare(`SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at ASC`).all(customer_id);
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
function createPayment({ job_id, customer_id, category, amount, method, note, paid_at }) {
  const id = newId();
  db.prepare(
    `INSERT INTO payments (id, job_id, customer_id, category, amount, method, note, paid_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    job_id || null,
    customer_id || null,
    category || 'Job Revenue',
    amount,
    method || null,
    note || null,
    paid_at || nowIso(),
    nowIso()
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
function createExpense({ job_id, expense_date, category, amount, vendor, method, note }) {
  const id = newId();
  db.prepare(
    `INSERT INTO expenses (id, job_id, expense_date, category, amount, vendor, method, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, job_id || null, expense_date || nowIso(), category || 'Other', amount, vendor || null, method || null, note || null, nowIso());
  return id;
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

module.exports = {
  db,
  DATA_DIR,
  LEAD_STAGES,
  JOB_STAGES,
  APPT_TYPES,
  PRODUCT_STAGES,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
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
  listAppointments,
  listAppointmentsBetween,
  markReminderSent,
  updateAppointmentStatus,
  createJob,
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
  listCustomerFiles,
  listJobFiles,
  getCustomerFile,
  attachFileToJob,
  setFileExtraction,
  searchFiles,
  deleteCustomerFile,
  createSalesRep,
  listSalesReps,
  findSalesRepByName,
  createTrainingSession,
  listTrainingSessions,
  logMessage,
  listMessagesForCustomer,
  listRecentMessages,
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
