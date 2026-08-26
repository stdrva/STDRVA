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

const router = new Router();
router.use('/static', path.join(__dirname, '..', 'public'));

router.get('/', (req, res) => res.redirect('/dashboard'));

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
  console.log(`\nShelves to Drawers RVA CRM running at http://localhost:${PORT}`);
  console.log(`Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`Booking page: http://localhost:${PORT}/book\n`);

  require('./services/reminders').start();
});
