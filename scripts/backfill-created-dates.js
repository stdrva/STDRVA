// One-time fix: the import script set every customer's "customer since" date
// to whenever the import ran (Aug 2026), not when they actually first showed
// up in Setmore. This backfills created_at using the earliest real date we
// have for each person from the Setmore Activity Stream log (first consult,
// or profile-created date for brand-new leads that have no consult yet).
//
// Dates without a logged "profile created" event use their first consult
// date as the best available proxy - this is an approximation, not their
// true first-contact date, for anyone whose Setmore profile predates their
// first booked appointment.
//
// Run once from the repo root on the live instance (Render Shell):
//   node scripts/backfill-created-dates.js

const db = require('../src/db');

function log(msg) {
  console.log(`[backfill] ${msg}`);
}

// name (must match a substring of the customer's name in the DB, case-insensitive) -> ISO date
const DATES = {
  'alberta johnson': '2026-05-11',
  'elmore becker': '2026-03-23',
  'erica lucke': '2026-06-25',
  'andy reinhardt': '2026-04-01',
  'leora copeland': '2026-07-27',
  'john walker': '2026-07-27',
  'gwen burrows': '2026-03-18',
  'sally guynn': '2026-05-18',
  'john white': '2026-07-02',
  'seth gibson': '2026-08-14',
  'linda walter': '2026-07-13', // profile created date (no consult logged)
  'pat hutchinson': '2026-08-21',
  'peter suyama': '2026-05-07',
  'matthew mccurdy': '2026-08-17',
  'marc huckabone': '2026-08-27',
  'debra nelson': '2026-08-18',
  'kelly pierce': '2026-08-11', // cancellation date is the latest known activity; booking was made before this
  'vanessa hanshaw': '2026-08-16', // profile created date
  'john huber': '2026-08-16', // profile created date
  'esmeralda maida': '2026-08-15', // profile created date
  'dan heath': '2026-08-15', // profile created date
  // Karen Washington and Keith Larkin: no profile-created date in the log,
  // only their future consult booking - left alone (today's import date
  // isn't obviously wrong for them since they're brand new leads).
};

const customers = db.db.prepare(`SELECT id, name, created_at FROM customers`).all();
let updated = 0;
let skipped = 0;

for (const c of customers) {
  const key = Object.keys(DATES).find((k) => c.name.toLowerCase().includes(k));
  if (!key) {
    skipped++;
    continue;
  }
  const newDate = `${DATES[key]}T12:00:00.000Z`;
  db.db.prepare(`UPDATE customers SET created_at = ? WHERE id = ?`).run(newDate, c.id);
  log(`${c.name}: ${c.created_at} -> ${newDate}`);
  updated++;
}

log(`done. updated ${updated}, left ${skipped} unmatched (test contacts, brand-new leads, or name mismatches).`);
