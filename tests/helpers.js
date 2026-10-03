// Every test file requires this FIRST. It points the DB at a fresh throwaway
// file (per test file) before src/db.js is loaded, so tests never touch the
// live database.
// FF-2640-021: the DB sits in its own throwaway folder per test file, so the
// uploads folder next to it (customer last-name folders since FF-2640-021) is
// never shared between test files or runs, and the whole folder is removed on exit.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bos-test-${process.pid}-`));
const tmp = path.join(dir, 'bos.sqlite3');
process.env.BOS_DB_PATH = tmp;
delete process.env.DASHBOARD_PASSWORD;

const db = require('../src/db');

// Windows will not delete an open SQLite file, so close it first.
process.on('exit', () => {
  try {
    db.db.close();
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

module.exports = { tmpDbPath: tmp, db };
