# Changelog

Version numbers follow semver (MAJOR.MINOR.PATCH), with a `-beta.N` suffix for anything
being tested on a beta deployment before it's promoted to the regular/production one.

## 1.2.0-beta.1 (2026-09-01)
- Added: public booking page now requires a customer's name, phone, email, and full home
  address before offering any day/time - these are in-home visits, so the address is
  collected up front instead of not at all.
- Added: three-zone service-area routing (`src/routes/public.js`). Caroline County,
  Spotsylvania County, and Fredericksburg get Wednesday-only slots; the rest of the
  covered area (Richmond metro, Charlottesville/Albemarle, plus 12 additional counties -
  see the zone comments in public.js) gets any business day except Wednesday; anything
  outside that gets no self-serve day/time picker at all.
- Added: "out of area" flow - either request a callback (creates a lead so the contact
  info isn't lost) or "Book anyway" (books a real slot, flagged in the notes). Either way
  Andrew is notified directly via new `notifyOwner`/`onOutOfAreaContact` functions in
  `automations.js` (`OWNER_NOTIFY_PHONE`/`OWNER_NOTIFY_EMAIL` in `.env.example`).
- Changed: job status "Installing" renamed to "Install Scheduled" (`src/db.js`), with an
  automatic migration for any existing jobs/history rows using the old name.
- Added: Office Manager Assistant can now reason about cash flow, not just log
  transactions - new tools for outstanding job balances (accounts receivable, with
  balance-due date inferred from that job's scheduled Install appointment),
  profit & loss, month-by-month cash flow, expense run-rate, and per-job/production-queue
  detail. System prompt rewritten so it combines these for real questions instead of only
  answering single commands.
- Changed: `log_payment` and `log_expense` (Assistant tools) now require an explicit
  `confirmed:true` flag, and the Assistant is instructed to state the exact entry and wait
  for Andrew's confirmation before setting it - enforced in code, not just prompted.

## 1.1.0-beta.1 (2026-08-27)
- Added: Office Manager Assistant - a chat box on every dashboard page. Type a plain-
  language instruction (add a lead, log a payment, update a customer's notes, schedule
  an appointment) and it makes the change via Claude API tool-calling, then redirects to
  the page it changed so you can verify. Requires `ANTHROPIC_API_KEY` (see .env.example).
  No delete operations yet - only create/update. **BETA - test with real data on a
  separate beta deployment before promoting to production.**

## 1.0.0
- Initial CRM: funnel, texting/email, self-serve booking + QR, job status tracking,
  Factory Queue with editable Product Options, appointment reminders, bookkeeping.
