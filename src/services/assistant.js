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
    description: 'Record income received - a deposit, progress payment, or final payment.',
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
      },
      required: ['amount'],
    },
  },
  {
    name: 'log_expense',
    description: 'Record a business expense.',
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
      },
      required: ['amount', 'category'],
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
      const payment_id = db.createPayment({ ...input, paid_at: input.paid_at || new Date().toISOString() });
      return { payment_id, ...input };
    }
    case 'log_expense': {
      const expense_id = db.createExpense({ ...input, expense_date: input.expense_date || new Date().toISOString() });
      return { expense_id, ...input };
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

const SYSTEM_PROMPT = `You are the office manager assistant for the Shelves to Drawers RVA CRM.
You have tools to look up and change customers, leads, appointments, payments, and expenses.
Always call find_customers first when the user refers to a person by name, to check whether
they already exist before creating a duplicate. If more than one plausible customer matches,
stop and ask which one instead of guessing. If a request is ambiguous or missing required
info (e.g. no amount for a payment), ask a short clarifying question instead of guessing.
Dates the user gives in local time should be treated as US Eastern time and converted to
UTC ISO 8601 for scheduled_at. When you're done making changes, reply with a short, plain
summary of exactly what you did (or didn't do), written for Andrew to quickly verify - not
a chatty conversational reply.`;

// Runs the full tool-use loop for one user message. Returns
// { summary, changedCustomerId, toolLog } - toolLog is for debugging/display.
async function handleMessage(userMessage) {
  if (!assistantConfigured()) {
    return { summary: 'AI assistant not configured - set ANTHROPIC_API_KEY to enable it.', error: true };
  }
  const messages = [{ role: 'user', content: userMessage }];
  const toolLog = [];
  let changedCustomerId = null;

  for (let i = 0; i < 6; i++) {
    let response;
    try {
      response = await callClaude(messages);
    } catch (err) {
      return { summary: `Assistant error: ${err.message}`, error: true, toolLog };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
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

  return { summary: 'Stopped after several steps without a final answer - try rephrasing.', error: true, toolLog };
}

module.exports = { handleMessage, assistantConfigured };
