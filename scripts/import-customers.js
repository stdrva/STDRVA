// One-time import: cleans up test bookings and loads the real customer/lead/
// appointment/job data reconciled from Setmore (contacts export + activity
// log + Andrew's verbal corrections, as of 2026-08-29).
//
// Run this ONCE from the repo root on the live instance (Render Shell):
//   node scripts/import-customers.js
//
// Safe to re-run: it looks up each customer by phone before creating, so it
// won't duplicate anyone already in the database.

const db = require('../src/db');

function log(msg) {
  console.log(`[import] ${msg}`);
}

// ---------- 1. Clean up test data ----------
function cleanupTestData() {
  const testCustomers = db.db.prepare(`SELECT id, name FROM customers WHERE name LIKE '%dummy%' COLLATE NOCASE`).all();
  for (const c of testCustomers) {
    db.db.prepare(`DELETE FROM messages WHERE customer_id = ?`).run(c.id);
    db.db.prepare(`DELETE FROM appointments WHERE customer_id = ?`).run(c.id);
    db.db.prepare(`DELETE FROM jobs WHERE customer_id = ?`).run(c.id);
    db.db.prepare(`DELETE FROM leads WHERE customer_id = ?`).run(c.id);
    db.db.prepare(`DELETE FROM customers WHERE id = ?`).run(c.id);
    log(`deleted test customer "${c.name}" and related records`);
  }
}

// ---------- 2. Helper to create-or-find a customer, then a lead ----------
function upsertCustomerAndLead({ name, phone, email, address, custNotes, stage, source, leadNotes }) {
  let customer = phone || email ? db.findCustomerByPhoneOrEmail(phone, email) : null;
  if (!customer) {
    customer = db.createCustomer({ name, phone, email, address, notes: custNotes });
    log(`created customer: ${name}`);
  } else {
    log(`customer already exists, skipping create: ${name}`);
  }
  const existingLeads = db.listLeads().filter((l) => l.customer_id === customer.id);
  let lead = existingLeads[0];
  if (!lead) {
    lead = db.createLead({ customer_id: customer.id, stage, source: source || 'Setmore import', notes: leadNotes });
    log(`  created lead (${stage}) for ${name}`);
  }
  return { customer, lead };
}

function maybeCreateJob({ customer, lead, status, sold_amount, notes }) {
  const existingJobs = db.listJobs().filter((j) => j.customer_id === customer.id);
  if (existingJobs.length) return existingJobs[0];
  const job = db.createJob({ lead_id: lead.id, customer_id: customer.id, sold_amount, notes });
  if (status && status !== 'Order Confirmed') db.updateJobStatus(job.id, status, 'Set during data import');
  log(`  created job (${status}) for ${customer.name}`);
  return job;
}

function maybeCreateAppointment({ customer, lead, type, scheduled_at, duration_min, notes }) {
  const existing = db.listAppointments().filter((a) => a.customer_id === customer.id);
  if (existing.some((a) => a.scheduled_at === scheduled_at)) return;
  db.createAppointment({ customer_id: customer.id, lead_id: lead.id, type, scheduled_at, duration_min, notes });
  log(`  created appointment (${type}) for ${customer.name} at ${scheduled_at}`);
}

// ---------- 3. The real data ----------
function run() {
  cleanupTestData();

  const people = [
    // --- Done / no action needed ---
    { name: 'Alberta Johnson', phone: '+18047450287', address: '4149 Ambergrove Ave, Richmond, VA 23236',
      stage: 'Sold', jobStatus: 'Complete',
      notes: 'Paid in full, finished, happy. Snail-mail only - no follow-up possible/needed.' },
    { name: 'Elmore Becker', phone: '+15402204758', address: '7617 River Rd, Fredericksburg, VA 22407',
      stage: 'Sold', jobStatus: 'Complete',
      notes: 'Paid in full, finished, happy, left a review.' },
    { name: 'Erica Lucke', phone: '+18045147330', email: 'erica.lucke@gmail.com', address: '7325 Hermitage Road, Henrico, VA 23228',
      stage: 'Sold', jobStatus: 'Complete',
      notes: 'Installed, paid in full, happy, left a review.' },
    { name: 'Andy Reinhardt', phone: '+18042482009', address: '6110 St. Andrews Ln',
      stage: 'Sold', jobStatus: 'Complete',
      notes: 'Finished, happy. Needs a follow-up visit scheduled for final finishing touches (no date set yet).' },
    { name: 'Gwen Burrows', phone: '+12036107253', address: '4800 Grove Ave',
      stage: 'Sold', jobStatus: 'Complete',
      notes: 'Paid in full and happy, job complete, no build needed.' },

    // --- In process / sold, active jobs ---
    { name: 'Leora Copeland', phone: '+18045430608', email: 'leoracva@gmail.com', address: '3006 Garrett St., Richmond, VA 23221',
      stage: 'Sold', jobStatus: 'Order Confirmed',
      notes: 'Deposit paid. Promised 6-8 weeks from ~7/26-27 contract. Drawers not started - needs next production batch. Measurements not yet uploaded (paper measures pending from Andrew).' },
    { name: 'John Walker', phone: '+17035876124', email: 'jrlwalkersr@gmail.com', address: '2118 Tuckahoe Bridge Dr, Manakin Sabot, VA 23103',
      stage: 'Sold', jobStatus: 'Measured',
      notes: 'Deposit paid. Fully measured (order form Measure tab has complete A/B/mount data for all 14 lines) - ready to build, queued for next batch.' },
    { name: 'Sally Guynn', phone: '+13042791345', email: 'sally@guynngroup.com', address: '8140 Greystone Cir E, Henrico, VA 23229',
      stage: 'Sold', jobStatus: 'Measured', soldAmount: null,
      notes: 'Deposit paid ($3,500). ON HOLD - waiting on Andrew\'s shop time (cutting painted door/wood parts for painter) before glide-outs can be built. Real scope is 4 units: 3 blind-corner + 1 spice pull-out; rest of order is cabinet/paint work. Measure data already on file for the 3 BC units and partial for the spice pull-out.' },
    { name: 'John White', phone: '+18044023557', email: 'john.white24@gmail.com', address: '7101 University Drive, Henrico, VA 23229',
      stage: 'Sold', jobStatus: 'Measuring Scheduled', soldAmount: 7365,
      notes: 'Deposit paid, balance still due (needs to deposit his check). Contract confirmed $7,365, no change order. ~29 hinge swaps + pantry redo scope - 2hr consult booked 9/3 to finish scoping. Told 6 weeks from 8/22 contract date.' },
    { name: 'Seth Gibson', phone: '+18647530189', email: 'bluedog.alliance@gmail.com', address: '14609 Ashlake Manor Dr, Chesterfield, VA 23832',
      stage: 'Sold', jobStatus: 'Ready for Install',
      notes: 'Deposit made. Install confirmed Fri 9/11/26, 3-hour block starting 9:00 AM.' },
    { name: 'Linda Walter', phone: '+16155258889', email: 'lindawalter@comcast.net', address: '2956 Hathaway Rd # 610, Richmond, VA 23225',
      stage: 'Sold', jobStatus: 'Order Confirmed',
      notes: 'Paid customer, got a discount - financials need Andrew\'s hand notes to reconcile (deposit shows $468.35 in her file). No consult was ever logged in Setmore (system gap, not a service gap) - Andrew has independently confirmed she is a real paying customer.' },

    // --- Active leads / funnel, not yet sold ---
    { name: 'Pat Hutchinson', phone: '+18042418533', email: 'phutch572@gmail.com', address: '8122 Wheelwright Way, Mechanicsville, VA 23111',
      stage: 'Contacted',
      notes: 'Consult done 8/21. Estimate NOT yet sent (correction from earlier read) - needs a price and direct contact from Andrew ASAP. Andrew believes she will go for it once she has it.' },
    { name: 'Peter Suyama', phone: '+17039198184', address: '833 Woodcove Ct, VA 23103',
      stage: 'Contacted',
      notes: 'Long consult 5/7. Showed strong buying signals, timing was wrong - needs re-approach follow-up.' },
    { name: 'Matthew McCurdy', phone: '+17085523177', email: 'matt@mccurdyfamily.net', address: '10120 Peach Blossom Road, Mechanicsville, VA 23116',
      stage: 'Contacted',
      notes: 'Consult 8/17. Possibly a secret shopper - needs a bunch of follow-up.' },
    { name: 'Marc Huckabone', phone: '+17032200660', email: 'marc.huckabone@gmail.com', address: '1502 Claremont Avenue, Richmond, VA 23227',
      stage: 'Contacted',
      notes: 'Met at Richmond Home Show (8/15-16), consult 8/27. Estimate still in process, needs to be sent.' },
    { name: 'Debra Nelson', phone: '+14074618878', email: 'ananaof2@gmail.com', address: '11718 Kings Pond Drive, Providence Forge, VA 23140',
      stage: 'Contacted',
      notes: 'Consult 8/18. Andrew needs to review her drawing/contract - needs a price and direct contact ASAP.' },
    { name: 'Kelly Pierce', phone: '+13016134329', email: 'kellypierce813@gmail.com', address: '13309 Garland Lane, Midlothian, VA 24114',
      stage: 'Lost',
      notes: 'Cancelled her only consult (booked 8/13, cancelled 8/11) with no further activity since. Andrew to decide: win-back call or leave as Lost.' },
    { name: 'Sarah Jordan', phone: '+18282602042', email: 'jordansr99@gmail.com', address: '10071 Berry Pond Lane, Mechanicsville, VA 23116',
      stage: 'Contacted',
      notes: 'FLAG: found in the Setmore activity log (consult rescheduled twice, landing on 8/14 5:45pm) but missing from the reconciled status list built earlier - her outcome/status needs Andrew to confirm.' },

    // --- New leads, upcoming consults ---
    { name: 'Karen Washington', phone: '+18042405379', email: 'kwash825@gmail.com', address: '12492 Golansville Rd, Ruther Glen, VA 22546',
      stage: 'New Lead', notes: 'New lead, consult booked 9/3/26 12:00pm.',
      appt: { type: 'Short Design Consultation', when: '2026-09-03T12:00:00', duration: 60 } },
    { name: 'Keith Larkin', phone: '+18046247481', email: 'antler0816@yahoo.com', address: '12153 Manor Glen Lane, Glen Allen, VA 23059',
      stage: 'New Lead', notes: 'New lead, consult booked 11/2/26 10:00am.',
      appt: { type: 'Short Design Consultation', when: '2026-11-02T10:00:00', duration: 60 } },
    { name: 'Vanessa Hanshaw', phone: '+17573349116', email: 'thehanshaws@gmail.com', address: '2119 Creek Bottom Way, North Chesterfield, VA 23236',
      stage: 'New Lead', notes: 'New lead, consult booked 9/8/26 11:00am.',
      appt: { type: 'Short Design Consultation', when: '2026-09-08T11:00:00', duration: 60 } },
    { name: 'John Huber', phone: '+17573528904', email: 'huberjr@earthlink.com', address: '5003 Kings Pond Ct., Providence Forge, VA 23140',
      stage: 'New Lead', notes: 'New lead, consult booked 9/5/26 10:00am.',
      appt: { type: 'Short Design Consultation', when: '2026-09-05T10:00:00', duration: 60 } },
    { name: 'Esmeralda Maida', phone: '+18043143023', email: 'esmaida912@gmail.com', address: '7979 Wistar Woods Ct, Henrico, VA 23228',
      stage: 'New Lead', notes: 'New lead, consult booked 10/1/26 1:30pm.',
      appt: { type: 'Short Design Consultation', when: '2026-10-01T13:30:00', duration: 60 } },
    { name: 'Dan Heath', phone: '+18083655353', email: 'd_heath@att.nef', address: '200 Promise Lane, Bumpass, VA 23024',
      stage: 'New Lead', notes: 'New lead, consult booked 9/3/26 5:30pm.',
      appt: { type: 'Short Design Consultation', when: '2026-09-03T17:30:00', duration: 60 } },

    // --- Kept test contact (per Andrew - used for newsletter testing) ---
    { name: 'Patrick Harris (test)', stage: 'New Lead',
      notes: 'Sample/test contact only - not a real lead. Kept intentionally for testing newsletters.' },
  ];

  for (const p of people) {
    const { customer, lead } = upsertCustomerAndLead({
      name: p.name,
      phone: p.phone,
      email: p.email,
      address: p.address,
      custNotes: p.notes,
      stage: p.stage,
      leadNotes: p.notes,
    });

    if (p.jobStatus) {
      maybeCreateJob({ customer, lead, status: p.jobStatus, sold_amount: p.soldAmount || null, notes: p.notes });
    }

    if (p.appt) {
      maybeCreateAppointment({
        customer,
        lead,
        type: p.appt.type,
        scheduled_at: new Date(p.appt.when).toISOString(),
        duration_min: p.appt.duration,
        notes: p.notes,
      });
    }
  }

  // These two are still-active appointments for people who already have a
  // job/lead created above with a different notes shape - handled separately
  // so the big loop above stays simple.
  const white = db.findCustomerByPhoneOrEmail('+18044023557', null);
  if (white) {
    const whiteLead = db.listLeads().find((l) => l.customer_id === white.id);
    maybeCreateAppointment({
      customer: white,
      lead: whiteLead,
      type: 'Long Design Consultation',
      scheduled_at: new Date('2026-09-03T13:30:00').toISOString(),
      duration_min: 120,
      notes: 'Scoping the hinge-swap/pantry redo work.',
    });
  }
  const gibson = db.findCustomerByPhoneOrEmail('+18647530189', null);
  if (gibson) {
    const gibsonLead = db.listLeads().find((l) => l.customer_id === gibson.id);
    maybeCreateAppointment({
      customer: gibson,
      lead: gibsonLead,
      type: 'Install',
      scheduled_at: new Date('2026-09-11T09:00:00').toISOString(),
      duration_min: 180,
      notes: 'Install day.',
    });
  }

  log('Import complete.');
}

run();
