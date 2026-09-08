// Every test file requires this FIRST. It points the DB at a fresh throwaway
// file (per test file) before src/db.js is loaded, so tests never touch the
// live database.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `bos-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
process.env.BOS_DB_PATH = tmp;
delete process.env.DASHBOARD_PASSWORD;

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmp + suffix);
    } catch {}
  }
});

module.exports = { tmpDbPath: tmp, db: require('../src/db') };
