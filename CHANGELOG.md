# Changelog

Version numbers follow semver: MAJOR.MINOR.PATCH. Bump PATCH for fixes, MINOR for a new
feature, MAJOR only for a big breaking change. Changes are tested locally and then deployed
straight to the live site - there's no separate beta/staging deployment, and older entries
below that carry a `-beta.N` suffix predate that decision.

## 1.7.1 (2026-09-19) — Fix: mobile "More" menu didn't open

`.nav-more-menu` switches from `position: absolute` (desktop) to `position: fixed` on mobile to
escape `.topnav-links`' `overflow-x: auto` clipping - but the mobile media query never reset `top`,
so it kept the desktop rule's `top: 100%`. For a `position: fixed` element that means 100% of the
*viewport* height, not "just below the button" - on a 375x812 viewport the menu rendered at y=818,
entirely below the fold. It genuinely opened (`<details open>`) every time; it just wasn't visible.
Verified in a headless Chrome session at a 375x812 viewport via the DevTools protocol (no new
dependency - a throwaway script, not part of the repo): before the fix, clicking the summary set
`open` but the menu's bounding box had `y: 818` (out of the 812px-tall viewport); after, `y: 586`,
fully on-screen, confirmed against a screenshot. Fix: anchor the mobile dropdown to the bottom of the
viewport (`top: auto; bottom: 12px`) instead of trying to compute where a variable-height (two-row
on mobile) topnav ends.

No other changes.

## 1.7.0 (2026-09-18) — Sep 18 update batch (sections A-H)

- **A — `[hidden]` vs `.btn`/`.aw-mic`:** added a global `[hidden] { display: none !important; }` rule
  (`public/css/style.css`). Fixes the discovery wizard's `Back`/`Next`/`Submit` buttons (all `class="btn"`,
  previously stayed visible on every step because `.btn`'s `display: inline-flex` beat the `hidden`
  attribute) and the assistant's mic button (`.aw-mic`, same collision - it was visible even when the
  browser has no Web Speech API support). The four existing per-widget `[hidden]` `!important` overrides
  (`#assistant-widget`, `#assistant-launch`, `#voice-launch`, `#voice-overlay`) are now redundant but left
  in place untouched.

- **B1 — timeouts:** 30s timeout on the Anthropic call (`callClaude`, `assistant.js`), the Twilio SMS
  request (`sms.js`), and nodemailer's `connectionTimeout`/`greetingTimeout`/`socketTimeout`
  (`email.js`), all resolving/erroring cleanly rather than hanging. The 6-round tool loop now also
  shares one 100s overall budget (`CHAT_TURN_BUDGET_MS`) so a slow multi-round turn fails from the
  server with a real message before the browser's 120s abort. B2 (intermittent connection errors):
  no separate change beyond B1, per instruction - its exact cause needs Render-side log correlation
  I can't do from the repo.
- **B3 — scroll bleed:** `.aw-log` gets `overscroll-behavior: contain` so scrolling the assistant log
  no longer bleeds into the page behind it at the ends.
- **B4 — uploads filed to the wrong customer (rewritten):** assistant uploads (`/dashboard/assistant/upload`
  and the legacy multipart fallback in `/dashboard/assistant/chat`) now always save unassigned
  (`customer_id: null`, `assignment_status: 'needs_review'`) - the record open behind the widget is
  never enough to file a upload there on its own. When the accompanying message is sent,
  `db.decideFileAssignment()` resolves it: a customer named in the message always wins (even over
  the on-screen customer) and is filed as `confirmed`; otherwise, if there is an on-screen customer,
  the file becomes an `unconfirmed` suggestion (still `customer_id: null`, `suggested_customer_id`
  set) that the widget shows with Confirm / Undo / Correct; with neither signal it stays
  `needs_review`. New `assignment_status`/`suggested_customer_id` columns on `customer_files`. New
  `move_file_to_customer` assistant tool re-files a file on request. The widget header now shows the
  real on-screen customer name with a one-tap ✕ detach (stops that page from supplying a customer to
  new uploads/messages for the rest of the session). The Files page (`/dashboard/files`) gained a
  "Needs review" panel listing every unresolved file with a Confirm button (for suggestions) and an
  Assign-to-customer picker (for everything, including plain Needs Review).
- **B (upload UX):** a failed upload keeps the original `File` object and offers Retry (previously
  the file was dropped on failure with no way to resend). The error message shown is never the raw
  `error:true` flag from a non-JSON response - always a real sentence. Client and server file-size
  limits both now 20MB (previously 25MB client / 20MB server, so a 20-25MB file failed server-side
  with a confusing "true" message - this is exactly the flag-leak bug just fixed, plus the size
  mismatch that triggered it).
- **B6 — no product lines from the assistant:** `create_product` tool removed entirely (definition,
  case, system-prompt mentions and the "propose product lines from a document" guidance). The
  dashboard's own job-page product form and existing product data are untouched.
- **B7 (VERIFY, no code change):** confirmed in code - `aw-close` sets the widget to `closed`; Enter
  sends unless Shift/Ctrl/Cmd is held (Shift+Enter makes a newline via default textarea behavior);
  `navigate_to_record` sets `navigateTo` and the widget follows it. Not verified on a live device.
- **B8:** left alone, per instruction - unconfirmed reports (name-field escaping, "collapses after
  send", mobile float-over) need a reproduction, not a guess.

- **C1:** removed the "We come to your home..." helper paragraph under the address field.
- **C2 — stale CSS caching only:** available times work correctly on the live layout as of this pass -
  confirmed with Andrew, so `.slot-cards`/`.slot-card` are left exactly as they were (the earlier draft
  of this entry that converted them to a vertical list was reverted). Checked `public/sw.js`: it
  registers ONLY from `dashboardLayout` (the internal dashboard) - `publicLayout` (used by `/book`)
  never registers a service worker at all, so SW staleness was not actually the cause of the original
  `/book` report anyway. Switched `/static/` to network-first regardless (falls back to cache only when
  the network fails), since it's a real bug for the dashboard pages that DO register the SW, where the
  cache name never changes between deploys. If stale `/book` CSS recurs, the next suspect is the
  browser's own HTTP cache on `style.css` (no `Cache-Control`
  header is set in `router.js`'s static file serving) - flagging for later, not changed here.
- **C3 — split address fields:** the single free-text address textarea is now four fields (street,
  city, state, ZIP) with `address-line1` / `address-level2` / `address-level1` / `postal-code`
  autocomplete, recombined server-side in `bookingContact()` into the same `address` string every
  downstream piece (parseAddress, zone check, createBooking, storage) already expects - nothing else
  changed. Google Places autocomplete and the street-only-address lookup/suggestion flow are
  explicitly skipped for this pass, per instruction. The review page's separate "edit your details"
  quick-fix form (a different code path, POSTs straight to `/book/confirm`) was left as a single
  textarea - out of scope for this pass.
- **C5 — section scrolling:** service-type links now navigate to `#step-contact` and the info form
  redirects (via a small JS handler, since native GET-form submission doesn't reliably carry a
  fragment) to `#step-times`; `html { scroll-behavior: smooth }` makes the landing glide rather than
  jump.
- **C6 — discovery wizard:** default submit label changed from "Save these details" to "Finished"
  (Back/Next/Submit visibility on the right step was already fixed by Section A's `[hidden]` fix).
  Each "Next" now fires a background save of progress so far; the server (`/book/discovery`)
  overwrites its own previous discovery text via a `[Discovery]` marker block instead of appending
  another copy each time, while leaving any note written before that block alone. "Skip — I'm all
  set" unchanged.
- **C7 (VERIFY, no code change):** not verified this pass - deferred, flagging for a live-device check.
- **C8:** no action (dead X button is the assistant widget's, covered under Section B).

- **D1:** added a visible username field (prefilled with `DASHBOARD_USER`, `autocomplete="username"`)
  next to the password field on `/login`. Not checked server-side (this is still single-password
  auth) - it exists only so iOS/browser password managers pair it with the password field and offer
  to save/fill the login, which a lone password field often doesn't trigger.
- **D2 (VERIFY, no code change):** confirmed in code - cookie sessions (not Basic Auth) plus the
  existing inline boot splash are both already in place, which is exactly what would fix the iOS
  Home Screen black-screen report. Not verified on a live device.
- **D3:** the Booking Link / QR page (already had per-consultant link + QR generation - it only
  needed to be findable) is promoted out of the "More" menu into a primary, always-visible nav tab,
  renamed "Show Prep and Materials".
- **D4:** "Product Options" removed from the More menu (nav only - the route, its data, and the job
  page's link to it are all untouched).

- **E1:** job note label corrected to "shown to customer" per instruction.
- **E2 / E3:** added Total Due (`sold_amount - paid`) next to Sold amount/Paid so far, and a "Change"
  disclosure with its own small form (`POST /dashboard/jobs/:id/sold-amount`, new `db.updateJobSoldAmount`)
  to edit the sold amount directly - previously only the assistant could change it.
- **E4/E5 superseded - product lines hidden entirely, not just reduced:** mid-section, the plan changed
  from "reduce the factory-order form" to hiding product lines completely until the Excel-sheet
  successor becomes its own app - no adding, no seeing, delete nothing. Investigated first, as asked:
  - **Factory Queue** (`/dashboard/production`) is built entirely from `db.listProductionQueue()`
    (product rows across every job) and has its own independent Add/status-change UI - left fully
    working and reachable (URL only - its nav link isn't in scope here).
  - **Product Options** (`/dashboard/settings/product-options`) - dropdown values used when adding a
    product line. Route, data, and the job page's link to it (already just a link, no longer relevant
    once the job-page form is gone) all left as-is.
  - `/dashboard/products/:id/status` (the per-product status-change POST) is still used by Factory
    Queue's own status dropdown - left working.
  - The assistant's `get_job_detail` tool returned a `products` array - removed from its response, and
    its description updated to say so explicitly. `create_product` was already removed in Section B.
  Removed: the entire "Factory order - products" panel (14-field add form + table) from the job page.
  Untouched/not deleted: `products` table data, `/dashboard/jobs/:id/products` (POST, add - no UI path
  to it anymore, but not disabled), `/dashboard/products/:id/status`, Factory Queue, Product Options.
- **E6 — job creation path:** `/dashboard/jobs` gained "+ Add job" (`GET /dashboard/jobs/new`,
  `POST /dashboard/jobs`, reusing the existing `db.createJob`, which already tolerated no `lead_id`)
  and its "Open" link renamed to "Edit". New assistant tool `create_job` (confirm-gated, like
  log_payment/log_expense).
- **E7:** the customer page now lists every job, completed included (was filtered to `status !==
  'Complete'`; that filter is still used, correctly, for the Overview's "Active jobs" stat count).
- **E8 — Needs attention, real actions:** both the Overview list and the customer page's own
  follow-up list now have Done / Dismiss / Snooze / "waiting on" controls directly on each item,
  regardless of whether the due date was set manually, by the assistant, or by an automatic trigger.
  New `followups.waiting_on` column (a note, not a new status - most of the app filters on
  `status = 'open'`) and `POST /dashboard/followups/:id/snooze` / `/waiting` routes.
- **E9 — Text/Email compose:** added a Subject field (email only, hidden for SMS), honored when set
  (falls back to the old default). Clicking the Email quick-action link now actually selects Email in
  the channel dropdown (previously only scrolled near the form, still defaulting to Text).
- **E10 — tax field:** payments gained a `tax` column and a form field, shown alongside amount/method
  in the job page's payment history.
- **E11 — raw dates:** activity-log `old_value`/`new_value` text is now run through
  `humanizeActivityValue()` (new, `util.js`), which rewrites any ISO timestamp embedded in it to a
  readable US Eastern string - plain non-date text passes through unchanged.
- **E12:** no action - ad funnel on the job page not found in code; the financial-data-mismatch report
  needs a reproduction, not a guess.

- **F1.1 — Gmail's full response:** `email.js`'s `sendRaw()` now captures nodemailer's `info.response`
  (Gmail's raw SMTP acceptance line) and records it on the message (`provider_response` - new column).
  Acceptance by Gmail is not proof of inbox arrival, so this doesn't resolve the AOL question by
  itself - Andrew still needs to check the Gmail inbox by hand for a Mail Delivery Subsystem notice,
  then AOL's spam folder, per the original note. F1.3/F1.4 unchanged (SPF/DKIM dead end, no Sent-folder
  entry both left alone as instructed/expected).
- **F1.2 — plain-text alternative:** every email now also sends a `text` part (`email.htmlToText()`,
  new/exported), derived from the same HTML body, alongside the existing HTML part.
- **F2.1 — store full bodies:** `sendEmail()` was logging the SUBJECT as the message `body` (a real
  bug, not just a gap) - it now logs the actual HTML body, with `subject` in its own new column. Fixes
  every caller at once (dashboard compose, automations, the assistant) since they all log through this
  one function.
- **F2.2 — Messages page:** new `/dashboard/messages` (list, newest first, customer/channel/direction/
  status) and `/dashboard/messages/:id` (full text + provider response), linked from the per-customer
  Communication History table (previously truncated at 120 characters with no way to see more) and
  from a new "Messages" More-menu entry.
- **F2.3 — no-customer messages:** `messages.customer_id` is now nullable (same table-rebuild approach
  as `customer_files` in Section B) so a send-to-anyone message (F3) or a future unmatched inbound one
  (F4, not built) can be stored and listed instead of failing to insert.
- **F3 — send to anyone:** new assistant tool `send_email` - confirm-gated like `send_customer_message`,
  but takes an arbitrary `to` address and an optional `customer_id` (only if the email is actually
  about a specific customer). Logs every send, customer or not. No automatic BCC, per Andrew's standing
  no. Gmail's ~500/day free-account limit is noted in the tool description; I have not independently
  verified that figure against Google's current docs, per the instruction to verify before relying on
  it - flagging as unconfirmed rather than asserting it.
- **F4:** skipped entirely, per instruction.

- **G — automated customer emails/texts (partial scope, per instruction):** built only the
  confirmation email, the Confirm/Change/Cancel links, and the reminder's cabinet-prep line. Reviews/
  referrals, the info-page link, and the product email (G3) are explicitly skipped for this pass.
  - **G1 confirmation** (`onAppointmentBooked`): now says where (the customer's address) and how long
    (`formatDuration(duration_min)`, e.g. "about 90 minutes"), not just service and time. Subject is
    "You're booked: [type], [date and time]"; body invites a reply for changes (replies land in the
    Gmail inbox, unread by the BOS until F4). SMS got the same address addition, kept short, plus the
    business phone number.
  - **G2 private links** (`appointments.public_token`, new column, same pattern as `jobs.public_token`,
    backfilled for existing rows): new `GET /appointment/:token` shows the appointment with Confirm/
    Change/Cancel. **Confirm** (`POST .../confirm`) sets a new `appointments.confirmed` flag only -
    never touches `status`, since most of the app filters on `status = 'scheduled'`. **Change**
    (`GET .../change`) redirects to `/book` prefilled with the customer's name/phone/email/address and
    appointment type - does not itself cancel the original slot. **Cancel** requires an explicit POST
    (a confirmation page renders on GET first) - sets the existing `'canceled'` status (frees the slot
    via the same filtering every other cancel path already relies on - no new status) and notifies
    Andrew via `notifyOwner`.
  - **G2 cabinet-prep line**: added to the reminder email/text ("you do not need to empty your
    cabinets... basic access is fine"), alongside the new appointment link.
  - **G3 (product email):** skipped entirely, per instruction - nothing built.

- **H — startup time-zone log (log-only, per instruction):** the server now logs its actual clock,
  resolved IANA time zone, and `TZ` env var once on startup. No time-zone behavior, appointment data,
  or date/time computation was changed - this only makes the server's actual time zone visible in the
  Render logs so the 9 AM / 5 AM question can be confirmed before anything is touched.

## 1.6.0 (2026-09-18) — Email sending: Resend -> Gmail SMTP

Resend is dropped entirely and replaced with Gmail SMTP, sending from an existing
Gmail account (`shelvestodrawersrva@gmail.com`) via an app password. Low volume
(~20 customers/month, occasional sub-100-person newsletter) is well within Gmail's
sending limits, and this removes a separate paid-service dependency.

- **`src/services/email.js`** rewritten to send via `smtp.gmail.com:587` (STARTTLS)
  using the new `GMAIL_USER` / `GMAIL_APP_PASSWORD` env vars, replacing
  `RESEND_API_KEY` / `EMAIL_FROM`. From-address displays as
  `Shelves to Drawers RVA <shelvestodrawersrva@gmail.com>`.
- **Same contract, zero caller changes**: `sendEmail()` keeps its exact signature
  and return shape; `send_customer_message`, booking confirmations
  (`automations.js`), and the dashboard Email tab all work unmodified. Unset
  credentials still behave exactly like the old NOT CONFIGURED path — the message
  is recorded, marked not delivered, and nothing throws.
- **Dependency exception**: this codebase has otherwise used zero npm packages
  (`"dependencies": {}`) by deliberate choice, hand-rolling Twilio/Resend over raw
  HTTPS instead of pulling in SDKs. Hand-rolling raw SMTP (as opposed to a JSON-over-
  HTTPS API) is materially more error-prone - MIME, auth handshakes, TLS upgrade -
  so this one time we pull in **`nodemailer`** (a free, standard, widely-used
  package) rather than reinvent SMTP by hand. Every other Twilio/Resend/Anthropic
  integration in this app remains raw HTTPS, no SDK.
- Removed everywhere: `RESEND_API_KEY`, `EMAIL_FROM`, all Resend-specific code,
  `.env.example` entries, and every "Resend" mention in `README.md`,
  `docs/phase-2-report.md`, the dashboard's NOT CONFIGURED banner text, and the
  assistant's tool description/result text.
- Tests added (`tests/email.test.js`): successful send (mocked transporter), NOT
  CONFIGURED when env vars are unset, invalid-address short-circuit, and an SMTP
  failure path - all asserting delivery status is recorded and nothing throws.
- Out of scope (unchanged from before): no inbound email reading - replies sit in
  the Gmail inbox and are not pulled into the BOS or matched to customers.

## 1.5.0 (2026-09-10) — Voice Mode for Home Show booking (spec 10-15, 24-25)

A first usable **full conversational Voice Mode** — the same assistant, spoken. Zero new
dependencies (browser Web Speech API).

- **Prominent "🎤 Voice" button** (bottom-left, large, always visible). Opens a full-screen
  voice view: a status line, a state-animated mic orb, a running transcript, and **End**.
- **Continuous two-way:** you speak, it answers **out loud**, then the mic reopens on its
  own — no Send between turns. Talking over the assistant interrupts it (barge-in).
- **Same brain:** every utterance goes to the same `/dashboard/assistant/chat` with
  `mode=voice`, so it shares the exact conversation, customer context, tools and CRM
  actions as the text assistant. Opening or ending Voice never loses the conversation;
  the transcript mirrors into the text widget too.
- **Salesperson → customer handoff (spec 11-13):** a spoken briefing —
  *"this is Andrew at the Home Show, I'm handing the phone to Donna who wants an
  appointment in March, she's way up north so check the ZIPs and book anyway, try for a
  day I'm already up there"* — is understood conversationally. The consultant, lead
  source, customer name, date range, geography note, service-area override and scheduling
  preference are extracted and **stay active for the rest of the call** once the customer
  is on the phone. No manual fields.
- **Location-aware scheduling (spec 14):** `list_available_slots` takes a `near` area and
  prefers days Andrew already has an appointment nearby (same ZIP-3 / town / zone). If
  there's no usable match it falls back to normal openings and says so — no invented
  precision.
- **Verbal confirmation for the write (spec 24):** before booking, the assistant says the
  day, time and address back and only creates the appointment after a spoken (or tapped)
  "yes". `book_design_appointment` runs the **exact same `createBooking()` path** as the
  public form (customer upsert with latest details, Home Show consultant credit, lead,
  appointment, confirmation text/email). Discovery questions come after the booking.
- **Service area never blocks** a voice booking (spec 6) — the address is still recorded
  and Andrew still notified.
- iPhone Safari's Web Speech support is limited (no true continuous mode); Voice Mode
  detects it, still works one turn at a time, and says so. Android/desktop Chrome get the
  full hands-free loop.

New assistant tools: `list_available_slots`, `book_design_appointment` (confirm-gated).

## 1.4.3 (2026-09-10) — Bug-fix wave 3: Home Show consultant attribution (spec 9)

- New `sales_consultants` table; `consultant_id` added to customers, leads and
  appointments (guarded migrations, existing data untouched).
- The booking flow accepts `?consultant=<name>&lead_source=Home%20Show`. The public
  page shows a "Home Show — booking with <name>" banner; the consultant is matched or
  created, credited on the customer (cascading to their lead) and on the appointment,
  and the customer is attributed to a "Home Show" marketing source. An existing
  customer's original consultant is never overwritten by a re-book.
- **Lead-capture credit and appointment-booked credit are counted separately.**
- **Booking Link page:** a "Home Show link" section — pick (or type) a consultant and get
  a pre-tagged booking URL + QR to hand out at the booth.
- **KPI page:** a "Home Show / consultant scoreboard" — per consultant: leads captured,
  appointments booked, appointments completed, show rate, jobs sold, revenue. Counts
  only, no commission math.
- **Assistant:** `set_home_show_consultant` (credit a consultant from a sentence like
  "this lead is Andrew's" — also stamps any appointment already booked this turn) and
  `list_consultants`; `get_kpi_summary` now includes the per-consultant scoreboard.
- Customer page shows the crediting consultant in the attribution section.

## 1.4.2 (2026-09-10) — Bug-fix wave 2: booking flow

The self-serve booking flow was rebuilt around a clear sequence (spec 2-8):

- **Flow order (spec 2):** service → name/phone/email → full address → the times we
  offer → pick one → **review screen** → explicit **Confirm Appointment** → booked →
  optional discovery. It no longer opens with "what day/time works best", and choosing a
  time no longer books anything on its own.
- **Four spread options (spec 3):** after the address is known we show **exactly four**
  openings, spread across different days *and* times of day (not the first four in a row).
  A **"Look for more times"** link pulls the next four without restarting — all the
  contact info is kept.
- **Final confirmation (spec 4):** a review card shows name, full street address, date and
  time in plain language, with one **Confirm Appointment** button. Nothing is written
  until that button. The booked page repeats the date, time and address.
- **Address entry (spec 5):** one field with proper mobile autocomplete
  (`autocomplete="street-address"`, `inputmode` on phone/email); you can paste a whole
  address, including a multi-line block from Contacts / Maps / an email, and it's tidied
  to one line. The service area isn't evaluated until the address has a ZIP or a
  city+state; a street-only address prompts for the rest instead of being rejected.
- **Service area (spec 6):** a booking is **never** auto-rejected for being out of area.
  The address/ZIP is still captured and Andrew is still notified, but the customer books a
  real time like anyone else. The old "leave your info, we'll see" dead-end is gone.
- **Edited details stick (spec 7):** changing your name/phone/email/address on the review
  screen (e.g. "Donna" → "Donna Test") updates the customer record — earlier steps no
  longer overwrite a later edit.
- **Discovery comes after booking (spec 8):** rooms / pets / prior experience / product
  interest / notes are asked on the confirmation page once the appointment is secured, and
  are fully optional.

Old links (`/book/confirm`, `POST /book`, `POST /book/out-of-area`) still work.

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
