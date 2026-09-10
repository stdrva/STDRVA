# Changelog

Version numbers follow semver: MAJOR.MINOR.PATCH. Bump PATCH for fixes, MINOR for a new
feature, MAJOR only for a big breaking change. Changes are tested locally and then deployed
straight to the live site - there's no separate beta/staging deployment, and older entries
below that carry a `-beta.N` suffix predate that decision.

## 1.4.1 (2026-09-10) — Bug-fix wave 1: production URLs + assistant widget

Production URLs (spec 1)
- `baseUrl()` now falls back to Render's auto-injected `RENDER_EXTERNAL_URL` (then
  `PUBLIC_BASE_URL`, then `localhost:PORT`) when `BASE_URL` isn't set — booking links, QR
  codes, status-page links and links inside texts/emails stop showing `localhost:3000` in
  production. Startup logs the real public base URL and warns if it's still local in prod.

Assistant widget
- **File / image upload no longer fails with "Could not reach the assistant" (spec 16).**
  Root cause: `customer_files.customer_id` was `NOT NULL`, so uploading a file from any
  page that isn't a customer record (Overview, KPI, …) threw. The column is now nullable
  (table rebuilt, all data preserved). On top of that: uploads now happen on their own
  fast request and are kept as a reference, so a slow or failed assistant call can't lose
  the attachment; the chat endpoint always returns JSON (never a 500 HTML page or a login
  redirect); a failed send keeps the typed message + attachment and shows **Retry**; large
  files are rejected up front; requests time out cleanly at 120s; the server logs timing
  and the real error.
- **Close (×) and minimize (–) now work (spec 17).** The `hidden` attribute was being
  overridden by the panel's `display:flex`. Reopening restores the conversation, the
  active customer, and any pending attachment.
- **Enter sends, Shift+Enter makes a new line (spec 18).** Send button still works.
- Expired session on an assistant call now says "reload the page to sign back in" instead
  of the generic error (JSON 401 for fetch requests, not an HTML redirect).
- **The assistant can navigate the BOS (spec 19):** `navigate_to_record` — "open Leora
  Copeland's record", "show me her job", "pull up production". Context is preserved.
- A plain lookup ("what's her balance?") no longer yanks the page to that customer —
  only an explicit navigation or a real write moves the screen (spec 20/21).
- Panel is size-capped and starts minimized so the BOS underneath stays usable on a
  laptop (spec 22).
- Any ISO datetime that slips into an assistant reply is rewritten to readable local
  time; the model is also told to never show raw ISO (spec 23).

## 1.4.0 (2026-09-08) — Customer Operations phase

Sales model
- New customer-level sales stage: **Bona Fide Lead → Design Appointment Set → Design
  Appointment Completed → Estimate Presented → Sold**, plus the terminal disposition
  **Closed / We Declined Customer**. No "Lost", no "Inquiry" — a customer who hasn't
  bought is still active (`dormant` flag / attention sub-status). Legacy `leads`/funnel
  kept working and mapped onto the new stages. Existing customers backfilled from jobs /
  appointments / old lead stage.
- Attention sub-statuses per stage (Estimate Overdue, Follow-up Due, Reschedule Needed,
  Waiting on Customer, …) — advisory, never move the KPI stage.
- `activity_log` table: every stage/status/attribution/appointment/expense/file change
  records field, old value, new value, timestamp and actor (user vs assistant). Stage
  history is never erased.
- `followups` table + UI: next action, due date, open/done/dismissed. Overdue items are
  loud; the Overview and each customer header surface what needs action.

Customer page — rebuilt with progressive disclosure. Prominent: name/contact, sales
stage + attention, quick actions (Text / Email / Call / Map), current opportunity,
active jobs. Collapsed: files, appointments, marketing, communications, history, notes.

Navigation — consolidated. New **KPI** and **Marketing** tabs; **Pipeline** replaces
Funnel; a **More** menu holds Production Queue, Files, Booking Link/QR, Product Options
(hidden but reachable), Deleted Files. Bookkeeping kept.

KPI — `/dashboard/kpi`: the primary funnel with counts and conversion rates, every rate
shipping its exact numerator / denominator / denominator-label. Revenue, average sale,
and per source/campaign breakdown (cost per lead / appt, CAC, ROAS).

Marketing — `marketing_sources` + `marketing_campaigns` (dedicated tracking phone, spend,
dates) + append-only `customer_attribution` (original attribution preserved forever).
`findCampaignByTrackingPhone()` is the hook a future answering-AI uses to auto-attribute
an inbound call.

Appointments — edit / reschedule / cancel / complete. Rescheduling re-arms the reminder.
A past scheduled appointment becomes an attention item. `google_event_id` column reserved.

Texting / Email — real BOS actions from the customer page and the assistant, through the
existing SMS/email pipeline with verified delivery status. Clearly shows **NOT CONFIGURED**
and records "recorded, not delivered" rather than faking success.

Files — signature workflow gets a clear Cancel; deletion is now **soft** (recoverable
from Deleted Files; permanent purge is a separate explicit action).

Bookkeeping capture — expenses gain merchant, memo, Chart-of-Accounts category, payment
account, entry source, reconciliation status, receipt file link, and `external_ref` for
future match-not-duplicate bank import. Obvious merchants auto-categorize; uncertain ones
go to **Needs Review** (never a guessed category). `chart_of_accounts` table seeded.

Login / mobile — cookie session + `/login` page (Basic Auth still works for API);
"keep me signed in"; PWA manifest, iOS Home Screen metadata, and an instant boot splash
so the standalone launch never shows a black screen; service worker for installability.

Assistant — new tools: set_sales_stage, create_followup / close_followup /
list_open_followups, reschedule_appointment / set_appointment_status,
send_customer_message, capture_expense, list_chart_of_accounts, list_marketing /
set_customer_attribution, get_kpi_summary. All writes still confirm-gated; all use the
same db operations as the forms. Widget stays open after send, can minimize/close with a
launcher to reopen, no longer covers content, optional voice-to-text mic.

Phone numbers — one `formatPhone()` helper; every US number displays as `(804) 839-7984`
everywhere. Storage stays E.164; extensions and international numbers are not mangled.

Tests — first suite (`npm test`, node:test, no deps): phone formatting, sales-stage
history, KPI denominators, follow-up lifecycle, appointment reschedule/complete, file
soft-delete, expense categorization, marketing attribution append-only. 28 tests.

## 1.3.0 (2026-09-03)
- Added: files can now be attached to a **job**, not just a customer. Every file still
  belongs to a customer; a job tag makes it show on that job's page too. New Files panel on
  the job page (`src/routes/dashboard.js`), a Job selector on the customer upload form, and
  a new **Files** nav item / `/dashboard/files` page that full-text searches every file by
  name, note, and extracted contents (SQLite FTS5, `file_search` table in `src/db.js`).
- Added: the Office Manager Assistant's file-upload button actually works now. An uploaded
  file is stored immediately (kept whether or not the assistant is configured), then images
  and PDFs are sent to Claude for reading, text/CSV files are inlined. New assistant tools:
  `search_files`, `list_files`, `get_file`, `attach_file_to_job`, `save_file_extraction`
  (annotates a file with what was read off it, for later search), plus `create_product` and
  `update_job` (both `confirmed:true`-gated like `log_payment`/`log_expense`). The assistant
  proposes CRM records from a document and waits for Andrew's yes before writing anything.
- Fixed: the assistant upload was doubly broken - the browser cleared the file before
  sending it, and the server read every file (image, PDF) as UTF-8 text. Both fixed.
- Changed: sales-training scaffolding (reps, roleplay/quiz/real-sale logging) is disabled -
  `SALES_TRAINING_ENABLED = false` in `src/services/assistant.js` withholds those tools and
  drops the training section from the system prompt. Tables and code stay in place; it was
  never finished with a UI or used.
- Removed: dead `npm run seed` script (pointed at a file that never existed).
- Fixed: duplicated paragraph in the assistant system prompt.

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
