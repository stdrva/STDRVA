// Boots the real server (src/server.js) against the test's throwaway DB on a
// random port, so route tests exercise real HTML and real POSTs.
//
// Safety: every messaging / AI credential is forced to an empty string in the
// child's environment. server.js only fills a key from .env when the key is
// absent from process.env, so a developer's real .env can never leak in and a
// test can never send a real text or email.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { tmpDbPath } = require('./helpers');

const BLANK = [
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'ANTHROPIC_API_KEY',
  'DASHBOARD_PASSWORD',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, BOS_DB_PATH: tmpDbPath, PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, ...extraEnv };
  for (const k of BLANK) if (!(k in extraEnv)) env[k] = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000);
    const iv = setInterval(() => {
      if (/listening on port/.test(log)) {
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }
    }, 50);
    child.on('exit', () => {
      clearTimeout(t);
      clearInterval(iv);
      reject(new Error('server exited early:\n' + log));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  // Arrays become repeated fields, exactly like a browser form with several checkboxes ticked.
  const form = (obj) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    return p.toString();
  };
  return {
    base,
    log: () => log,
    get: (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts }),
    post: (p, obj = {}, opts = {}) =>
      fetch(base + p, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form(obj),
        ...opts,
      }),
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

module.exports = { startServer };
