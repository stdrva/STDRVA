// One-time cleanup: removes leftover test customers ("Tester Tester", etc.)
// and collapses duplicate "Patrick Harris (test)" entries down to one.
// Keeps the first Patrick Harris created, deletes the rest + their records.
//
// Run once from the repo root on the live instance (Render Shell):
//   node scripts/cleanup-test-customers.js

const db = require('../src/db');

function log(msg) {
  console.log(`[cleanup] ${msg}`);
}

function deleteCustomer(c) {
  db.db.prepare(`DELETE FROM messages WHERE customer_id = ?`).run(c.id);
  db.db.prepare(`DELETE FROM appointments WHERE customer_id = ?`).run(c.id);
  db.db.prepare(`DELETE FROM jobs WHERE customer_id = ?`).run(c.id);
  db.db.prepare(`DELETE FROM leads WHERE customer_id = ?`).run(c.id);
  db.db.prepare(`DELETE FROM customers WHERE id = ?`).run(c.id);
  log(`deleted "${c.name}" (id ${c.id}) and related records`);
}

// 1. Delete anything with "test" in the name, except Patrick Harris.
const testCustomers = db.db
  .prepare(`SELECT id, name FROM customers WHERE name LIKE '%test%' COLLATE NOCASE`)
  .all()
  .filter((c) => !/patrick harris/i.test(c.name));
for (const c of testCustomers) deleteCustomer(c);
if (!testCustomers.length) log('no stray test customers found');

// 2. Collapse duplicate Patrick Harris entries down to one (keep the oldest).
const harrises = db.db
  .prepare(`SELECT id, name FROM customers WHERE name LIKE '%patrick harris%' COLLATE NOCASE ORDER BY id ASC`)
  .all();
if (harrises.length > 1) {
  for (const c of harrises.slice(1)) deleteCustomer(c);
  log(`kept Patrick Harris id ${harrises[0].id}, removed ${harrises.length - 1} duplicate(s)`);
} else {
  log('no duplicate Patrick Harris entries found');
}

log('done');
