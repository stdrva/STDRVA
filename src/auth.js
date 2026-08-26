// Minimal HTTP Basic Auth gate for the internal /dashboard routes. Public
// customer-facing routes (/book, /status/:token) never go through this.
function requireAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASSWORD;

  if (!pass) {
    // No password configured - allow through but warn loudly. Fine for local
    // testing, NOT fine for a public deployment. Set DASHBOARD_PASSWORD.
    if (!requireAuth._warned) {
      console.warn(
        '\n[auth] WARNING: DASHBOARD_PASSWORD is not set - the /dashboard is UNPROTECTED. Set it in your .env before deploying publicly.\n'
      );
      requireAuth._warned = true;
    }
    return next();
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (u === user && p === pass) return next();
  }

  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="S2D CRM"', 'Content-Type': 'text/plain' });
  res.end('Authentication required');
}

module.exports = { requireAuth };
