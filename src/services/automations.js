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

// Fired by the reminders scheduler ahead of an appointment. Carries the extras
// the plain booking confirmation doesn't (spec G2): a cabinet-prep line, and
// private Confirm / Change / Cancel links. Reviews/referrals and the info-page
// link are explicitly out of scope for this pass.
async function onAppointmentReminder(appt) {
  const fullCustomer = db.getCustomer(appt.customer_id) || {};
  const customer = { id: appt.customer_id, name: appt.customer_name, phone: appt.customer_phone, email: appt.customer_email };
  const when = new Date(appt.scheduled_at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const link = appointmentUrl(appt.public_token);
  const body = `Reminder from ${BUSINESS_NAME}: you have a "${appt.type}" appointment on ${when}. No need to empty your cabinets - basic access is fine. Confirm, change, or cancel: ${link}`;
  const emailHtml = `<p>Hi ${customer.name},</p>
    <p>This is a reminder of your upcoming appointment:</p>
    <p><strong>${appt.type}</strong><br>${when}</p>
    <p>You don't need to empty out your cabinets before we come by - basic access to the space is all we need.</p>
    <p><a href="${link}">Confirm, change, or cancel this appointment</a></p>
    <p>${BUSINESS_NAME}</p>`;
  return notifyCustomer(fullCustomer.id ? fullCustomer : customer, {
    smsBody: body,
    emailSubject: `Reminder: your ${BUSINESS_NAME} appointment - ${when}`,
    emailHtml,
  });
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

module.exports = {
  onLeadCreated,
  onJobCreated,
  onJobStatusChanged,
  onAppointmentReminder,
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
