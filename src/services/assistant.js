// Office Manager Assistant - a chat box embedded on every dashboard page.
// Andrew types a plain-language instruction ("add a lead for Jane Smith,
// 555-1234, met her at the home show") and this calls the Claude API with a
// fixed set of tools that map straight onto db.js functions. No SDK - a raw
// HTTPS POST to Anthropic's Messages API, same pattern as sms.js/email.js.
//
// v1 is deliberately narrow: create/update customers, leads, appointments,
// payments, and expenses, plus a lookup tool. No deletes - anything
// destructive stays a manual dashboard action for now.
const https = require('https');
const db = require('../db');
const sms = require('./sms');
const email = require('./email');
const { isValidEmail } = require('../util');
// Shared self-serve / voice booking logic (slot picking, the single createBooking
// path). Required lazily inside the tools to avoid any load-order surprises.
function booking() {
  return require('../routes/public');
}

// Sales-training (reps, roleplay/quiz/real-sale logging) was scaffolded -
// tables, tools, and prompt text - but never finished with a UI and isn't in
// use. Flipped off here: the tools are withheld from the model and the
// training section is dropped from the system prompt. The db tables and the
// runTool cases stay in place so turning this back on is a one-line change.
const SALES_TRAINING_ENABLED = false;

// Anthropic's per-request payload ceiling for base64 file content. Images and
// PDFs larger than this are stored but not sent to the model for analysis.
const MAX_ANALYZE_BYTES = 4.5 * 1024 * 1024;

function assistantConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// ---------- Conversation memory ----------
// Single running conversation, in memory only (resets on server restart/
// redeploy - there's one admin user, so no per-session tracking needed).
// Only the clean user/assistant text turns are kept, not the internal
// tool_use/tool_result blocks - that keeps token growth bounded and avoids
// ever splitting a tool_use from its matching tool_result when trimming.
// Each new message still re-runs whatever lookups it needs via the tools,
// so the underlying data is always fresh even though the conversation
// itself has memory.
let conversationHistory = [];
const MAX_HISTORY_TURNS = 12; // keep last 12 user+assistant exchanges

function resetConversation() {
  conversationHistory = [];
}

// For rendering the chat log in the widget - plain {role, content} text
// turns only (never the internal tool_use/tool_result blocks).
function getHistory() {
  return conversationHistory.map((m) => ({ role: m.role, content: m.content }));
}

// ---------- Tool definitions (JSON Schema, per Anthropic's tool-use format) ----------
const BASE_TOOLS = [
  {
    name: 'find_customers',
    description:
      'Search existing customers by name, phone, or email (partial, case-insensitive match). Always call this first before creating a new customer, to avoid duplicates.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name, phone, or email to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'get_customer_detail',
    description: 'Get full detail on one customer: contact info, their leads, appointments, and jobs.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string' } },
      required: ['customer_id'],
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new customer record.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_customer',
    description: "Update fields on an existing customer. Only pass fields that should change - others are left as-is.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'create_lead',
    description: 'Create a new sales-funnel lead for a customer.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        stage: { type: 'string', enum: ['New Lead', 'Contacted', 'Quoted', 'Sold', 'Lost'] },
        source: { type: 'string', description: 'How they found us, e.g. "Richmond Home Show", "Referral", "Phone call"' },
        estimate_value: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'update_lead',
    description: 'Update a lead: its stage, source, estimate value, or notes.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        stage: { type: 'string', enum: ['New Lead', 'Contacted', 'Quoted', 'Sold', 'Lost'] },
        source: { type: 'string' },
        estimate_value: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'create_appointment',
    description: 'Schedule an appointment for a customer.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        lead_id: { type: 'string' },
        type: { type: 'string', description: 'e.g. "Design Consultation", "Measure", "Install"' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-08-28T13:00:00.000Z (convert local time to UTC)' },
        duration_min: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['customer_id', 'scheduled_at'],
    },
  },
  {
    name: 'update_appointment',
    description: 'Change an appointment\'s status (scheduled, completed, cancelled, etc) or notes.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        status: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'log_payment',
    description:
      'Record income received - a deposit, progress payment, or final payment. This writes to the actual books. Before calling it, state the exact amount, category, method, and date back to Andrew in your reply and wait for him to explicitly confirm it in a later message - only set confirmed:true once he has. Calling this with confirmed:true without a real confirmation from him in the conversation is not allowed.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        customer_id: { type: 'string' },
        category: { type: 'string' },
        amount: { type: 'number' },
        method: { type: 'string', description: 'e.g. check, cash, card' },
        note: { type: 'string' },
        paid_at: { type: 'string', description: 'ISO date, defaults to today if omitted' },
        confirmed: { type: 'boolean', description: 'Only true if Andrew has explicitly confirmed this exact entry in the conversation.' },
      },
      required: ['amount', 'confirmed'],
    },
  },
  {
    name: 'log_expense',
    description:
      'Record a business expense. This writes to the actual books. Before calling it, state the exact amount, category, vendor, and date back to Andrew in your reply and wait for him to explicitly confirm it in a later message - only set confirmed:true once he has. Calling this with confirmed:true without a real confirmation from him in the conversation is not allowed.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        expense_date: { type: 'string', description: 'ISO date, defaults to today if omitted' },
        category: { type: 'string' },
        amount: { type: 'number' },
        vendor: { type: 'string' },
        method: { type: 'string' },
        note: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only true if Andrew has explicitly confirmed this exact entry in the conversation.' },
      },
      required: ['amount', 'category', 'confirmed'],
    },
  },
  {
    name: 'list_job_balances',
    description:
      "List every job that still has money owed on it (sold_amount minus payments collected so far) - the accounts-receivable picture. Each entry includes when that balance is expected: Andrew's rule is the balance is due the day of that job's Install appointment, so a job with one scheduled shows expected_payment_date; a job with no Install scheduled yet shows install_scheduled:false and expected_payment_date:null, meaning the timing is genuinely unknown - don't guess a date for those, say so plainly.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_profit_loss',
    description: 'Income, expenses, and net for a date range, broken down by category. Use ISO date strings.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO date, start of range (inclusive)' },
        end: { type: 'string', description: 'ISO date, end of range (inclusive)' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'get_cash_flow_by_month',
    description: 'Month-by-month income, expenses, net, and running balance across a date range - the actual historical cash flow, not a projection.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO date, start of range' },
        end: { type: 'string', description: 'ISO date, end of range' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'get_expense_run_rate',
    description: 'Average monthly expense total over the trailing N months (default 3), with a category breakdown. A rough baseline for projecting near-term spending - not a guarantee.',
    input_schema: {
      type: 'object',
      properties: { months: { type: 'number', description: 'Trailing months to average over, default 3' } },
    },
  },
  {
    name: 'list_payments',
    description: 'List individual recorded payments, optionally within a date range.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO date, optional' },
        end: { type: 'string', description: 'ISO date, optional' },
      },
    },
  },
  {
    name: 'list_expenses',
    description: 'List individual recorded expenses, optionally within a date range.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO date, optional' },
        end: { type: 'string', description: 'ISO date, optional' },
      },
    },
  },
  {
    name: 'get_job_detail',
    description: 'Full detail on one job: every payment made against it and its remaining balance. Does not include factory-order/product lines - that data exists but is not exposed to the assistant right now.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'list_production_queue',
    description: "The factory/production queue - every product line item not yet delivered, ordered by deadline. Useful alongside cash-flow questions since a job's products still being made is a signal its Install (and balance due) hasn't happened yet.",
    input_schema: {
      type: 'object',
      properties: { includeDelivered: { type: 'boolean' } },
    },
  },
  {
    name: 'get_upcoming_appointment_briefing',
    description:
      "Get the next scheduled appointment plus that customer's full detail (contact info, notes - which include their discovery-wizard answers like rooms, pets, prior experience, product interest). Use this to prep a pre-call briefing.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_files',
    description:
      'Full-text search across every uploaded file - by filename, its note, and any text previously extracted from it (order forms, invoices the assistant has read). Use this to find "the signed order for the Walker job" or "that invoice from the hinge supplier".',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List uploaded files, optionally filtered to one customer or one job.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        job_id: { type: 'string' },
      },
    },
  },
  {
    name: 'get_file',
    description:
      'Get one file: its metadata, the job/customer it belongs to, and anything already extracted from it (extracted_json / extracted_text).',
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  },
  {
    name: 'attach_file_to_job',
    description: 'Tag an existing file to a job so it also shows on that job page. The file still belongs to its customer.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        job_id: { type: 'string' },
      },
      required: ['file_id', 'job_id'],
    },
  },
  {
    name: 'move_file_to_customer',
    description:
      "Re-file a file to the correct customer - e.g. it was uploaded unassigned, or filed under the wrong person. Call find_customers first to resolve customer_id. This corrects a filing mistake, it does not need Andrew's confirmed:true.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        customer_id: { type: 'string' },
      },
      required: ['file_id', 'customer_id'],
    },
  },
  {
    name: 'save_file_extraction',
    description:
      "After reading an uploaded file, record what you found on it so it's searchable later. Pass a compact JSON object of the key fields (products and quantities, unit/total pricing, date sold, promised/due dates, customer name/address, invoice number, etc.) plus a plain-text version. This does NOT create any CRM records - it only annotates the file.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        extracted_json: { type: 'object', description: 'Key fields you read off the document.' },
        extracted_text: { type: 'string', description: 'A plain-text summary of the document contents, for search.' },
      },
      required: ['file_id', 'extracted_text'],
    },
  },
  {
    name: 'create_job',
    description:
      "Create a job directly. Normally a job is created automatically by marking a lead Sold on the dashboard - use this only for the rare case a job needs to exist without that (e.g. Andrew describes a job that was somehow never created). Call find_customers first to resolve customer_id. This writes real data: state the exact customer and sold amount back to Andrew and wait for his explicit confirmation, then call with confirmed:true.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        sold_amount: { type: 'number' },
        notes: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only true once Andrew has explicitly confirmed this exact job.' },
      },
      required: ['customer_id', 'confirmed'],
    },
  },
  {
    name: 'update_job',
    description:
      "Update a job's sold amount and/or its customer-facing status. This writes real data: state the change back to Andrew and wait for his explicit confirmation, then call with confirmed:true. Changing status to a value that notifies the customer is not done here - that stays a manual dashboard action.",
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        sold_amount: { type: 'number' },
        status: {
          type: 'string',
          description: 'One of the job stages, e.g. "Order Confirmed", "Measured", "In Production", "Install Scheduled", "Complete".',
        },
        note: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only true once Andrew has explicitly confirmed this exact change.' },
      },
      required: ['job_id', 'confirmed'],
    },
  },
  {
    name: 'set_sales_stage',
    description:
      "Move a customer's PRIMARY sales stage. Valid stages, in order: 'Bona Fide Lead', 'Design Appointment Set', 'Design Appointment Completed', 'Estimate Presented', 'Sold', 'Closed / We Declined Customer'. There is NO 'Lost' - a customer who simply hasn't bought stays active/dormant. Optionally set an attention sub-status (e.g. 'Estimate Overdue', 'Follow-up Due', 'Waiting on Customer', 'Reschedule Needed') which flags what needs doing without changing the KPI stage. This is a real write - confirm the change with Andrew first, then pass confirmed:true.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        stage: { type: 'string' },
        substatus: { type: 'string', description: 'attention sub-status, or empty string to clear it' },
        dormant: { type: 'boolean', description: 'mark the customer dormant/waiting (still active, not lost)' },
        note: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['customer_id', 'stage', 'confirmed'],
    },
  },
  {
    name: 'create_followup',
    description:
      "Add a next action / follow-up for a customer so it shows up in their attention list and on the Overview. Use for 'send the estimate', 'call back Friday', 'drop off referrals', 'reschedule the missed appointment'. Give a due date/time when there is one.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        title: { type: 'string' },
        detail: { type: 'string' },
        due_at: { type: 'string', description: 'ISO 8601 datetime (convert local Eastern to UTC)' },
        kind: { type: 'string', enum: ['next_action', 'follow_up', 'estimate', 'referrals', 'reschedule', 'custom'] },
      },
      required: ['customer_id', 'title'],
    },
  },
  {
    name: 'list_open_followups',
    description: 'List every open follow-up across all customers, soonest / most overdue first - the attention queue.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'close_followup',
    description: "Mark a follow-up 'done' or 'dismissed'.",
    input_schema: {
      type: 'object',
      properties: { followup_id: { type: 'string' }, status: { type: 'string', enum: ['done', 'dismissed'] } },
      required: ['followup_id', 'status'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: "Change an appointment's date/time (and optionally type/duration/notes). Rescheduling clears the 'reminder sent' flag so a fresh reminder goes out.",
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime' },
        type: { type: 'string' },
        duration_min: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['appointment_id', 'scheduled_at'],
    },
  },
  {
    name: 'set_appointment_status',
    description: "Set an appointment to 'completed', 'canceled', or back to 'scheduled'. Completing a design appointment advances the customer's KPI stage.",
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'string' }, status: { type: 'string', enum: ['completed', 'canceled', 'scheduled'] } },
      required: ['appointment_id', 'status'],
    },
  },
  {
    name: 'send_customer_message',
    description:
      "Send a text or email to a customer THROUGH the BOS (same pipeline the dashboard uses). It is recorded in the communication history with its real delivery status. If Twilio / Gmail aren't configured it is recorded but NOT delivered and you must tell Andrew that plainly - never imply it went out. This is outward-facing: state the exact recipient, channel, and message and get Andrew's explicit yes, then pass confirmed:true.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        channel: { type: 'string', enum: ['sms', 'email'] },
        body: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['customer_id', 'channel', 'body', 'confirmed'],
    },
  },
  {
    name: 'send_email',
    description:
      "Send an email to ANY address - not just the customer on the record (send_customer_message is for that). Use this when Andrew asks to be sent a copy of something, or to email someone who isn't a customer. It is recorded in the communication history the same as any other send (with no customer attached if none applies), and Gmail's daily send limit still applies. Outward-facing: state the exact recipient, subject, and full message and get Andrew's explicit yes, then pass confirmed:true. No automatic BCC to anyone - only send to who was actually asked for.",
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Exact email address' },
        subject: { type: 'string' },
        body: { type: 'string' },
        customer_id: { type: 'string', description: 'Optional - only if this email is actually about/for a specific customer on file' },
        confirmed: { type: 'boolean' },
      },
      required: ['to', 'subject', 'body', 'confirmed'],
    },
  },
  {
    name: 'capture_expense',
    description:
      "Record a business expense from a sentence ('spent $84.27 at Lowe's for cabinet hardware') or an uploaded receipt. Capture amount, merchant, date, memo, and a suggested Chart-of-Accounts category. If the category is reasonably obvious, suggest it and let Andrew confirm/correct; if not, leave coa_account empty and it is saved as Uncategorized / Needs Review - do NOT invent certainty. If a receipt file was uploaded this turn, pass its file_id as receipt_file_id. This writes to the books - state the entry and get Andrew's yes, then confirmed:true.",
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        merchant: { type: 'string' },
        memo: { type: 'string' },
        coa_account: { type: 'string', description: 'exact Chart-of-Accounts name, or omit if uncertain' },
        payment_account: { type: 'string', description: "e.g. 'Business checking', 'Amex'" },
        expense_at: { type: 'string', description: 'ISO datetime, defaults to now' },
        job_id: { type: 'string' },
        receipt_file_id: { type: 'string' },
        entry_source: { type: 'string', enum: ['voice', 'manual', 'upload', 'assistant', 'email'] },
        confirmed: { type: 'boolean' },
      },
      required: ['amount', 'confirmed'],
    },
  },
  {
    name: 'list_chart_of_accounts',
    description: 'List the Chart of Accounts categories (for choosing an expense category).',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['expense', 'income'] } } },
  },
  {
    name: 'list_marketing',
    description: 'List marketing sources and campaigns (id, name, tracking phone, spend).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_customer_attribution',
    description:
      "Attribute (or re-attribute) a customer to a marketing source and/or campaign. Append-only - the customer's ORIGINAL attribution is preserved and never overwritten; this records a new current attribution with the reason. Use when Andrew says e.g. 'she actually came from the Home Show, not Google'.",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        source_id: { type: 'string' },
        campaign_id: { type: 'string' },
        tracking_phone: { type: 'string', description: 'inbound tracking number the lead called, if that is the signal' },
        note: { type: 'string' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_kpi_summary',
    description:
      'The primary funnel KPIs and conversion rates for a date range, plus per-campaign marketing KPIs. Every rate ships its exact numerator/denominator and a denominator label so the numbers are unambiguous.',
    input_schema: {
      type: 'object',
      properties: { start: { type: 'string', description: 'ISO date' }, end: { type: 'string', description: 'ISO date' } },
    },
  },
  {
    name: 'list_available_slots',
    description:
      "Get real open design-appointment times to offer a customer (voice / Home Show booking). Returns up to `count` options SPREAD across different days and times - not just the next few in a row. Pass the customer's `address` so the day options respect Andrew's routing. Pass `near` (usually the same address, or a consultant's note like 'she lives far north') to prefer days Andrew ALREADY has an appointment in that area (spec 14) - if there's no usable match it just returns normal openings and says so. Use `from_date`/`to_date` (YYYY-MM-DD) for a requested window like 'sometime in March'. Offer the customer 4, and if they want others call again with a later `from_date` or higher `count`.",
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "customer's home address" },
        near: { type: 'string', description: 'address / area to bias toward (spec 14 routing)' },
        type: { type: 'string', description: 'appointment type, default Short Design Consultation' },
        from_date: { type: 'string', description: 'YYYY-MM-DD earliest' },
        to_date: { type: 'string', description: 'YYYY-MM-DD latest' },
        count: { type: 'number', description: 'how many options, default 4' },
      },
    },
  },
  {
    name: 'book_design_appointment',
    description:
      "Book a design appointment end to end from the voice / Home Show flow: it creates or updates the customer (latest details win), credits the Home Show consultant if given, opens a funnel lead, creates the appointment, and sends the confirmation - the exact same path as the public booking form. Get all of: full name, phone, a valid email, full street address (incl. city/state/ZIP), and an exact `scheduled_at` the customer picked from list_available_slots. This is a real write and it is outward-facing (it texts/emails the customer): first say the appointment back in plain words ('Tuesday, March 17 at 2 PM at 123 Main Street - should I book it?') and only pass confirmed:true after the customer (or Andrew) says yes out loud or on screen (spec 24). Service area never blocks a booking (spec 6); an out-of-area address just gets flagged.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime from list_available_slots' },
        type: { type: 'string', description: 'default Short Design Consultation' },
        consultant_name: { type: 'string', description: 'Home Show salesperson to credit, if any' },
        lead_source: { type: 'string', description: "e.g. 'Home Show'" },
        confirmed: { type: 'boolean', description: 'true only after a spoken/on-screen yes to this exact time' },
      },
      required: ['name', 'phone', 'email', 'address', 'scheduled_at', 'confirmed'],
    },
  },
  {
    name: 'set_home_show_consultant',
    description:
      "Credit a Home Show / event sales consultant on a customer (spec 9). Sets the customer's lead source to Home Show and attributes the lead - and any appointment already booked in this conversation - to that consultant, so they show on the KPI scoreboard. Pass the consultant's name as spoken ('Andrew', 'Andrew Kerwin'); it's matched or created. Use this when a salesperson says a lead is theirs ('this is Andrew at the Home Show', 'this lead belongs to me').",
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        consultant_name: { type: 'string' },
      },
      required: ['customer_id', 'consultant_name'],
    },
  },
  {
    name: 'list_consultants',
    description: 'List the Home Show / event sales consultants on file (name + id).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate_to_record',
    description:
      "Open a screen inside the BOS for Andrew - this moves the dashboard page he is looking at. Use it when he says 'open Leora Copeland's record', 'show me her job', 'open her appointment', 'pull up production', etc. This is BOS navigation only, not device control. For a person, resolve the customer first with find_customers and pass their customer_id. Types: 'customer' (their record - also where their sales stage / estimate status lives), 'job' (needs the job id), 'appointment' (needs the appointment id - opens its edit screen), 'files' (a customer's files if customer_id given, else the global file list), 'production', 'pipeline', 'kpi', 'appointments' (the calendar/list), 'overview'. After navigating, the conversation and the active customer are preserved.",
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['customer', 'job', 'appointment', 'files', 'production', 'pipeline', 'kpi', 'appointments', 'overview'],
        },
        customer_id: { type: 'string' },
        job_id: { type: 'string' },
        appointment_id: { type: 'string' },
      },
      required: ['type'],
    },
  },
];

// Withheld from the model unless SALES_TRAINING_ENABLED (see top of file).
const SALES_TRAINING_TOOLS = [
  {
    name: 'list_sales_reps',
    description: 'List all sales reps who have a training record.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_sales_rep',
    description: 'Create a new sales rep training record. Call find/list first to avoid duplicates.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'get_training_history',
    description:
      "Get a sales rep's recent training session log (role-plays, quizzes, and real-sale outcomes) to gauge their current strengths and weak spots. There is no separate stored proficiency rating - read the log itself.",
    input_schema: {
      type: 'object',
      properties: { rep_id: { type: 'string' } },
      required: ['rep_id'],
    },
  },
  {
    name: 'log_training_session',
    description:
      'Record a training session for a rep: a role-play, a quiz, or - most important - the real outcome of an actual sales call, logged right after it happens. Be specific in the summary about what worked and what did not.',
    input_schema: {
      type: 'object',
      properties: {
        rep_id: { type: 'string' },
        session_type: { type: 'string', enum: ['roleplay', 'quiz', 'real_sale'] },
        appointment_id: { type: 'string', description: 'If this is tied to a real appointment' },
        summary: { type: 'string', description: 'What happened, what worked, what to improve' },
        techniques: {
          type: 'object',
          description:
            'Map of technique name to a rating: "solid", "needs a little work", or "needs a lot of work". E.g. {"mirroring": "solid", "silence after price": "needs a lot of work"}',
        },
        outcome: { type: 'string', enum: ['won', 'lost', 'pending'], description: 'Only for session_type real_sale' },
      },
      required: ['rep_id', 'session_type', 'summary'],
    },
  },
];

const TOOLS = [...BASE_TOOLS, ...(SALES_TRAINING_ENABLED ? SALES_TRAINING_TOOLS : [])];

// Tools that only read. A result from one of these must never auto-navigate
// Andrew's dashboard page (see the tool loop) - navigation is either an
// explicit navigate_to_record call or the side effect of a real write.
const READ_ONLY_TOOLS = new Set([
  'find_customers',
  'get_customer_detail',
  'list_job_balances',
  'get_profit_loss',
  'get_cash_flow_by_month',
  'get_expense_run_rate',
  'list_payments',
  'list_expenses',
  'get_job_detail',
  'list_production_queue',
  'get_upcoming_appointment_briefing',
  'search_files',
  'list_files',
  'get_file',
  'list_open_followups',
  'list_chart_of_accounts',
  'list_marketing',
  'list_consultants',
  'list_available_slots',
  'get_kpi_summary',
  'list_sales_reps',
  'get_training_history',
]);

// ---------- Tool execution - thin wrappers around db.js ----------
function runTool(name, input) {
  switch (name) {
    case 'find_customers': {
      const q = String(input.query || '').toLowerCase();
      const matches = db
        .listCustomers()
        .filter((c) =>
          [c.name, c.phone, c.email].filter(Boolean).some((f) => f.toLowerCase().includes(q))
        )
        .slice(0, 10);
      return { matches };
    }
    case 'get_customer_detail': {
      const customer = db.getCustomer(input.customer_id);
      if (!customer) return { error: 'Customer not found' };
      const leads = db.listLeads().filter((l) => l.customer_id === input.customer_id);
      const appointments = db.listAppointments({}).filter((a) => a.customer_id === input.customer_id);
      const jobs = db.listJobs().filter((j) => j.customer_id === input.customer_id);
      return { customer, leads, appointments, jobs };
    }
    case 'create_customer': {
      const customer = db.createCustomer(input);
      return { customer };
    }
    case 'update_customer': {
      const existing = db.getCustomer(input.customer_id);
      if (!existing) return { error: 'Customer not found' };
      const customer = db.updateCustomer(input.customer_id, {
        name: input.name ?? existing.name,
        phone: input.phone ?? existing.phone,
        email: input.email ?? existing.email,
        address: input.address ?? existing.address,
        notes: input.notes ?? existing.notes,
      });
      return { ok: true, customer };
    }
    case 'create_lead': {
      const lead = db.createLead(input);
      return { lead };
    }
    case 'update_lead': {
      const existing = db.getLead(input.lead_id);
      if (!existing) return { error: 'Lead not found' };
      if (input.stage && input.stage !== existing.stage) db.updateLeadStage(input.lead_id, input.stage);
      const lead = db.updateLead(input.lead_id, {
        source: input.source ?? existing.source,
        estimate_value: input.estimate_value ?? existing.estimate_value,
        notes: input.notes ?? existing.notes,
      });
      return { ok: true, lead, customer_id: existing.customer_id };
    }
    case 'create_appointment': {
      const appointment = db.createAppointment(input);
      return { appointment };
    }
    case 'update_appointment': {
      const existing = db.getAppointment(input.appointment_id);
      if (!existing) return { error: 'Appointment not found' };
      const appointment = input.status ? db.updateAppointmentStatus(input.appointment_id, input.status) : existing;
      return { ok: true, appointment, customer_id: existing.customer_id };
    }
    case 'log_payment': {
      if (input.confirmed !== true) {
        return { error: 'Not recorded - this needs explicit confirmation from Andrew first. Restate the exact amount, category, method, and date, then wait for him to confirm before calling this again.' };
      }
      const payment_id = db.createPayment({ ...input, paid_at: input.paid_at || new Date().toISOString() });
      return { payment_id, ...input };
    }
    case 'log_expense': {
      if (input.confirmed !== true) {
        return { error: 'Not recorded - this needs explicit confirmation from Andrew first. Restate the exact amount, category, vendor, and date, then wait for him to confirm before calling this again.' };
      }
      const expense_id = db.createExpense({ ...input, expense_date: input.expense_date || new Date().toISOString() });
      return { expense_id, ...input };
    }
    case 'list_job_balances': {
      return { jobs: db.listOutstandingJobBalances() };
    }
    case 'get_profit_loss': {
      return db.profitLoss(input.start, input.end);
    }
    case 'get_cash_flow_by_month': {
      return { months: db.cashFlowByMonth(input.start, input.end) };
    }
    case 'get_expense_run_rate': {
      return db.averageMonthlyExpenses(input.months || 3);
    }
    case 'list_payments': {
      return { payments: db.listPayments({ start: input.start, end: input.end }) };
    }
    case 'list_expenses': {
      return { expenses: db.listExpenses({ start: input.start, end: input.end }) };
    }
    case 'get_job_detail': {
      const job = db.getJob(input.job_id);
      if (!job) return { error: 'Job not found' };
      const payments = db.listPayments({}).filter((p) => p.job_id === input.job_id);
      const balance_due = db.getJobBalance(input.job_id);
      return { job, payments, balance_due };
    }
    case 'list_production_queue': {
      return { queue: db.listProductionQueue({ includeDelivered: input.includeDelivered }) };
    }
    case 'set_sales_stage': {
      if (input.confirmed !== true) {
        return { error: 'Not changed - restate the stage change (and sub-status if any) and wait for Andrew to confirm.' };
      }
      if (!db.SALES_STAGES.includes(input.stage)) {
        return { error: `Unknown stage. Valid: ${db.SALES_STAGES.join(', ')}` };
      }
      const c = db.getCustomer(input.customer_id);
      if (!c) return { error: 'Customer not found' };
      db.setSalesStage(input.customer_id, input.stage, {
        substatus: input.substatus === undefined ? undefined : input.substatus || null,
        actor: 'assistant',
        note: input.note || null,
      });
      if (input.dormant !== undefined) db.setCustomerDormant(input.customer_id, !!input.dormant, { actor: 'assistant' });
      return { ok: true, customer: db.getCustomer(input.customer_id), customer_id: input.customer_id };
    }
    case 'create_followup': {
      const c = db.getCustomer(input.customer_id);
      if (!c) return { error: 'Customer not found' };
      const f = db.createFollowup({
        customer_id: input.customer_id,
        kind: input.kind || 'next_action',
        title: input.title,
        detail: input.detail,
        due_at: input.due_at || null,
        created_by: 'assistant',
      });
      return { ok: true, followup: f, customer_id: input.customer_id };
    }
    case 'list_open_followups': {
      return { followups: db.listOpenFollowups() };
    }
    case 'close_followup': {
      const f = db.getFollowup(input.followup_id);
      if (!f) return { error: 'Follow-up not found' };
      db.closeFollowup(input.followup_id, input.status === 'dismissed' ? 'dismissed' : 'done', 'assistant');
      return { ok: true, customer_id: f.customer_id };
    }
    case 'reschedule_appointment': {
      const a = db.getAppointment(input.appointment_id);
      if (!a) return { error: 'Appointment not found' };
      db.updateAppointment(
        input.appointment_id,
        { scheduled_at: input.scheduled_at, type: input.type, duration_min: input.duration_min, notes: input.notes },
        { actor: 'assistant' }
      );
      return { ok: true, appointment: db.getAppointment(input.appointment_id), customer_id: a.customer_id };
    }
    case 'set_appointment_status': {
      const a = db.getAppointment(input.appointment_id);
      if (!a) return { error: 'Appointment not found' };
      db.setAppointmentStatusTracked(input.appointment_id, input.status, { actor: 'assistant' });
      if (input.status === 'completed' && /design|consultation/i.test(a.type || '')) {
        const c = db.getCustomer(a.customer_id);
        if (c && db.SALES_STAGES.indexOf(c.sales_stage) < db.SALES_STAGES.indexOf('Design Appointment Completed')) {
          db.setSalesStage(a.customer_id, 'Design Appointment Completed', { substatus: 'Estimate Being Prepared', actor: 'assistant', note: 'design appointment completed' });
        }
      }
      return { ok: true, customer_id: a.customer_id };
    }
    case 'send_customer_message': {
      if (input.confirmed !== true) {
        return { error: 'Not sent - restate the recipient, channel, and exact message, and wait for Andrew to confirm.' };
      }
      const c = db.getCustomer(input.customer_id);
      if (!c) return { error: 'Customer not found' };
      // handled async in the loop below via a marker; do it inline synchronously is not possible,
      // so we perform it here through a promise the caller awaits. runTool is sync, so queue it.
      return { __async_send: { customer: c, channel: input.channel, body: input.body } };
    }
    case 'send_email': {
      if (input.confirmed !== true) {
        return { error: 'Not sent - restate the exact recipient, subject, and message, and wait for Andrew to confirm.' };
      }
      if (!isValidEmail(input.to)) return { error: 'Not a valid email address' };
      let customer = null;
      if (input.customer_id) {
        customer = db.getCustomer(input.customer_id);
        if (!customer) return { error: 'Customer not found' };
      }
      return { __async_email: { to: input.to, subject: input.subject, body: input.body, customer_id: customer ? customer.id : null } };
    }
    case 'capture_expense': {
      if (input.confirmed !== true) {
        return { error: 'Not recorded - restate the amount, merchant, date, and category, and wait for Andrew to confirm.' };
      }
      const id = db.createExpense({
        amount: Number(input.amount),
        merchant: input.merchant,
        memo: input.memo,
        coa_account: input.coa_account || null, // createExpense auto-suggests when blank
        payment_account: input.payment_account,
        job_id: input.job_id || null,
        receipt_file_id: input.receipt_file_id || null,
        entry_source: input.entry_source || 'assistant',
        expense_at: input.expense_at || undefined,
        created_by: 'assistant',
      });
      const saved = db.getExpense(id);
      return { ok: true, expense_id: id, coa_account: saved.coa_account, needs_review: saved.needs_review };
    }
    case 'list_chart_of_accounts': {
      return { accounts: db.chartOfAccounts({ type: input.type }) };
    }
    case 'list_marketing': {
      return { sources: db.listSources(), campaigns: db.listCampaigns() };
    }
    case 'set_customer_attribution': {
      const c = db.getCustomer(input.customer_id);
      if (!c) return { error: 'Customer not found' };
      db.setCustomerAttribution({
        customer_id: input.customer_id,
        source_id: input.source_id || null,
        campaign_id: input.campaign_id || null,
        tracking_phone: input.tracking_phone || null,
        note: input.note || null,
        actor: 'assistant',
      });
      return { ok: true, attribution: db.getCustomerAttribution(input.customer_id), customer_id: input.customer_id };
    }
    case 'get_kpi_summary': {
      const start = input.start ? `${input.start}T00:00:00.000Z` : undefined;
      const end = input.end ? `${input.end}T23:59:59.999Z` : undefined;
      return {
        funnel: db.kpiFunnel({ start, end }),
        by_campaign: db.kpiByCampaign({ start, end }),
        by_consultant: db.consultantScoreboard({ start, end }),
      };
    }
    case 'list_available_slots': {
      const r = booking().voiceBookingSlots({
        address: input.address,
        near: input.near,
        type: input.type,
        count: input.count || 4,
        fromDate: input.from_date,
        toDate: input.to_date,
      });
      return r;
    }
    case 'book_design_appointment': {
      if (input.confirmed !== true) {
        return { error: 'Not booked - say the date, time and address back to the customer and wait for a spoken or on-screen "yes" to this exact time, then call again with confirmed:true.' };
      }
      // createBooking is async; runTool is sync, so hand it back as a marker
      // the loop awaits (same pattern as send_customer_message).
      return { __async_booking: { input } };
    }
    case 'set_home_show_consultant': {
      const c = db.getCustomer(input.customer_id);
      if (!c) return { error: 'Customer not found' };
      const con = db.upsertConsultantByName(input.consultant_name);
      if (!con) return { error: 'Need a consultant name.' };
      db.setCustomerConsultant(input.customer_id, con.id, { actor: 'assistant' });
      try {
        db.setCustomerAttribution({
          customer_id: input.customer_id,
          source_id: db.homeShowSourceId(),
          note: `Home Show — consultant ${con.name} (via assistant)`,
          actor: 'assistant',
        });
      } catch (e) {}
      // Also stamp any appointment for this customer that has no consultant yet.
      for (const a of db.listAppointments({}).filter((a) => a.customer_id === input.customer_id && !a.consultant_id)) {
        try {
          db.db.prepare(`UPDATE appointments SET consultant_id = ? WHERE id = ?`).run(con.id, a.id);
        } catch (e) {}
      }
      return { ok: true, consultant: con.name, customer_id: input.customer_id };
    }
    case 'list_consultants': {
      return { consultants: db.listConsultants({ includeInactive: true }).map((c) => ({ id: c.id, name: c.name, active: !!c.active })) };
    }
    case 'navigate_to_record': {
      const t = String(input.type || '').toLowerCase();
      let pathTo = null;
      let customer_id = input.customer_id || null;
      if (t === 'customer') {
        const c = db.getCustomer(input.customer_id);
        if (!c) return { error: 'Customer not found - resolve them with find_customers first.' };
        pathTo = `/dashboard/customers/${c.id}`;
      } else if (t === 'job') {
        const j = db.getJob(input.job_id);
        if (!j) return { error: 'Job not found.' };
        pathTo = `/dashboard/jobs/${j.id}`;
        customer_id = j.customer_id;
      } else if (t === 'appointment') {
        const a = db.getAppointment(input.appointment_id);
        if (!a) return { error: 'Appointment not found.' };
        pathTo = `/dashboard/appointments/${a.id}/edit`;
        customer_id = a.customer_id;
      } else if (t === 'files') {
        if (input.customer_id) {
          const c = db.getCustomer(input.customer_id);
          if (!c) return { error: 'Customer not found.' };
          pathTo = `/dashboard/customers/${c.id}#sec-files`;
        } else {
          pathTo = '/dashboard/files';
        }
      } else if (t === 'production') {
        pathTo = '/dashboard/production';
      } else if (t === 'pipeline') {
        pathTo = '/dashboard/pipeline';
      } else if (t === 'kpi') {
        pathTo = '/dashboard/kpi';
      } else if (t === 'appointments') {
        pathTo = '/dashboard/appointments';
      } else if (t === 'overview') {
        pathTo = '/dashboard';
      }
      if (!pathTo) return { error: `Don't know how to navigate to "${input.type}".` };
      return { ok: true, __navigate: pathTo, customer_id };
    }
    case 'search_files': {
      return { files: db.searchFiles(input.query) };
    }
    case 'list_files': {
      if (input.job_id) return { files: db.listJobFiles(input.job_id) };
      if (input.customer_id) return { files: db.listCustomerFiles(input.customer_id) };
      return { error: 'Pass a customer_id or job_id, or use search_files.' };
    }
    case 'get_file': {
      const file = db.getCustomerFile(input.file_id);
      if (!file) return { error: 'File not found' };
      let extracted_json = null;
      try {
        extracted_json = file.extracted_json ? JSON.parse(file.extracted_json) : null;
      } catch (e) {
        extracted_json = file.extracted_json;
      }
      return { file: { ...file, extracted_json } };
    }
    case 'attach_file_to_job': {
      const file = db.getCustomerFile(input.file_id);
      if (!file) return { error: 'File not found' };
      const job = db.getJob(input.job_id);
      if (!job) return { error: 'Job not found' };
      db.attachFileToJob(input.file_id, input.job_id);
      return { ok: true, file_id: input.file_id, job_id: input.job_id, customer_id: file.customer_id };
    }
    case 'move_file_to_customer': {
      const file = db.getCustomerFile(input.file_id);
      if (!file) return { error: 'File not found' };
      const customer = db.getCustomer(input.customer_id);
      if (!customer) return { error: 'Customer not found' };
      db.setFileAssignment(input.file_id, { customer_id: customer.id, assignment_status: 'confirmed' });
      return { ok: true, file_id: input.file_id, customer_id: customer.id, customer_name: customer.name };
    }
    case 'save_file_extraction': {
      const file = db.getCustomerFile(input.file_id);
      if (!file) return { error: 'File not found' };
      db.setFileExtraction(input.file_id, {
        extracted_text: input.extracted_text || '',
        extracted_json: input.extracted_json || null,
        status: 'done',
      });
      return { ok: true, file_id: input.file_id, customer_id: file.customer_id };
    }
    case 'create_job': {
      if (input.confirmed !== true) {
        return { error: 'Not created - restate the exact customer and sold amount and wait for Andrew to confirm before calling this again.' };
      }
      const customer = db.getCustomer(input.customer_id);
      if (!customer) return { error: 'Customer not found' };
      const job = db.createJob({ customer_id: customer.id, sold_amount: input.sold_amount, notes: input.notes });
      return { ok: true, job, customer_id: customer.id };
    }
    case 'update_job': {
      if (input.confirmed !== true) {
        return { error: 'Not changed - restate the exact change (sold amount and/or status) and wait for Andrew to confirm before calling this again.' };
      }
      const job = db.getJob(input.job_id);
      if (!job) return { error: 'Job not found' };
      if (input.sold_amount !== undefined && input.sold_amount !== null) {
        db.updateJobSoldAmount(input.job_id, input.sold_amount);
      }
      if (input.status && input.status !== job.status) {
        db.updateJobStatus(input.job_id, input.status, input.note || 'Updated via assistant');
      }
      return { ok: true, job: db.getJob(input.job_id), customer_id: job.customer_id };
    }
    case 'get_upcoming_appointment_briefing': {
      const upcoming = db.listAppointments({ upcomingOnly: true });
      if (!upcoming.length) return { message: 'No upcoming appointments scheduled.' };
      const appt = upcoming[0];
      const customer = db.getCustomer(appt.customer_id);
      return { appointment: appt, customer };
    }
    case 'list_sales_reps': {
      return { reps: db.listSalesReps() };
    }
    case 'create_sales_rep': {
      const existing = db.findSalesRepByName(input.name);
      if (existing) return { rep: existing, note: 'already existed' };
      return { rep: db.createSalesRep(input) };
    }
    case 'get_training_history': {
      const sessions = db.listTrainingSessions(input.rep_id);
      return { sessions };
    }
    case 'log_training_session': {
      const session_id = db.createTrainingSession(input);
      return { session_id, ...input };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------- Anthropic Messages API (raw HTTPS, no SDK) ----------
function callClaude(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
    const body = JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt(opts),
      tools: TOOLS,
      messages,
    });
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    // 30s per-request timeout, so a hung Anthropic call fails cleanly instead
    // of holding the connection until the browser's own 120s abort.
    req.setTimeout(30000, () => req.destroy(new Error('Anthropic request timed out after 30s')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// The tool loop below runs up to 6 rounds of callClaude(); on a slow
// multi-round turn the per-call 30s timeouts could still add up past the
// browser's 120s abort. This gives the whole turn one shared budget so a
// slow turn fails with a real message from the server itself.
const CHAT_TURN_BUDGET_MS = 100000;
function withBudget(promise, budgetMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SYSTEM_PROMPT = `You are the office manager AND financial analyst for the Shelves to Drawers RVA BOS
(Business Operations System). You have tools to look up and change customers, their sales
stage, follow-ups, appointments, payments, expenses, jobs, product/factory-order lines,
and marketing attribution; to send a customer a text/email through the BOS; to search and
read uploaded files; plus reporting tools for KPIs, cash flow, P&L, accounts receivable,
expense run-rate, and the production queue.

SALES MODEL - important. The primary, measurable stage of an opportunity is one of, in
order: Bona Fide Lead → Design Appointment Set → Design Appointment Completed → Estimate
Presented → Sold. "Closed / We Declined Customer" is a separate terminal disposition.
There is NO "Lost" and no "Inquiry" stage. A customer who simply hasn't bought is still
active - use the dormant flag or a sub-status, never treat non-purchase as lost. Attention
sub-statuses (Estimate Overdue, Follow-up Due, Reschedule Needed, Waiting on Customer, etc.)
say what needs doing and do NOT change the KPI stage. When Andrew reports something
happened ("did the design appt for the Walkers", "sent Jane her estimate"), move the stage
AND, where useful, add a follow-up with a due date.

Andrew wants to be able to actually talk through business questions with
you - "can I afford to buy the truck this month," "why does next month look tight," "which
customers still owe me money" - not just issue one-line commands. Use the reporting tools
proactively and combine them: a cash-flow question almost always needs list_job_balances
(what's coming in and when) plus get_expense_run_rate or get_profit_loss (what's going out),
not just one of them.

Always call find_customers first when the user refers to a person by name, to check whether
they already exist before creating a duplicate. If more than one plausible customer matches,
stop and ask which one instead of guessing. If a request is ambiguous or missing required
info (e.g. no amount for a payment), ask a short clarifying question instead of guessing.
Dates the user gives in local time should be treated as US Eastern time and converted to
UTC ISO 8601 for scheduled_at. When you're done making changes, reply with a short, plain
summary of exactly what you did (or didn't do), written for Andrew to quickly verify - not
a chatty conversational reply. In that reply, always write dates and times in plain readable
US Eastern form ("Tue, Sep 15 at 2:00 PM"), never a raw ISO string like
"2026-09-15T18:00:00Z" - ISO format is only for the tool inputs, never for what Andrew reads.

Financial reasoning rules - these matter more than being fast:
- Never invent a number. Every dollar figure you state must come from a tool call in this
  conversation. If you're estimating or projecting (e.g. "expenses over the next 60 days,
  assuming they track the recent average"), say explicitly that it's an estimate/projection
  and name the assumption, rather than presenting it as a known fact.
- This CRM has no bank-balance or accounts-payable data - it only knows about jobs, their
  sold amounts and payments collected, and expenses already logged. It cannot tell you
  Andrew's actual current cash on hand or upcoming bills that haven't been entered as
  expenses. If a cash-flow question depends on that, say so and ask Andrew for the missing
  number (e.g. "what's your current account balance?") rather than silently omitting it or
  guessing.
- list_job_balances' expected_payment_date is only ever populated because Andrew's rule is
  that a job's remaining balance is due the day of its Install appointment. A job with no
  Install scheduled yet has no known due date - report that plainly ("no install scheduled,
  timing unknown") instead of estimating one.
- log_payment, log_expense, create_job, and update_job are real writes. Before calling
  any of them, state the exact entry (amount, category/vendor, method, date; or the product
  line; or the job change) back to Andrew in plain text and wait for him to confirm in a
  later message - then, and only then, call the tool with confirmed:true. Never set
  confirmed:true on your own inference that he agreed; it needs an actual yes from him in
  this conversation. This applies even if he was the one who told you the numbers in the
  first place - stating a number isn't the same as confirming the entry.

Files: when Andrew uploads a file it has already been saved and its id is given to you in
the message. Read it, then call save_file_extraction with a compact JSON of the key fields
(products and quantities, unit and total pricing, date sold, promised or due dates, customer
name and address, invoice or order number) and a short plain-text summary - this only
annotates the file so it's searchable later, it creates nothing. If the document implies an
expense (a supplier invoice), propose the expense entry in plain text and wait for Andrew's
explicit confirmation before any confirmed:true call. There is no tool to create product /
factory-order lines from a document - do not propose or offer to create one; tell Andrew
product lines are added from the job page. Use attach_file_to_job to tie a file to the right
job, and move_file_to_customer to re-file a file that landed under the wrong customer (or no
customer). Use search_files to find an existing document Andrew refers to.

You can see the recent conversation, so pronouns and follow-ups ("her", "that job", "do the
same for the other one") refer back to what was already discussed - use that context instead
of asking Andrew to repeat himself. That history can go stale, though: always re-check current
facts (a customer's stage, a job's balance, etc.) with the lookup tools before acting, rather
than trusting a number or status mentioned earlier in the conversation.

Navigation: you can move the BOS screen Andrew is looking at with navigate_to_record -
"open Leora Copeland's record", "show me her job", "open her appointment", "pull up
production / the pipeline / KPIs". For a person, call find_customers first and pass the
customer_id. Navigating does not lose the conversation or the active customer, so it is
safe to do the moment he asks. Keep the reply to one short line ("Opening Leora Copeland's
record.") - the screen is already changing, he doesn't need a paragraph.

You have no ability to delete anything - there is no delete tool, full stop. If Andrew asks you
to delete or remove a record, do not offer to do it, do not suggest a workaround that amounts to
deleting it (like blanking out its fields, marking it some improvised "deleted" status, or
moving it somewhere), and do not imply you handled it. Just say plainly that deletions aren't
something you can do and have to be done manually in the dashboard.

You also have get_upcoming_appointment_briefing - it pulls the next appointment and that
customer's notes and discovery-wizard answers (rooms, pets, prior experience, product
interest), for prepping a pitch beforehand. Only use it when Andrew is actually prepping for
a visit.`;

// Appended to SYSTEM_PROMPT only when SALES_TRAINING_ENABLED (see top of file).
const SALES_TRAINING_PROMPT = `

You also have sales-training tools: list_sales_reps / create_sales_rep, get_training_history
(a rep's past role-plays, quizzes, and real-sale outcomes), and log_training_session. The
single most important use: right after Andrew reports how an actual sales call went, log it
as a real_sale session with a specific, honest summary of what worked and what didn't and an
outcome of won/lost. Only pull get_training_history when it's actually relevant.`;

// Appended when the message came in over Voice Mode (spec 10-14, 24-25).
const VOICE_PROMPT = `

VOICE MODE. This message was spoken aloud and your reply will be read aloud, then the
mic reopens automatically - it is a live back-and-forth, so keep replies short, natural
and free of markdown, lists, IDs, URLs and raw ISO dates. One or two sentences, then a
clear question or next step.

The main job in Voice Mode is Home Show booking, and it usually starts with a SALESPERSON
briefing you before handing the phone to a CUSTOMER. When someone opens with something like
"this is Andrew at the Home Show, I'm handing the phone to Donna who wants an appointment
in March, she's way up north so check the ZIPs and book her anyway, try for a day I'm
already up there" - do NOT ask them to repeat it into fields. Quietly extract and hold:
 - sales consultant (e.g. Andrew) and lead source = Home Show
 - the customer's name
 - the objective (book a design appointment)
 - any requested date range ("March")
 - geography notes ("far north")
 - a service-area override ("book anyway")
 - scheduling preferences ("a day Andrew's already in that area" -> pass it as the "near"
   argument to list_available_slots)
Acknowledge in one short line ("Got it, Andrew - go ahead and hand her the phone"), and
KEEP those instructions active for the whole rest of the call even after the customer is
speaking. They do not need to be repeated.

When the speaker hands over ("here's Donna" / "okay she's got the phone"), switch to
talking directly TO the customer, warmly and simply: "Hi Donna - let's find you a good
time. What's the full address, including city and ZIP?" Then gather anything missing
(address, phone, email), read back a spelled name/street if it sounds ambiguous, call
list_available_slots and offer FOUR times spread out, let them pick or ask for others.

Before you actually book: say the whole thing back - "I've got Tuesday, March 17th at
2 PM at 123 Main Street in Bowling Green. Want me to book that?" - and only call
book_design_appointment with confirmed:true after they say yes out loud (or tap confirm).
A spoken "yes" is enough; don't make them touch the screen. After it's booked, say it's
done and repeat the day and time, then you may ask the quick discovery questions (rooms,
pets, prior experience, what to show them) - the appointment comes first.

Never reject a booking for being out of area; if the salesperson said book anyway, book
anyway - the address is still recorded and Andrew is still notified.`;

function systemPrompt(opts = {}) {
  return (
    SYSTEM_PROMPT +
    (opts.mode === 'voice' ? VOICE_PROMPT : '') +
    (SALES_TRAINING_ENABLED ? SALES_TRAINING_PROMPT : '')
  );
}

// Runs the full tool-use loop for one user message. Returns
// { summary, changedCustomerId, toolLog } - toolLog is for debugging/display.
async function handleMessage(userMessage, context = {}, opts = {}) {
  if (!assistantConfigured()) {
    return { summary: 'AI assistant not configured - set ANTHROPIC_API_KEY to enable it.', error: true };
  }

  const file = opts.file || null;

  // If Andrew is looking at a specific customer's page when he sends a
  // message, tell the model that directly - otherwise "update the phone
  // number" has no idea who "the record" means. These notes are only sent to
  // the model for this turn; the clean userMessage (no note) is what gets
  // persisted to conversationHistory and shown back in the chat log.
  const notes = [];
  if (context.customerId) {
    const currentCustomer = db.getCustomer(context.customerId);
    if (currentCustomer) {
      notes.push(
        `[Andrew is currently viewing the record for customer "${currentCustomer.name}" (id: ${currentCustomer.id}). If his message below refers to "this customer," "this record," "them," etc. without naming someone else, it means this one.]`
      );
    }
  }

  // An uploaded file has already been saved (see the route). Build the first
  // user turn as content blocks so the model can actually read images / PDFs;
  // text files are inlined. conversationHistory still only ever stores the
  // plain userMessage string (see remember()), so binary never enters history.
  let userContent = [notes.join('\n'), userMessage].filter(Boolean).join('\n\n') || '(no message)';
  if (file) {
    let mime = (file.mimeType || '').toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg'; // Anthropic wants image/jpeg
    const tooBig = file.buffer.length > MAX_ANALYZE_BYTES;
    const blocks = [];
    let fileNote = `[Andrew uploaded a file: "${file.filename}" (${mime || 'unknown type'}, ${Math.round(file.buffer.length / 1024)} KB). It is already saved as file_id ${file.id}.`;

    if (tooBig) {
      fileNote += ` It is too large to analyze here (${Math.round(file.buffer.length / 1024 / 1024)} MB) - it is stored, tell Andrew it needs to be reviewed by hand.]`;
      db.setFileExtraction(file.id, { status: 'unsupported', extracted_text: '', extracted_json: null });
    } else if (mime.startsWith('image/')) {
      fileNote += ` Read it below, then follow the Files instructions.]`;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: file.buffer.toString('base64') } });
    } else if (mime === 'application/pdf') {
      fileNote += ` Read it below, then follow the Files instructions.]`;
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } });
    } else if (mime.startsWith('text/') || mime === 'application/csv' || /\.(txt|csv|md)$/i.test(file.filename)) {
      const text = file.buffer.toString('utf-8').slice(0, 100000);
      fileNote += ` Its contents:]\n\n${text}`;
    } else {
      fileNote += ` This file type can't be read here - it is stored; tell Andrew it needs manual review.]`;
      db.setFileExtraction(file.id, { status: 'unsupported', extracted_text: '', extracted_json: null });
    }

    blocks.unshift({ type: 'text', text: [userContent === '(no message)' ? '' : userContent, fileNote].filter(Boolean).join('\n\n') });
    userContent = blocks;
  }

  const messages = [...conversationHistory, { role: 'user', content: userContent }];
  const toolLog = [];
  let changedCustomerId = null;
  let navigateTo = null;

  function remember(assistantText) {
    conversationHistory.push({ role: 'user', content: userMessage || (file ? `(uploaded file: ${file.filename})` : '(no message)') });
    conversationHistory.push({ role: 'assistant', content: assistantText });
    const maxMessages = MAX_HISTORY_TURNS * 2;
    if (conversationHistory.length > maxMessages) {
      conversationHistory = conversationHistory.slice(-maxMessages);
    }
  }

  // The whole turn (up to 6 rounds, each with its own 30s callClaude timeout)
  // gets one shared budget, so a slow multi-round turn fails cleanly from the
  // server - with a real message - well before the browser's 120s abort.
  async function runLoop() {
  for (let i = 0; i < 6; i++) {
    let response;
    try {
      response = await callClaude(messages, { mode: context.mode });
    } catch (err) {
      remember(`(error: ${err.message})`);
      return { summary: `Assistant error: ${err.message}`, error: true, toolLog };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      remember(text || '(no response)');
      return { summary: text || '(no response)', changedCustomerId, navigateTo, toolLog };
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        result = runTool(block.name, block.input || {});
      } catch (err) {
        result = { error: String(err.message || err) };
      }
      // book_design_appointment returns a marker; the real booking (async, and
      // it fires the SMS/email automations) happens here through the exact same
      // createBooking() path the public /book form uses.
      if (result && result.__async_booking) {
        const inp = result.__async_booking.input;
        let br;
        try {
          br = await booking().createBooking({
            name: inp.name,
            phone: inp.phone,
            email: inp.email,
            address: inp.address,
            slotIso: inp.scheduled_at,
            type: inp.type,
            consultantName: inp.consultant_name,
            leadSource: inp.lead_source,
            actor: 'assistant',
          });
        } catch (e) {
          br = { ok: false, error: String(e.message || e) };
        }
        if (br.ok) {
          result = {
            ok: true,
            booked: true,
            appointment_id: br.appt.id,
            customer_id: br.customer.id,
            when: booking().fmtSlotLong(new Date(br.appt.scheduled_at)),
            out_of_area: !!br.outOfArea,
            note:
              'Appointment booked and the confirmation text/email was triggered (it is only actually delivered if Twilio/Gmail are configured).' +
              (br.outOfArea ? ' Address is outside the normal area - Andrew was notified.' : ''),
          };
        } else {
          result = { ok: false, error: br.error || 'Booking failed.', conflict: !!br.conflict };
        }
      }
      // send_customer_message returns a marker; the actual send is async and
      // happens here so the message goes through the exact same sms/email
      // pipeline (and verified logging) as the dashboard.
      if (result && result.__async_send) {
        const { customer, channel, body } = result.__async_send;
        let sendRes;
        try {
          if (channel === 'email') {
            sendRes = await email.sendEmail({
              to: customer.email,
              subject: `Message from ${process.env.BUSINESS_NAME || 'Shelves to Drawers RVA'}`,
              html: `<p>${String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
              customer_id: customer.id,
              logMessage: db.logMessage,
            });
          } else {
            sendRes = await sms.sendSms({ to: customer.phone, body, customer_id: customer.id, logMessage: db.logMessage });
          }
        } catch (e) {
          sendRes = { ok: false, reason: String(e.message || e) };
        }
        db.logActivity({
          entity_type: 'message',
          entity_id: customer.id,
          customer_id: customer.id,
          field: channel === 'email' ? 'email_sent' : 'text_sent',
          new_value: String(body).slice(0, 80),
          note: sendRes && sendRes.ok ? 'delivered' : `not delivered (${(sendRes && sendRes.reason) || 'error'})`,
          actor: 'assistant',
        });
        result = {
          ok: !!(sendRes && sendRes.ok),
          delivered: !!(sendRes && sendRes.ok),
          recorded: true,
          note:
            sendRes && sendRes.ok
              ? 'Message delivered and recorded.'
              : `Recorded in history but NOT delivered${sendRes && sendRes.reason ? ` (${sendRes.reason})` : ''}. Tell Andrew it did not actually send.`,
          customer_id: customer.id,
        };
      }
      // send_email (spec F3) - same shape as send_customer_message above, but
      // to an arbitrary address and with no customer required.
      if (result && result.__async_email) {
        const { to, subject, body, customer_id } = result.__async_email;
        let sendRes;
        try {
          sendRes = await email.sendEmail({
            to,
            subject,
            html: `<p>${String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
            customer_id,
            logMessage: db.logMessage,
          });
        } catch (e) {
          sendRes = { ok: false, reason: String(e.message || e) };
        }
        db.logActivity({
          entity_type: 'message',
          entity_id: customer_id || to,
          customer_id: customer_id || null,
          field: 'email_sent',
          new_value: String(subject).slice(0, 80),
          note: sendRes && sendRes.ok ? `delivered to ${to}` : `not delivered to ${to} (${(sendRes && sendRes.reason) || 'error'})`,
          actor: 'assistant',
        });
        result = {
          ok: !!(sendRes && sendRes.ok),
          delivered: !!(sendRes && sendRes.ok),
          recorded: true,
          note:
            sendRes && sendRes.ok
              ? `Email sent to ${to} and recorded.`
              : `Recorded in history but NOT delivered to ${to}${sendRes && sendRes.reason ? ` (${sendRes.reason})` : ''}. Tell Andrew it did not actually send.`,
          customer_id: customer_id || null,
        };
      }
      toolLog.push({ tool: block.name, input: block.input, result });
      if (result && result.__navigate) navigateTo = result.__navigate;
      // Only treat this as "a record changed, maybe follow it" for tools that
      // actually write. A pure lookup (find_customers, get_customer_detail,
      // reporting) must NOT yank Andrew's page to whatever he just asked about -
      // that was destroying his context mid-task (spec 20/21).
      if (!READ_ONLY_TOOLS.has(block.name)) {
        const foundCustomerId =
          result?.customer_id ||
          result?.customer?.id ||
          result?.lead?.customer_id ||
          result?.appointment?.customer_id;
        if (foundCustomerId) changedCustomerId = foundCustomerId;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  remember('(stopped after several steps without a final answer)');
  return { summary: 'Stopped after several steps without a final answer - try rephrasing.', error: true, toolLog };
  }

  try {
    return await withBudget(
      runLoop(),
      CHAT_TURN_BUDGET_MS,
      'This is taking too long (a multi-step request that is not finishing in time). Try a simpler request, or try again.'
    );
  } catch (err) {
    remember(`(error: ${err.message})`);
    return { summary: err.message, error: true, toolLog };
  }
}

module.exports = { handleMessage, assistantConfigured, resetConversation, getHistory, runTool, TOOLS };
