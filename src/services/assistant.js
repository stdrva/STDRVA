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
const TOOLS = [
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
    description: 'Full detail on one job: its line items/products, every payment made against it, and its remaining balance.',
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
      const products = db.listProductsForJob(input.job_id);
      const payments = db.listPayments({}).filter((p) => p.job_id === input.job_id);
      const balance_due = db.getJobBalance(input.job_id);
      return { job, products, payments, balance_due };
    }
    case 'list_production_queue': {
      return { queue: db.listProductionQueue({ includeDelivered: input.includeDelivered }) };
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
function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are the office manager AND financial analyst for the Shelves to Drawers RVA CRM.
You have tools to look up and change customers, leads, appointments, payments, and expenses,
plus reporting tools for cash flow, P&L, accounts receivable, expense run-rate, and the
production queue. Andrew wants to be able to actually talk through business questions with
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
a chatty conversational reply.

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
- log_payment and log_expense are real entries in the books. Before calling either, state
  the exact amount, category/vendor, method, and date back to Andrew in plain text and wait
  for him to confirm in a later message - then, and only then, call the tool with
  confirmed:true. Never set confirmed:true on your own inference that he agreed; it needs an
  actual yes from him in this conversation. This applies even if he was the one who told you
  the numbers in the first place - stating a number isn't the same as confirming the entry.

You can see the recent conversation, so pronouns and follow-ups ("her", "that job", "do the
same for the other one") refer back to what was already discussed - use that context instead
of asking Andrew to repeat himself. That history can go stale, though: always re-check current
facts (a customer's stage, a job's balance, etc.) with the lookup tools before acting, rather
than trusting a number or status mentioned earlier in the conversation.

You can see the recent conversation, so pronouns and follow-ups ("her", "that job", "do the
same for the other one") refer back to what was already discussed - use that context instead
of asking Andrew to repeat himself. That history can go stale, though: always re-check current
facts (a customer's stage, a job's balance, etc.) with the lookup tools before acting, rather
than trusting a number or status mentioned earlier in the conversation.

You have no ability to delete anything - there is no delete tool, full stop. If Andrew asks you
to delete or remove a record, do not offer to do it, do not suggest a workaround that amounts to
deleting it (like blanking out its fields, marking it some improvised "deleted" status, or
moving it somewhere), and do not imply you handled it. Just say plainly that deletions aren't
something you can do and have to be done manually in the dashboard.

You also have sales-training tools: get_upcoming_appointment_briefing (pulls the next
appointment and that customer's notes/discovery answers, for prepping a pitch beforehand),
list_sales_reps / create_sales_rep, get_training_history (a rep's past role-plays, quizzes, and
real-sale outcomes), and log_training_session. The single most important use of these: right
after Andrew reports how an actual sales call went, log it as a real_sale session with a
specific, honest summary of what worked and what didn't and an outcome of won/lost - that real
feedback matters more than role-play. Only pull get_training_history when it's actually relevant
(prepping a briefing, discussing a rep's progress) - don't fetch it on unrelated requests.`;

// Runs the full tool-use loop for one user message. Returns
// { summary, changedCustomerId, toolLog } - toolLog is for debugging/display.
async function handleMessage(userMessage, context = {}) {
  if (!assistantConfigured()) {
    return { summary: 'AI assistant not configured - set ANTHROPIC_API_KEY to enable it.', error: true };
  }

  // If Andrew is looking at a specific customer's page when he sends a
  // message, tell the model that directly - otherwise "update the phone
  // number" has no idea who "the record" means. This note is only sent to
  // the model for this turn; the clean userMessage (no note) is what gets
  // persisted to conversationHistory and shown back in the chat log.
  let modelMessage = userMessage;
  if (context.customerId) {
    const currentCustomer = db.getCustomer(context.customerId);
    if (currentCustomer) {
      modelMessage = `[Andrew is currently viewing the record for customer "${currentCustomer.name}" (id: ${currentCustomer.id}). If his message below refers to "this customer," "this record," "them," etc. without naming someone else, it means this one.]\n\n${userMessage}`;
    }
  }

  const messages = [...conversationHistory, { role: 'user', content: modelMessage }];
  const toolLog = [];
  let changedCustomerId = null;

  function remember(assistantText) {
    conversationHistory.push({ role: 'user', content: userMessage });
    conversationHistory.push({ role: 'assistant', content: assistantText });
    const maxMessages = MAX_HISTORY_TURNS * 2;
    if (conversationHistory.length > maxMessages) {
      conversationHistory = conversationHistory.slice(-maxMessages);
    }
  }

  for (let i = 0; i < 6; i++) {
    let response;
    try {
      response = await callClaude(messages);
    } catch (err) {
      remember(`(error: ${err.message})`);
      return { summary: `Assistant error: ${err.message}`, error: true, toolLog };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      remember(text || '(no response)');
      return { summary: text || '(no response)', changedCustomerId, toolLog };
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
      toolLog.push({ tool: block.name, input: block.input, result });
      const foundCustomerId =
        result?.customer_id ||
        result?.customer?.id ||
        result?.lead?.customer_id ||
        result?.appointment?.customer_id;
      if (foundCustomerId) changedCustomerId = foundCustomerId;
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

module.exports = { handleMessage, assistantConfigured, resetConversation, getHistory };
