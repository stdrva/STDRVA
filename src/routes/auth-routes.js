// Login / logout. These are the only /dashboard-adjacent routes that are NOT
// behind requireAuth (obviously). A single-user app: one password, an optional
// long-lived "keep me signed in" cookie so the iOS Home Screen app doesn't
// re-prompt on every launch.
const { loginLayout } = require('../render');
const { escapeHtml } = require('../util');
const session = require('../services/session');

function safeNext(n) {
  if (!n || typeof n !== 'string') return '/dashboard';
  if (!n.startsWith('/') || n.startsWith('//')) return '/dashboard';
  return n;
}

function register(router) {
  router.get('/login', (req, res) => {
    // Already signed in (or no password configured at all) -> straight through.
    if (!session.dashboardConfigured() || session.currentUser(req)) {
      res.writeHead(302, { Location: safeNext(req.query.next) });
      return res.end();
    }
    const next = safeNext(req.query.next);
    const err = req.query.err ? `<div class="msg err">${escapeHtml(req.query.err)}</div>` : '';
    res.send(
      loginLayout({
        title: 'Sign in',
        body: `
          <h1>Sign in to The BOS</h1>
          ${err}
          <form method="POST" action="/login">
            <input type="hidden" name="next" value="${escapeHtml(next)}">
            <!-- Password-only auth (spec D1) - this field is not checked server-side,
                 it exists so iOS/browser password managers pair it with the password
                 and offer to save/fill the login, which a lone password field often
                 doesn't trigger. -->
            <label>Username</label>
            <input type="text" name="username" autocomplete="username" value="${escapeHtml(process.env.DASHBOARD_USER || 'admin')}">
            <label>Password</label>
            <input type="password" name="password" autocomplete="current-password" autofocus required>
            <label class="check"><input type="checkbox" name="remember" value="1" checked> Keep me signed in on this device</label>
            <button class="btn" type="submit">Sign in</button>
          </form>
        `,
      })
    );
  });

  router.post('/login', (req, res) => {
    const next = safeNext(req.body.next);
    if (!session.dashboardConfigured()) {
      res.writeHead(302, { Location: next });
      return res.end();
    }
    if (!session.passwordOk(req.body.password)) {
      res.writeHead(302, { Location: `/login?err=${encodeURIComponent('Wrong password')}&next=${encodeURIComponent(next)}` });
      return res.end();
    }
    session.startSession(res, process.env.DASHBOARD_USER || 'admin', { remember: !!req.body.remember });
    res.writeHead(302, { Location: next });
    res.end();
  });

  router.get('/logout', (req, res) => {
    session.endSession(res);
    res.writeHead(302, { Location: '/login' });
    res.end();
  });
  router.post('/logout', (req, res) => {
    session.endSession(res);
    res.writeHead(302, { Location: '/login' });
    res.end();
  });
}

module.exports = { register };
