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
  'Installing',
  'Complete',
];
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
};
