// Appointment reminder scheduler. Pure setInterval - no cron package needed.
// Every CHECK_INTERVAL_MIN minutes, it looks for scheduled appointments that
// are within REMINDER_HOURS_BEFORE hours of starting and haven't had a
// reminder sent yet, sends one, and marks it sent. Requires the Node process
// to stay running (that's true of any always-on deployment of this app).
const db = require('../db');
const { onAppointmentReminder } = require('./automations');

const CHECK_INTERVAL_MIN = Number(process.env.REMINDER_CHECK_INTERVAL_MIN || 15);
const REMINDER_HOURS_BEFORE = Number(process.env.REMINDER_HOURS_BEFORE || 24);

async function runOnce() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + REMINDER_HOURS_BEFORE * 60 * 60 * 1000);
  const upcoming = db.listAppointmentsBetween(now.toISOString(), cutoff.toISOString());
  for (const appt of upcoming) {
    if (appt.reminder_sent) continue;
    try {
      await onAppointmentReminder(appt);
      db.markReminderSent(appt.id);
      console.log(`[reminders] sent reminder for appointment ${appt.id} (${appt.customer_name})`);
    } catch (err) {
      console.error(`[reminders] failed for appointment ${appt.id}:`, err);
    }
  }
}

function start() {
  console.log(`[reminders] scheduler started - checking every ${CHECK_INTERVAL_MIN}min, reminding ${REMINDER_HOURS_BEFORE}h ahead`);
  runOnce().catch((err) => console.error('[reminders] initial run failed:', err));
  setInterval(() => {
    runOnce().catch((err) => console.error('[reminders] run failed:', err));
  }, CHECK_INTERVAL_MIN * 60 * 1000);
}

module.exports = { start, runOnce };
