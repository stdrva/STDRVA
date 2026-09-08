// Cookie session for the single-user dashboard. Replaces the raw HTTP Basic
// Auth prompt (which iOS standalone / Home Screen web-apps handle badly - the
// credential often isn't re-sent, producing the black launch screen). Basic
// Auth still works as a fallback for curl / API use.
//
// The cookie is a signed token, not encrypted - it carries no secret, just
// "this browser authenticated as <user> until <exp>", HMAC'd so it can't be
// forged. Secret precedence: SESSION_SECRET env, else derived from
// DASHBOARD_PASSWORD (so rotating the password invalidates every session),
// else a random per-process value (dev only - sessions won't survive a
// restart, which is fine locally).
const crypto = require('crypto');

const COOKIE_NAME = 'bos_session';
const REMEMBER_DAYS = 60;
const DEFAULT_DAYS = 14;

let _randomSecret = null;
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.DASHBOARD_PASSWORD) return 'pw:' + process.env.DASHBOARD_PASSWORD;
  if (!_randomSecret) _randomSecret = crypto.randomBytes(32).toString('hex');
  return _randomSecret;
}

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// timing-safe string compare
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function issueToken(user, days) {
  const payload = JSON.stringify({ u: user, iat: Date.now(), exp: Date.now() + days * 86400000 });
  const b = Buffer.from(payload).toString('base64url');
  return `${b}.${sign(b)}`;
}

function readToken(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [b, sig] = token.split('.');
  if (!safeEqual(sig, sign(b))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' || process.env.BASE_URL?.startsWith('https://');
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeSec) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  appendHeader(res, 'Set-Cookie', parts.join('; '));
}

function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else if (Array.isArray(prev)) res.setHeader(name, prev.concat(value));
  else res.setHeader(name, [prev, value]);
}

function startSession(res, user, { remember } = {}) {
  const days = remember ? REMEMBER_DAYS : DEFAULT_DAYS;
  setCookie(res, issueToken(user || 'admin', days), days * 86400);
}

function endSession(res) {
  setCookie(res, '', 0);
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const payload = readToken(token);
  return payload ? payload.u || 'admin' : null;
}

// True when a plaintext password matches the configured dashboard password.
function passwordOk(candidate) {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return false;
  return safeEqual(candidate || '', pass);
}

function dashboardConfigured() {
  return !!process.env.DASHBOARD_PASSWORD;
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  startSession,
  endSession,
  currentUser,
  passwordOk,
  dashboardConfigured,
  safeEqual,
};
