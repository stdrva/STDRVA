# PHASE REPORT — Customer Operations + KPI/Marketing/Bookkeeping capture

_Generated 2026-09-04. Status at time of writing: all implementation done and tested locally; nothing committed, pushed, or deployed._

## COMPLETED

**Sales status model**
- New customer-level stages: `Bona Fide Lead → Design Appointment Set → Design Appointment Completed → Estimate Presented → Sold`, plus terminal `Closed / We Declined Customer`. **No "Lost", no "Inquiry".** Non-purchase ≠ lost — `dormant` flag + attention sub-statuses instead.
- Per-stage attention sub-statuses (Estimate Overdue, Follow-up Due, Reschedule Needed, Waiting on Customer, …) — advisory, do **not** move the KPI stage.
- Legacy `leads` table + funnel still work; the old funnel dropdown now also moves the new customer stage via a documented map. Existing 25 customers backfilled from jobs / appointments / old lead stage (only where `sales_stage` was null).

**Status history** — new `activity_log` table records `entity_type, entity_id, customer_id, field, old_value, new_value, note, actor, created_at` for every stage / sub-status / dormant / attribution / appointment / expense / file change. Actor distinguishes `user:<name>` vs `assistant` vs `system` vs `public`. Prior stage values are never erased (test: `changing stage does NOT erase prior stage history`).

**Follow-ups / reminders foundation** — `followups` table (kind, title, detail, due_at, status open/done/dismissed, created_by, completed_by). Overdue = loud. Surfaced on Overview ("Needs attention") and each customer header. Missed appointments auto-appear as attention items.

**Customer page** — rebuilt with progressive disclosure. Prominent: name/contact (formatted phone, tap-to-call/email/map), stage + sub-status pills, quick actions (Text / Email / Call / Map), Opportunity panel (stage form + next-action), active jobs with balances, attention banner. Collapsed `<details>` sections: Text/Email + history, Appointments, Files, Marketing/attribution, Contact details & notes, History (stage changes + full activity + closed follow-ups).

**Navigation** — consolidated. Primary: Overview · Customers · Pipeline · KPI · Appts · Jobs · Bookkeeping. "More" menu: Production Queue · Marketing · Files · Booking Link/QR · Product Options (hidden, still reachable) · Deleted Files. Funnel → redirects to Pipeline. Production is a single tab (job page still shows its own products — that's detail, not duplication). Bookkeeping kept and extended.

**KPI tab** (`/dashboard/kpi`) — primary funnel counts + all six conversion rates, **each shipping its exact numerator / denominator / denominator-label** so the numbers can't drift. Revenue (collected vs sold contract value, clearly labelled), average sale, jobs created. Per source/campaign table: leads, appts, sales, revenue, cost/lead, cost/appt, CAC, ROAS.

**Marketing** (`/dashboard/marketing`) — `marketing_sources` + `marketing_campaigns` (dedicated `tracking_phone`, spend, dates, status) + **append-only** `customer_attribution` (first/original row preserved forever; re-attribution logs who/when/why). `findCampaignByTrackingPhone()` implemented — the hook a future answering-AI uses to auto-attribute an inbound call. Attribution editable from the customer page and assistant.

**Appointments** — create / **edit / reschedule / cancel / complete**. Reschedule re-arms the reminder. A past `scheduled` appointment becomes an attention item and shows "(missed)". `google_event_id` column reserved; appointments are a standalone table with a clean status lifecycle so Google Calendar can become authoritative later without a rework.

**Texting / Email** — real BOS actions from the customer page and the assistant (`send_customer_message`), through the existing Twilio/Resend pipeline. Delivery status is verified and recorded; UI shows **NOT CONFIGURED** in red and records "recorded, NOT delivered" — never fakes success. Communication history preserved.

**Files** — signature workflow now has a clear **Cancel** (link + button, back-link) and states nothing saves until "Save signed copy". Global rule applied: Cancel/Back on appointment-edit, campaign-edit, expense-edit, sign. Deletion is now **soft** — file hidden + pulled from search, recoverable from **Deleted Files**; permanent purge is a separate explicit, confirmed action that also erases the bytes.

**Phone numbers** — one `formatPhone()` in `util.js`. Every US number displays `(804) 839-7984` — customers list, customer page, appointments, pipeline cards, campaign tracking numbers, search. Storage stays E.164; extensions kept as `;ext=`; international numbers grouped, never mangled. (7 tests.)

**Login / mobile / PWA**
- Cookie session + `/login` page (mobile-first, 16px inputs, big targets). HTTP Basic Auth still works for curl/API. "Keep me signed in" (60-day) vs 14-day.
- `manifest.json`, `theme-color`, `apple-mobile-web-app-*` meta, `apple-mobile-web-app-title` "The BOS", `viewport-fit=cover`.
- Instant inline **boot splash** (dark green, spinner) removed on load — kills the iOS standalone black screen.
- Minimal service worker (`/sw.js`, root scope) for installability + offline notice; caches only the static shell, never pages/data.

**Mobile assistant** — stays open after send; real minimize (collapses to a titled pill) and close (round "AI" launcher reopens); `body` bottom-padding so it never covers content; full-width bottom sheet ≤480px; defaults minimized on phones. File/photo upload, document reading, all existing tools preserved.

**Voice** — mic button on the assistant using the Web Speech API where the browser supports it (progressive enhancement, hidden otherwise). Not a continuous voice platform.

**Bookkeeping capture** — `expenses` gains `merchant, memo, coa_account, payment_account, entry_source, reconciliation_status, receipt_file_id, external_ref, expense_at, needs_review, created_by`. `chart_of_accounts` table seeded (17 accounts). One business rule in `createExpense`: obvious merchant → auto-suggested category; uncertain → `Uncategorized / Needs Review`, **never a guessed category**. New **Needs Review** sub-tab. `external_ref` + `findExpenseMatchCandidates()` are the match-not-duplicate foundation for a future bank import.

**Assistant** — new tools, all confirm-gated where they write, all using the same `db.*` operations as the forms: `set_sales_stage`, `create_followup` / `close_followup` / `list_open_followups`, `reschedule_appointment` / `set_appointment_status`, `send_customer_message`, `capture_expense`, `list_chart_of_accounts`, `list_marketing` / `set_customer_attribution`, `get_kpi_summary`. System prompt updated with the sales model ("no Lost, no Inquiry").

## PARTIALLY COMPLETED

- **Marketing attribution on the public booking page** — data model, dashboard capture, and `findCampaignByTrackingPhone()` are all done; `/book` does **not** yet read `?src=` / `?campaign=` landing-page params or attribute by tracking number. Booking-created customers become Bona Fide Leads with no source. (Left out to avoid destabilising the multi-step booking flow this pass.)
- **Receipt → expense association** — the assistant can read an uploaded receipt and call `capture_expense` with `receipt_file_id`; there is no dashboard "attach this file to expense X" control beyond the edit form's implicit link.
- **`job_status_history`** — the existing per-job status table still has no `actor` column; new job/stage changes elsewhere log to `activity_log` with actor. Not retrofitted.
- **CSRF** — state-changing POSTs rely on `SameSite=Lax` + single-user; no per-form token.

## NOT COMPLETED (deliberately out of scope per instructions)

- Full Google Calendar migration (column reserved, architecture kept open).
- Autonomous Gmail mining / Gmail-as-authoritative-source (email send + record is done; ingestion is not).
- Full bank import / reconciliation / cash-flow forecasting (model is reconciliation-ready).
- Face ID / passkeys.
- Elaborate KPI charts (numbers + tables only, as instructed).

## CONFIGURATION / CREDENTIALS NEEDED

| Var | Effect if unset |
|---|---|
| `DASHBOARD_PASSWORD` | Dashboard is open (dev). Set it → `/login` is enforced. |
| `SESSION_SECRET` | Optional. Session cookie signed from the password instead (changing password logs everyone out). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Texts are recorded, shown as **NOT CONFIGURED**, not delivered. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Emails recorded, **NOT CONFIGURED**, not delivered. |
| `ANTHROPIC_API_KEY` | Assistant replies "not configured". |
| Persistent disk for `data/` | Uploaded + soft-deleted files and the DB must survive redeploys. |

## DATABASE MIGRATIONS (all additive, guarded, run on load; tested against the 25-customer dev DB)

New tables: `activity_log` (+2 indexes), `followups` (+2 indexes), `marketing_sources`, `marketing_campaigns` (+index), `customer_attribution` (+index), `chart_of_accounts` (seeded, 17 rows).
New columns:
- `customers`: `sales_stage, stage_substatus, dormant, updated_at, source_id, campaign_id, first_contact_at`
- `appointments`: `updated_at, completed_at, google_event_id, created_by`
- `expenses`: `merchant, memo, coa_account, payment_account, entry_source, reconciliation_status, receipt_file_id, external_ref, expense_at, needs_review, created_by`
- `customer_files`: `deleted_at, deleted_by`
Data backfill: every customer with `sales_stage IS NULL` gets a stage derived from jobs / appointments / legacy lead stage.

## TEST RESULTS

New suite: `npm test` (`node --test`, zero dependencies, uses a throwaway DB via `BOS_DB_PATH`).

```
tests 28  |  pass 28  |  fail 0
```

Covers: phone format/normalize/round-trip/extensions/international (7), sales-stage transitions + history preservation + "no Lost" + dormant (7), KPI funnel monotonicity + documented denominators + cohort windowing + Closed handling (5), follow-up lifecycle, appointment reschedule/complete, missed-appointment attention, file soft-delete/restore/search, expense auto-categorize vs needs-review, bank-match candidates, attribution append-only, tracking-phone reverse lookup (9).

Manual regression (scripted HTTP): auth redirect → login → cookie → all 18 dashboard pages `200` no `500`; `/login`, `/book`, `/status/:token`, `/sw.js`, `/static/manifest.json` all serve; stage change / follow-up / appointment CRUD / expense capture / marketing / attribution POST flows verified against DB state; `node src/server.js` boots clean; public `/book/request` still creates a customer (Bona Fide Lead, normalized phone, activity logged); `scripts/import-customers.js` still runs on a fresh DB. Fixed one bug found in testing: em-dash in a redirect flash message → 500 (`res.redirect` now ASCII-encodes the `Location`).

## GIT STATUS (at time of writing)

Branch `main` at `7da7331` (unchanged — **nothing committed, nothing pushed, nothing deployed**). Working tree:

```
 M .env.example  CHANGELOG.md  package.json  public/css/style.css
 M src/{auth,db,render,router,server}.js  src/routes/dashboard.js  src/services/assistant.js  src/util.js
 A public/manifest.json  public/sw.js
 A src/routes/auth-routes.js  src/services/session.js
 A tests/{helpers,phone,sales,kpi,operations}.js
21 files, +3771 / −453
```
Version bumped `1.3.0 → 1.4.0`; CHANGELOG entry added. Local dev DB (`data/s2d-crm.sqlite3`) had session test artifacts cleaned back to the 25-customer import state (2 harmless stray `activity_log` rows remain).

## PROPOSED COMMIT MESSAGE

```
Phase 2: Customer Operations + KPI/marketing/bookkeeping capture

Sales model
- Customer-level stages: Bona Fide Lead -> Design Appt Set -> Design Appt
  Completed -> Estimate Presented -> Sold, plus terminal "Closed / We Declined".
  No "Lost", no "Inquiry" - non-purchase stays active (dormant flag / attention
  sub-status). Legacy leads/funnel kept working and mapped onto the new stages;
  existing customers backfilled.
- activity_log table: every stage/status/attribution/appointment/expense/file
  change records field, old, new, timestamp, actor (user vs assistant). Stage
  history is never erased.
- followups table + UI: next action, due date, open/done/dismissed. Overdue is
  loud; Overview and customer header surface what needs action.

Customer page rebuilt with progressive disclosure - prominent contact / stage /
quick actions (Text/Email/Call/Map) / opportunity / jobs; everything else in
collapsible sections.

Navigation consolidated. New KPI and Marketing tabs; Pipeline replaces Funnel;
a More menu holds Production Queue, Files, Booking Link, Product Options
(hidden), Deleted Files. Bookkeeping kept.

KPI (/dashboard/kpi): primary funnel with counts + conversion rates, every rate
shipping its exact numerator/denominator/label. Revenue, average sale, per
source/campaign (cost per lead/appt, CAC, ROAS).

Marketing: sources + campaigns (tracking phone, spend, dates) + append-only
customer_attribution (original preserved). findCampaignByTrackingPhone() ready
for future call attribution.

Appointments: edit/reschedule/cancel/complete; reschedule re-arms the reminder;
a past scheduled appt becomes an attention item. google_event_id reserved.

Texting/Email: real BOS actions from the customer page and the assistant,
through the existing pipeline with verified delivery status. Shows NOT
CONFIGURED and records "not delivered" rather than faking success.

Files: signature workflow gets a clear Cancel; deletion is now soft
(recoverable from Deleted Files; permanent purge is separate + confirmed).

Bookkeeping capture: expenses gain merchant, memo, chart-of-accounts category,
payment account, entry source, reconciliation status, receipt link, and
external_ref for future match-not-duplicate. Obvious merchants auto-categorize;
uncertain ones go to Needs Review, never a guessed category. chart_of_accounts
seeded.

Login/mobile: cookie session + /login page (Basic Auth still works for API);
keep-me-signed-in; PWA manifest, iOS Home Screen metadata, instant boot splash
(no more black launch screen), service worker for installability.

Assistant: new confirm-gated tools (set_sales_stage, create/close_followup,
reschedule/set_appointment_status, send_customer_message, capture_expense,
list_chart_of_accounts, list_marketing/set_customer_attribution,
get_kpi_summary) using the same db operations as the forms. Widget stays open
after send, minimizes/closes with a launcher, no longer covers content, gains
an optional voice-to-text mic.

Phone numbers: one formatPhone() helper - every US number displays as
(804) 839-7984 everywhere; E.164 storage and international/extensions preserved.

Tests: first suite (npm test, node:test, no deps) - phone formatting, sales
history, KPI denominators, follow-up lifecycle, appointment reschedule/complete,
file soft-delete, expense categorization, attribution append-only. 28 tests.

All schema changes additive and guarded; verified against the populated dev DB.
```

## Skipped because an existing implementation already satisfied it

- **"Don't claim a message was sent unless confirmed"** — the SMS/email services already logged verified `sent` / `failed` / `not_configured` status. Built the prominent Text/Email actions, honest UI, activity logging, and assistant tool on top; the core anti-fake-success behavior was already there.
- **Job status history** — `job_status_history` already stored status + timestamp + note per job, so job history was not rebuilt; new stage/attention history goes through the new `activity_log` (which adds the actor field the old table lacks).
- **File storage / upload / job+customer linkage / full-text search** — from the previous phase; preserved untouched apart from adding soft-delete and the signature Cancel.
