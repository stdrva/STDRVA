// Auth gate for the internal /dashboard routes. Public customer-facing routes
// (/book, /status/:token, /login) never go through this.
//
// Order of acceptance:
//   1. No DASHBOARD_PASSWORD set  -> allow (local dev only; warns once)
//   2. Valid bos_session cookie   -> allow  (normal browser / iOS Home Screen)
//   3. Valid HTTP Basic Auth      -> allow  (curl / scripts / API)
//   4. otherwise: HTML GET -> 302 /login?next=...   ;  everything else -> 401
const session = require('./services/session');

function wantsHtml(req) {
  const a = req.headers.accept || '';
  return req.method === 'GET' && (a.includes('text/html') || a === '' || a.includes('*/*'));
}

// A fetch()/XHR call (the assistant widget, voice mode, any JSON API hit).
// These must get a machine-readable 401 - never a 302 to /login (whose HTML
// body then blows up r.json()) and never a plain-text body.
function wantsJson(req) {
  const a = req.headers.accept || '';
  return (
    a.includes('application/json') ||
    (req.headers['x-requested-with'] || '').toLowerCase() === 'fetch' ||
    (req.headers['content-type'] || '').includes('application/json')
  );
}

function requireAuth(req, res, next) {
  const pass = process.env.DASHBOARD_PASSWORD;
  const user = process.env.DASHBOARD_USER || 'admin';

  if (!pass) {
    if (!requireAuth._warned) {
      console.warn(
        '\n[auth] WARNING: DASHBOARD_PASSWORD is not set - the /dashboard is UNPROTECTED. Set it in your .env before deploying publicly.\n'
      );
      requireAuth._warned = true;
    }
    req.authUser = 'dev';
    return next();
  }

  const cookieUser = session.currentUser(req);
  if (cookieUser) {
    req.authUser = cookieUser;
    return next();
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (session.safeEqual(u, user) && session.safeEqual(p, pass)) {
      req.authUser = u;
      return next();
    }
  }

  if (wantsJson(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Your session expired. Reload the page to sign back in.', reauth: true }));
  }
  if (wantsHtml(req)) {
    const nextUrl = encodeURIComponent(req.url || '/dashboard');
    res.writeHead(302, { Location: `/login?next=${nextUrl}` });
    return res.end();
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="S2D BOS"', 'Content-Type': 'text/plain' });
  res.end('Authentication required');
}

module.exports = { requireAuth };
