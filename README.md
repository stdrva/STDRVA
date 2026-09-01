# Shelves to Drawers RVA - The BOS

A Business Operations System built specifically for your workflow: sales funnel → texting →
self-serve booking (QR code) → sold job production tracker (public link) →
appointment reminders → basic income tracking.

**Zero external dependencies.** No `npm install` needed. It's built entirely
on Node.js core modules (including Node's built-in SQLite), so it runs
anywhere Node 22.5+ is available. This matters because a lot of hosts and
locked-down environments block installing npm packages - this app never
needs to.

## Quick start

```
node src/server.js
```

Then open:
- Dashboard (your internal tool): http://localhost:3000/dashboard
- Booking page (what customers see): http://localhost:3000/book

That's it - no database setup, no build step. Data is stored in
`data/s2d-crm.sqlite3`.

## First things to do

1. Copy `.env.example` to `.env` and set `DASHBOARD_PASSWORD` - without it,
   anyone with the link can open your dashboard. Restart the server after
   editing `.env`.
2. Add a customer or two and try moving a lead across the funnel to "Sold" -
   watch the console log show what texts/emails *would* have been sent.
3. When you're ready to actually send texts and emails, see below.

## How the funnel works

`New Lead → Contacted → Quoted → Sold → Lost`

- Add a lead from the Funnel page (creates the customer too if new) or from
  an existing customer's page. A welcome text/email goes out automatically.
- Drag... well, there's no drag-and-drop, but the dropdown on each card
  moves a lead between stages instantly.
- The moment a lead is marked **Sold**, a Job record is created
  automatically with its own private tracking link, and the customer gets a
  text/email with that link.

## Sold jobs / production tracker

Each job moves through: `Order Confirmed → Measuring Scheduled → Measured →
In Production → Ready for Install → Installing → Complete`

Update the status from the Job page. Check "text/email the customer about
this update" and they'll get notified with their tracking link. The link
(`/status/<token>`) is public but unguessable (uses a long random token, not
a sequential ID) - no login required, so you can drop it straight into a
text or email. Customers see a clean timeline of where their project stands.
Edit the stage list in `src/db.js` (`JOB_STAGES`) if your process differs.
This is the coarse, customer-facing status - see Factory Queue below for the
detailed, internal, per-piece tracking.

## Factory Queue (manufacturing / products)

Each job can hold one or more products/pieces sent out for manufacturing -
each with its own measurements, quantity, deadline, and which
factory/vendor is building it. Add them from the bottom of a Job page.

The **Factory Queue** nav item shows every product across every job in one
list, soonest deadline first, so you can see at a glance what's coming due.
Anything past its deadline and not yet Delivered is flagged in red. Status
updates from either the Job page or the Queue page.

This is separate from the job's own overall status above on purpose: a job
might have three products at different stages (one delivered, two still in
production) while the job itself just reads "In Production" to the
customer. Edit the pipeline in `src/db.js` (`PRODUCT_STAGES`) if your
process differs. It doesn't currently auto-update the job status when all
products are delivered - that's a natural next automation if you want it.

### Product Options (editable dropdowns for factory specs)

Each factory-order line can now carry the real manufacturing spec, not just
a name: cabinet/product type, type code, mount style, rail type, color,
divider, opening width (mm), and unit price - modeled on a real dealer
wholesale order form. These show up as dropdowns on the "Add to factory
order" form (Job page) and as their own columns on both the Job page's
product table and the Factory Queue.

The dropdown choices themselves live in the database, not the code - go to
**Product Options** in the nav to add or remove cabinet types, mount
styles, rail types, colors, and dividers yourself, any time your supplier's
options change. No code change or redeploy needed for that part. Removing
an option here doesn't touch any product that already used it - it just
stops showing up as a future choice.

The "Product / piece name" and free-text "Measurements" fields are still
there and still optional to fill in alongside the structured fields, for
anything that doesn't fit the dropdowns.

## Office Manager Assistant (BETA)

A chat box in the bottom-right corner of every dashboard page. Type a plain-language
instruction and it makes the change directly:

- "Add a lead for Jane Smith, 555-1234, met her at the home show"
- "Update Marc Huckabone's notes - he also wants stain matching on the doors"
- "Schedule an appointment for Jane Smith Friday at 2pm, design consultation"
- "Log a $500 deposit from the Copeland job, paid by check"

It's built on Claude's tool-use API (see `src/services/assistant.js`) - no separate AI
product, just Claude calling a fixed set of functions that map onto the same database
functions the dashboard forms use. It searches for an existing customer before creating
one, asks for clarification if a name matches more than one customer, and always
redirects to the page it changed (or back to Overview) so you can see - and undo by
hand if needed - exactly what it did.

**Setup:** get an API key at console.anthropic.com and set `ANTHROPIC_API_KEY` in `.env`
(or your host's environment variables). Until it's set, the assistant just replies that
it isn't configured - nothing else breaks.

**v1 scope on purpose:** customers, leads, appointments, payments, and expenses - create
and update only, no deletes. That covers everything this app has been used for
conversationally so far. Training-session launch (pre-appointment briefing, post-
appointment recap), voice input, and full accounting-system-level actions are planned
but not built yet.

**This is beta.** Test it on a separate beta deployment with real data before trusting it
against your live site - see Deployment below for the staging/production split. Every
change it makes is a normal database write, so anything wrong is fixable the same way
you'd fix a typo from the regular dashboard forms - find the record, edit it by hand.

## Texting customers (Twilio)

Until you configure this, "texts" just print to the server console/log so
you can see exactly what would have gone out.

1. Create a Twilio account at twilio.com and buy a phone number (~$1.15/mo
   + about a penny per text).
2. From the Twilio console, grab your Account SID and Auth Token.
3. In `.env`, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
   `TWILIO_FROM_NUMBER` (your Twilio number, e.g. `+18045551234`).
4. Restart the server. Texts now actually send.

No `twilio` npm package is used - the app calls Twilio's REST API directly
over HTTPS (see `src/services/sms.js`), so there's nothing to install.

## Emailing customers (Resend)

Same idea - until configured, emails print to the console instead of
sending.

1. Create a free account at resend.com, verify a sending domain (or use
   their test domain while you try it out).
2. Create an API key.
3. In `.env`, set `RESEND_API_KEY` and `EMAIL_FROM` (e.g.
   `Shelves to Drawers RVA <hello@yourdomain.com>`).
4. Restart the server.

Prefer SendGrid, Mailgun, or Postmark instead? They're all a single JSON
HTTPS POST just like Resend - swap the request in
`src/services/email.js` (`sendRaw`).

## Self-serve booking + QR code

Customers go to `/book`, pick a service, a day, and an open time slot - no
account, no phone call. Available times are computed from your business
hours and existing appointments, so double-booking isn't possible.

Go to **Booking Link / QR** in the dashboard to get a printable QR code that
points at `/book`. Print it for your shop counter, add it to invoices, or
text/email it directly.

Configure hours in `.env`:
```
BUSINESS_HOURS_START=9        # 24-hour, e.g. 9 = 9am
BUSINESS_HOURS_END=17         # 17 = 5pm
BUSINESS_DAYS=1,2,3,4,5       # 0=Sun ... 6=Sat (Mon-Fri shown)
SLOT_MINUTES=60               # slot grid spacing
BOOKING_WINDOW_DAYS=14        # how far out customers can book
```
Appointment types and their durations are in `src/routes/public.js`
(`durationForType`) - edit to match your actual services (consult, measure,
install, etc).

### Why not Setmore?

You asked me to pick, so here's the reasoning: Setmore's free tier covers
one calendar/staff member and their booking widget is solid, but wiring it
in means you're dependent on a third-party account, their API limits, and
(if you outgrow the free tier) a monthly fee. The custom booking page here
gives you the same core feature - scan a QR code, pick an open slot, done -
with everything living in one app you fully own, no extra account, no fee.
If down the road you want multiple staff calendars, buffer times, or
payment-at-booking, Setmore (or Calendly/Acuity) starts to make more sense
and I can help wire it in.

## Appointment reminders

A background check runs every 15 minutes (configurable via
`REMINDER_CHECK_INTERVAL_MIN`) looking for appointments starting within the
next 24 hours (`REMINDER_HOURS_BEFORE`) that haven't been reminded yet, and
sends one text/email automatically. This requires the server process to
stay running continuously - see Deployment below.

## Bookkeeping (Finances)

Enough to run real reports, not a full accounting system. Three sub-pages
under **Bookkeeping** in the nav:

- **Overview** - income/expense/net totals for the month and lifetime, plus
  a form to log income that isn't tied to a job (misc sales, etc). Job
  payments are still logged from the job page as before.
- **Expenses** - log a business expense with a category (materials,
  subcontractors, vehicle, insurance, software, etc - see
  `EXPENSE_CATEGORIES` in `src/db.js` to edit the list), optionally
  attached to a job for job-costing.
- **Reports** - three report types, each with a CSV export:
  - **Profit & Loss** - income and expenses for any date range, broken
    down by category.
  - **Cash Flow** - month-by-month income vs. expenses with a running
    balance, so you can see the trend, not just a total.
  - **Tax Summary** - a calendar-year rollup of income and expenses by
    category, sized for handing to an accountant or dropping into tax
    software.

None of this is tax or accounting advice - it's organized, exportable
numbers. Have an accountant review before filing anything. Every report
exports as CSV for QuickBooks, Wave, or whatever you move to.

## Deployment (getting this live on the internet)

Locally this only runs on your machine. To get a real link customers can
text/QR-scan, you need it hosted somewhere that (a) runs Node continuously
and (b) gives you a public URL. A few simple, cheap options:

- **Railway** or **Render**: connect a GitHub repo, they detect Node
  automatically, `npm start` just works (no build step since there are no
  dependencies), free/cheap tier is plenty for a small business's traffic.
- **A small VPS** (DigitalOcean, Linode, etc.): `git clone`, `node
  src/server.js`, use `pm2` or a systemd service to keep it running, put
  Caddy or nginx in front for HTTPS.
- **Fly.io**: similar to Railway/Render, generous free allowance.

Whichever you pick:
1. Set `BASE_URL` in `.env` to your real domain (e.g.
   `https://crm.shelvestodrawersrva.com`) - this is what goes into every
   text/email link and the QR code.
2. Set `DASHBOARD_PASSWORD` before it's reachable publicly.
3. The SQLite database is a single file (`data/s2d-crm.sqlite3`) - back it
   up periodically (most hosts above support a persistent volume/disk; make
   sure `data/` is on one, not ephemeral storage).

I can help with any of these once you pick one - happy to just tell you the
exact steps.

### Beta vs. production (staging workflow)

Once there's a live site, test risky changes (like the Assistant above) on a separate
beta deployment before they touch production:

1. In GitHub, create a `beta` branch (Branches dropdown -> "View all branches" -> "New
   branch") off `main`.
2. Upload the updated files to the `beta` branch instead of `main` (same "Add file ->
   Upload files" flow, just switch the branch dropdown first).
3. On Render, create a second free web service, same "Public Git Repository" setup as
   your main one, but pointed at the `beta` branch. Give it its own name (e.g.
   `s2d-crm-beta`) so it gets its own URL and its own `.env` variables - including its
   own `DASHBOARD_PASSWORD` and a real customer database copy if you want to test
   against real data without touching production's.
4. Test on the beta URL. When it's solid, upload the same files to `main` (production)
   and bump the version in `package.json`/`CHANGELOG.md` from `-beta.N` to the real
   release number - see CHANGELOG.md for the convention.

## Project layout

```
src/
  server.js            entry point
  db.js                SQLite schema + all queries (Node's built-in node:sqlite)
  router.js            tiny hand-rolled HTTP router (no Express needed)
  auth.js              Basic Auth gate for /dashboard
  render.js            HTML page layout wrappers
  util.js              formatting/validation helpers
  routes/
    dashboard.js       your internal CRM (customers, funnel, jobs, finances...)
    public.js          customer-facing pages (booking, job status)
  services/
    sms.js             Twilio REST API over HTTPS
    email.js           Resend REST API over HTTPS
    automations.js     what gets sent when (new lead, sold, status change...)
    reminders.js       background appointment reminder loop
public/css/style.css    the one stylesheet
data/                   SQLite database lives here
```

## Notes / limitations (basic on purpose)

- Single dashboard login (one shared password), not per-user accounts.
- The booking system assumes one "resource" (you/your crew) - it won't
  juggle multiple installers' separate calendars.
- No file/photo attachments on jobs yet.
- Reminders rely on the process staying up; a crash/restart just means the
  next 15-minute check catches up (nothing gets double-sent, since sent
  reminders are marked in the database).

All straightforward to extend - the codebase is small and deliberately
readable, not framework-heavy.
