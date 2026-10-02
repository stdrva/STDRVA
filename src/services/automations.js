// Funnel automation triggers. Kept in one place so it's obvious what fires
// when. Each function is safe to call even if SMS/email aren't configured -
// the sms/email services fall back to console logging.
const db = require('../db');
const { sendSms } = require('./sms');
const { sendEmail } = require('./email');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '(804) 839-7984';

// Canonical public base URL for anything a CUSTOMER sees - booking links, QR
// codes, status-page links, links inside texts/emails. Never expose localhost
// or a dev URL in production.
//   1. BASE_URL              - explicit override, always wins
//   2. RENDER_EXTERNAL_URL   - injected automatically by Render (https://<svc>.onrender.com)
//   3. PUBLIC_BASE_URL       - generic alias some hosts set
//   4. localhost:PORT        - local dev only
function baseUrl() {
  const fromEnv =
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`;
  return String(fromEnv).replace(/\/+$/, '');
}

// True when we still don't have a real public URL - used to warn in logs so a
// deploy that forgot to set one is obvious instead of silently shipping
// localhost links.
function baseUrlIsLocal() {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(baseUrl());
}

function bookingUrl() {
  return `${baseUrl()}/book`;
}

function statusUrl(token) {
  return `${baseUrl()}/status/${token}`;
}

function appointmentUrl(token) {
  return `${baseUrl()}/appointment/${token}`;
}

// "about 1 hour", "about 90 minutes" - reused by the confirmation email (G1).
function formatDuration(min) {
  if (!min) return '';
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  return `${min} minutes`;
}

// Notifies Andrew himself (not the customer) - used for anything that needs
// his personal attention, like an out-of-area contact. Uses the same
// sms/email primitives, just aimed at his own number/address instead of the
// customer's. Safe to call even if OWNER_NOTIFY_PHONE/EMAIL aren't set - it
// just logs to the console like every other channel in this app.
async function notifyOwner({ smsBody, emailSubject, emailHtml }) {
  const results = {};
  const ownerPhone = process.env.OWNER_NOTIFY_PHONE;
  const ownerEmail = process.env.OWNER_NOTIFY_EMAIL;
  if (ownerPhone) {
    results.sms = await sendSms({ to: ownerPhone, body: smsBody, logMessage: db.logMessage });
  } else {
    console.log(`[Owner notify - OWNER_NOTIFY_PHONE not set] Would text Andrew: ${smsBody}`);
  }
  if (ownerEmail) {
    results.email = await sendEmail({ to: ownerEmail, subject: emailSubject, html: emailHtml, logMessage: db.logMessage });
  } else {
    console.log(`[Owner notify - OWNER_NOTIFY_EMAIL not set] Would email Andrew "${emailSubject}"`);
  }
  return results;
}

// Fired when a booking-page visitor's address falls outside the defined
// service area - either they asked Andrew to reach out, or they booked a
// real slot anyway despite being out of area. Either way he needs a heads up.
async function onOutOfAreaContact(kind, customer, { type } = {}) {
  const label = kind === 'booked' ? 'booked an appointment anyway' : 'asked to be contacted';
  const body = `${BUSINESS_NAME}: ${customer.name} is outside your service area and ${label}. ${customer.phone || ''} ${customer.email || ''} - ${customer.address || 'no address on file'}`.trim();
  return notifyOwner({
    smsBody: body,
    emailSubject: `Out-of-area contact: ${customer.name}`,
    emailHtml: `<p><strong>${customer.name}</strong> is outside your defined service area and ${label}${type ? ` (${type})` : ''}.</p><p>Phone: ${customer.phone || '-'}<br>Email: ${customer.email || '-'}<br>Address: ${customer.address || '-'}</p>`,
  });
}

async function notifyCustomer(customer, { smsBody, emailSubject, emailHtml }) {
  const results = {};
  if (customer.phone) {
    results.sms = await sendSms({
      to: customer.phone,
      body: smsBody,
      customer_id: customer.id,
      logMessage: db.logMessage,
    });
  }
  if (customer.email) {
    results.email = await sendEmail({
      to: customer.email,
      subject: emailSubject,
      html: emailHtml,
      customer_id: customer.id,
      logMessage: db.logMessage,
    });
  }
  return results;
}

// Fired when a new lead enters the funnel.
async function onLeadCreated(lead, customer) {
  const body = `Hi ${customer.name.split(' ')[0]}, thanks for reaching out to ${BUSINESS_NAME}! We'll be in touch shortly. You can also grab a time on our calendar here: ${bookingUrl()}`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `Thanks for contacting ${BUSINESS_NAME}`,
    emailHtml: `<p>Hi ${customer.name},</p><p>Thanks for reaching out to ${BUSINESS_NAME}! We'll be in touch shortly.</p><p>You can also grab a time directly on our calendar: <a href="${bookingUrl()}">${bookingUrl()}</a></p>`,
  });
}

// Fired when a lead is marked Sold and a job record is created.
async function onJobCreated(job, customer) {
  const link = statusUrl(job.public_token);
  const body = `Great news, ${customer.name.split(' ')[0]}! Your order with ${BUSINESS_NAME} is confirmed. Track progress anytime here: ${link}`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `Your ${BUSINESS_NAME} order is confirmed`,
    emailHtml: `<p>Hi ${customer.name},</p><p>Your order is confirmed! You can check progress on your project anytime using this link:</p><p><a href="${link}">${link}</a></p><p>Bookmark it - we'll keep it updated as your project moves along.</p>`,
  });
}

// Fired on a manual/auto job status change, if the user opts to notify.
async function onJobStatusChanged(job, customer, status) {
  const link = statusUrl(job.public_token);
  const body = `${BUSINESS_NAME} update: your project status is now "${status}". Details: ${link}`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `${BUSINESS_NAME}: project status updated - ${status}`,
    emailHtml: `<p>Hi ${customer.name},</p><p>Your project status was just updated to <strong>${status}</strong>.</p><p>View full details: <a href="${link}">${link}</a></p>`,
  });
}

// ---- Appointment reminders (BF-2639-067) ----
// The appointment TYPE picks the body; the send window (reminders.js) is the
// same for all of them. Times are always America/New_York and labelled ET.
const ESTIMATE_APPT_TYPES = ['Short Design Consultation', 'Long Design Consultation', 'Design Review'];

// { weekday: 'Friday', month: 'October', day: '9', time: '2:00 PM' } in ET.
function etParts(iso) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(iso))) {
    parts[p.type] = p.value;
  }
  return { weekday: parts.weekday, month: parts.month, day: parts.day, time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}` };
}
function etWhenLine(iso) {
  const p = etParts(iso);
  return `${p.weekday}, ${p.month} ${p.day} at ${p.time} ET`;
}
const htmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Shared frame: header, ET date line, address, the type-specific prep lines,
// then the public-page link and the phone footer.
function reminderMessage(label, prepLines, { appt, customer }) {
  const link = appointmentUrl(appt.public_token);
  const when = etWhenLine(appt.scheduled_at);
  const lines = [
    `${BUSINESS_NAME} — ${label}`,
    when,
    customer && customer.address ? customer.address : null,
    ...prepLines,
    `Your page (details, contact us, request a new time): ${link}`,
    `Or call/text Andrew: ${BUSINESS_PHONE}`,
  ].filter(Boolean);
  return {
    smsBody: lines.join('\n'),
    emailSubject: `Reminder: your ${BUSINESS_NAME} ${label} - ${when}`,
    emailHtml: `<p>${lines
      .map((l) => (l.startsWith('Your page') ? `Your page (details, contact us, request a new time): <a href="${htmlEsc(link)}">${htmlEsc(link)}</a>` : htmlEsc(l)))
      .join('<br>\n')}</p>`,
  };
}

// Install: empty and wipe the cabinets (BF-2639-067).
function buildInstallReminder({ appt, customer }) {
  return reminderMessage(
    'install',
    [
      'Please empty the cabinets completely and wipe them out before we arrive. If something in the back is stuck or heavy, leave it and we will help.',
      'Leave a clear walkway into the house and a small open spot to stage product. A small space is enough.',
    ],
    { appt, customer }
  );
}

// Estimate (design) visits: keep the do-not-empty instruction.
function buildEstimateReminder({ appt, customer }) {
  return reminderMessage('estimate', ['Please do not empty your cabinets - basic access to the space is all we need.'], { appt, customer });
}

// Every other type keeps the body it had before 1.8.1 (only the time is now ET).
function buildGenericReminder({ appt, customer }) {
  const when = etWhenLine(appt.scheduled_at);
  const link = appointmentUrl(appt.public_token);
  return {
    smsBody: `Reminder from ${BUSINESS_NAME}: you have a "${appt.type}" appointment on ${when}. No need to empty your cabinets - basic access is fine. Confirm, change, or cancel: ${link}`,
    emailSubject: `Reminder: your ${BUSINESS_NAME} appointment - ${when}`,
    emailHtml: `<p>Hi ${htmlEsc(customer.name)},</p>
    <p>This is a reminder of your upcoming appointment:</p>
    <p><strong>${htmlEsc(appt.type)}</strong><br>${when}</p>
    <p>You don't need to empty out your cabinets before we come by - basic access to the space is all we need.</p>
    <p><a href="${link}">Confirm, change, or cancel this appointment</a></p>
    <p>${BUSINESS_NAME}</p>`,
  };
}

function buildAppointmentReminder({ appt, customer }) {
  if (appt.type === 'Install') return buildInstallReminder({ appt, customer });
  if (ESTIMATE_APPT_TYPES.includes(appt.type)) return buildEstimateReminder({ appt, customer });
  return buildGenericReminder({ appt, customer });
}

// Fired by the reminders scheduler ahead of an appointment (spec G2, BF-2639-067).
async function onAppointmentReminder(appt) {
  const fullCustomer = db.getCustomer(appt.customer_id) || {};
  const customer = fullCustomer.id
    ? fullCustomer
    : { id: appt.customer_id, name: appt.customer_name, phone: appt.customer_phone, email: appt.customer_email };
  return notifyCustomer(customer, buildAppointmentReminder({ appt, customer }));
}

// Fired when a customer books their own appointment via the public page.
// Template is deliberately simple (spec G1) but no longer bare - it now says
// where and how long, and how to reach a person if something's wrong.
async function onAppointmentBooked(appt, customer) {
  const when = new Date(appt.scheduled_at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const firstName = (customer.name || '').split(' ')[0];
  const address = customer.address || 'the address on file';
  const duration = formatDuration(appt.duration_min);
  const body = `You're booked with ${BUSINESS_NAME}: "${appt.type}" on ${when} at ${address}. Questions? Call ${BUSINESS_PHONE}.`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `You're booked: ${appt.type}, ${when}`,
    emailHtml: `<p>Hi ${firstName},</p><p>You're booked for a ${appt.type} on ${when} at ${address}. It runs about ${duration}.</p><p>Need to change the time? Just reply to this email.</p><p>Andrew<br>${BUSINESS_NAME}</p>`,
  });
}

// ---- FF-2640-019: calendar invites ----
// After BOS writes a scheduled visit, BOS emails a calendar invite to the
// customer and one to Andrew (OWNER_NOTIFY_EMAIL), over the same Gmail path BOS
// already uses. Each email carries a simple .ics file. BOS does not connect to
// iCloud or any calendar account; the .ics is a plain attachment any calendar
// app can open. Without OWNER_NOTIFY_EMAIL, Andrew's copy is only logged.
function icsEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function buildVisitIcs(appt, customer) {
  const start = new Date(appt.scheduled_at);
  const end = new Date(start.getTime() + (Number(appt.duration_min) || 60) * 60000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsEscape(BUSINESS_NAME)}//BOS//EN`,
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appt.id}@bos`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(`${appt.type} - ${BUSINESS_NAME}${customer && customer.name ? ` - ${customer.name}` : ''}`)}`,
    customer && customer.address ? `LOCATION:${icsEscape(customer.address)}` : null,
    `DESCRIPTION:${icsEscape(`${appt.type} with ${BUSINESS_NAME}. Questions? Call ${BUSINESS_PHONE}.`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}
async function sendCalendarInvites(appt, customer) {
  if (!appt || (appt.status && appt.status !== 'scheduled')) return {};
  const ics = buildVisitIcs(appt, customer);
  const attachments = [{ filename: 'visit.ics', content: ics, contentType: 'text/calendar; charset=utf-8' }];
  const when = etWhenLine(appt.scheduled_at);
  const results = {};
  if (customer && customer.email) {
    results.customer = await sendEmail({
      to: customer.email,
      subject: `Calendar invite: ${appt.type}, ${when}`,
      html: `<p>Hi ${htmlEsc((customer.name || '').split(' ')[0] || 'there')},</p><p>Here is a calendar invite for your ${htmlEsc(appt.type)} on ${when}${customer.address ? ` at ${htmlEsc(customer.address)}` : ''}. Open the attached visit.ics file to add it to your calendar.</p><p>Andrew<br>${BUSINESS_NAME}</p>`,
      customer_id: customer.id,
      logMessage: db.logMessage,
      attachments,
    });
  }
  const ownerEmail = process.env.OWNER_NOTIFY_EMAIL;
  if (ownerEmail) {
    results.owner = await sendEmail({
      to: ownerEmail,
      subject: `Calendar invite: ${appt.type} with ${(customer && customer.name) || 'a customer'}, ${when}`,
      html: `<p>${htmlEsc(appt.type)} with ${htmlEsc((customer && customer.name) || 'a customer')} on ${when}${customer && customer.address ? ` at ${htmlEsc(customer.address)}` : ''}. The visit.ics file adds it to your calendar.</p>`,
      logMessage: db.logMessage,
      attachments,
    });
  } else {
    console.log(`[Calendar invite - OWNER_NOTIFY_EMAIL not set] Would email Andrew an invite for ${appt.type} on ${when}`);
  }
  return results;
}

module.exports = {
  buildVisitIcs,
  sendCalendarInvites,
  onLeadCreated,
  onJobCreated,
  onJobStatusChanged,
  onAppointmentReminder,
  buildAppointmentReminder,
  buildInstallReminder,
  buildEstimateReminder,
  ESTIMATE_APPT_TYPES,
  onAppointmentBooked,
  onOutOfAreaContact,
  notifyCustomer,
  notifyOwner,
  baseUrl,
  baseUrlIsLocal,
  bookingUrl,
  statusUrl,
  appointmentUrl,
};
