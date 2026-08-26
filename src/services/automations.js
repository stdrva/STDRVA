// Funnel automation triggers. Kept in one place so it's obvious what fires
// when. Each function is safe to call even if SMS/email aren't configured -
// the sms/email services fall back to console logging.
const db = require('../db');
const { sendSms } = require('./sms');
const { sendEmail } = require('./email');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';

function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function bookingUrl() {
  return `${baseUrl()}/book`;
}

function statusUrl(token) {
  return `${baseUrl()}/status/${token}`;
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

// Fired by the reminders scheduler ahead of an appointment.
async function onAppointmentReminder(appt) {
  const customer = { id: appt.customer_id, name: appt.customer_name, phone: appt.customer_phone, email: appt.customer_email };
  const when = new Date(appt.scheduled_at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const body = `Reminder from ${BUSINESS_NAME}: you have a "${appt.type}" appointment on ${when}. Reply if you need to reschedule.`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `Reminder: your ${BUSINESS_NAME} appointment - ${when}`,
    emailHtml: `<p>Hi ${customer.name},</p><p>This is a reminder of your upcoming appointment:</p><p><strong>${appt.type}</strong><br>${when}</p><p>Reply to this message or call us if you need to reschedule.</p>`,
  });
}

// Fired when a customer books their own appointment via the public page.
async function onAppointmentBooked(appt, customer) {
  const when = new Date(appt.scheduled_at).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const body = `You're booked with ${BUSINESS_NAME}: "${appt.type}" on ${when}. We'll send a reminder before your appointment.`;
  return notifyCustomer(customer, {
    smsBody: body,
    emailSubject: `Booking confirmed - ${BUSINESS_NAME}`,
    emailHtml: `<p>Hi ${customer.name},</p><p>You're booked!</p><p><strong>${appt.type}</strong><br>${when}</p><p>We'll send a reminder before your appointment.</p>`,
  });
}

module.exports = {
  onLeadCreated,
  onJobCreated,
  onJobStatusChanged,
  onAppointmentReminder,
  onAppointmentBooked,
  notifyCustomer,
  bookingUrl,
  statusUrl,
};
