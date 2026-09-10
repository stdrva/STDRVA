// Load .env if present (tiny hand-rolled loader - no dotenv package needed).
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const http = require('http');
const { Router } = require('./router');
const { requireAuth } = require('./auth');
const dashboardRoutes = require('./routes/dashboard');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth-routes');

const router = new Router();
router.use('/static', path.join(__dirname, '..', 'public'));

// Service worker must be served from the root so its scope can be "/".
router.get('/sw.js', (req, res) => {
  const p = path.join(__dirname, '..', 'public', 'sw.js');
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});

router.get('/', (req, res) => res.redirect('/dashboard'));

authRoutes.register(router);
dashboardRoutes.register(router, requireAuth);
publicRoutes.register(router);

const server = http.createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  const automations = require('./services/automations');
  const base = automations.baseUrl();
  console.log(`\nShelves to Drawers RVA CRM listening on port ${PORT}`);
  console.log(`Public base URL: ${base}`);
  console.log(`Dashboard:    ${base}/dashboard`);
  console.log(`Booking page: ${base}/book\n`);
  if (automations.baseUrlIsLocal() && process.env.NODE_ENV === 'production') {
    console.warn(
      '[config] WARNING: running in production but the public base URL is still localhost. ' +
        'Set BASE_URL (or rely on RENDER_EXTERNAL_URL) so booking links, QR codes, texts and emails ' +
        'point at the real domain.\n'
    );
  }

  require('./services/reminders').start();
});
