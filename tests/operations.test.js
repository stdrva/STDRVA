const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');

test('follow-up lifecycle: create -> open list -> close, all logged', () => {
  const c = db.createCustomer({ name: 'Followup Cust' });
  const f = db.createFollowup({ customer_id: c.id, title: 'Send estimate', due_at: '2026-09-10T13:00:00Z', created_by: 'user' });
  assert.equal(db.listFollowups(c.id).length, 1);
  assert.ok(db.listOpenFollowups().some((x) => x.id === f.id));
  db.closeFollowup(f.id, 'done', 'user:andrew');
  assert.equal(db.listFollowups(c.id).length, 0); // open only
  assert.equal(db.listFollowups(c.id, { includeClosed: true }).length, 1);
  assert.equal(db.getFollowup(f.id).status, 'done');
  assert.ok(db.listActivityForCustomer(c.id).some((a) => a.entity_type === 'followup' && a.new_value === 'done'));
});

test('appointment reschedule clears reminder flag and logs a "rescheduled" activity', () => {
  const c = db.createCustomer({ name: 'Appt Cust' });
  const a = db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2026-09-20T18:00:00Z' });
  db.markReminderSent(a.id);
  assert.equal(db.getAppointment(a.id).reminder_sent, 1);
  db.updateAppointment(a.id, { scheduled_at: '2026-09-22T18:00:00Z' }, { actor: 'user' });
  assert.equal(db.getAppointment(a.id).reminder_sent, 0);
  assert.ok(db.listActivityForCustomer(c.id).some((x) => x.field === 'rescheduled'));
});

test('completing an appointment stamps completed_at', () => {
  const c = db.createCustomer({ name: 'Complete Cust' });
  const a = db.createAppointment({ customer_id: c.id, type: 'Design Review', scheduled_at: '2026-09-01T18:00:00Z' });
  db.setAppointmentStatusTracked(a.id, 'completed', { actor: 'user' });
  const fresh = db.getAppointment(a.id);
  assert.equal(fresh.status, 'completed');
  assert.ok(fresh.completed_at);
});

test('past scheduled appointment shows up as needing attention', () => {
  const c = db.createCustomer({ name: 'Missed Cust' });
  db.createAppointment({ customer_id: c.id, type: 'Short Design Consultation', scheduled_at: '2020-01-01T18:00:00Z' });
  assert.ok(db.listPastUncompletedAppointments().some((x) => x.customer_id === c.id));
});

test('file soft-delete: hidden from lists + search, restorable', () => {
  const c = db.createCustomer({ name: 'File Cust' });
  const fid = db.createCustomerFile({ customer_id: c.id, stored_name: 'x.pdf', original_name: 'measure-sheet.pdf', mime_type: 'application/pdf' });
  assert.equal(db.listCustomerFiles(c.id).length, 1);
  assert.ok(db.searchFiles('measure').some((r) => r.id === fid));
  db.softDeleteCustomerFile(fid, 'user:andrew');
  assert.equal(db.listCustomerFiles(c.id).length, 0);
  assert.equal(db.searchFiles('measure').length, 0);
  assert.ok(db.listDeletedFiles().some((r) => r.id === fid));
  db.restoreCustomerFile(fid, 'user:andrew');
  assert.equal(db.listCustomerFiles(c.id).length, 1);
  assert.ok(db.searchFiles('measure').some((r) => r.id === fid));
});

test('expense capture: obvious merchant -> suggested account, no review flag', () => {
  const id = db.createExpense({ amount: 84.27, merchant: "Lowe's", memo: 'cabinet hinges', entry_source: 'assistant', created_by: 'assistant' });
  const e = db.getExpense(id);
  assert.equal(e.coa_account, 'Cabinet Hardware');
  assert.equal(e.needs_review, 0);
  assert.equal(e.entry_source, 'assistant');
});

test('expense capture: uncertain -> Uncategorized / Needs Review, never a guessed category', () => {
  const id = db.createExpense({ amount: 200, merchant: 'Unknown Vendor LLC', memo: 'stuff', created_by: 'assistant' });
  const e = db.getExpense(id);
  assert.equal(e.coa_account, null);
  assert.equal(e.needs_review, 1);
  assert.ok(db.listUncategorizedExpenses().some((x) => x.id === id));
});

test('expense: future bank import can be matched, not duplicated', () => {
  const id = db.createExpense({ amount: 149.99, merchant: 'DeWalt', memo: 'circular saw', expense_at: '2026-05-10T00:00:00Z', created_by: 'user' });
  const candidates = db.findExpenseMatchCandidates({ amount: 149.99, date: '2026-05-11T00:00:00Z' });
  assert.ok(candidates.some((x) => x.id === id), 'a same-amount nearby expense with no external_ref is a match candidate');
});

test('marketing attribution is append-only: original preserved after re-attribution', () => {
  const src1 = db.createSource({ name: 'Google' });
  const src2 = db.createSource({ name: 'Home Show' });
  const c = db.createCustomer({ name: 'Attr Cust', source_id: src1.id });
  db.setCustomerAttribution({ customer_id: c.id, source_id: src2.id, note: 'actually met at the show', actor: 'user:andrew' });
  const a = db.getCustomerAttribution(c.id);
  assert.equal(a.original.source_id, src1.id, 'original attribution unchanged');
  assert.equal(a.current.source_id, src2.id, 'current attribution updated');
  assert.ok(a.history.length >= 2);
  assert.equal(db.getCustomer(c.id).source_id, src2.id, 'fast-path column follows current');
});

test('campaign tracking phone is stored normalized and is reverse-lookup-able', () => {
  const src = db.createSource({ name: 'Reach' });
  const camp = db.createCampaign({ source_id: src.id, name: 'Q1', tracking_phone: require('../src/util').normalizePhone('(804) 555-0142') });
  const found = db.findCampaignByTrackingPhone('+18045550142');
  assert.ok(found);
  assert.equal(found.id, camp.id);
});
