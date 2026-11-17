# Selective CRM becomes a follow-up system (decided 2026-11-16)

The owner's decision: the CRM stops managing deals. Reps use it to **bring interested merchants in**: merchants who
showed interest but have not sent their documents yet. Nothing about a deal is worked here afterwards. Once a
merchant has sent what is needed, the rep takes the file out of the CRM and works it elsewhere. No deals are added to
the CRM; only interested merchants who have not sent their docs yet.

## What the system is for

Get a merchant from "interested" to "documents and signed application received", then hand them off. Everything on
screen serves that: capture the lead, chase the missing documents by email and by phone, stop chasing the moment the
merchant acts, tell the rep the moment something needs them, and show the manager who is bringing merchants in.

## Stays (the core)

- **Lead Intake**: the form, the Google Sheet phone lookup, paste-a-lead-line, bulk intake, the cross-rep duplicate and
  owner check, the welcome email with the upload and application links, consent and opt-out records, time zone from
  state or area code, the "call now" task.
- **Follow Up**: buckets and their sequences, blasts, the one-email-a-day rule, the local 9 to 11 window, holidays,
  the daily cap and the reserved slice, the legal footer and one-click unsubscribe, the DNS gate and the automation
  domain, stop rules (reply, upload, signature, opt-out, bounce, pause, delete), auto-moves between buckets as
  documents arrive, the call task after three silent emails, reply tags, template and bucket scores, the bounce-spike
  pause, personal and shared buckets with manager approval, the claim checker (it blocks "approved", "guaranteed"
  and similar; with no deals, "approved" is always blocked, which is right).
- **The merchant page**: details, notes, the call log with outcomes, follow-up timers, Call / Text / Email with the
  outcome prompt, documents (upload link, drag and drop, auto-label, freshness, the stips checklist), the application
  link and the signed application, the timeline.
- **Documents and the public pages**: the upload page, the application page, the unsubscribe page.
- **People**: reps and managers, the Team settings (add, change role, disable), the sign-in (Google or passcode),
  the theme switch.
- **Alerts**: the alert feed, the bell, the hourly alert email, the morning brief, the weekly scorecard.
- **Settings**: Me, Buckets & templates, Google Sheets, Team, Email (cap, domain, DNS), AI (kill switch, spend cap,
  reply tags, lead-line splitting).
- **Plumbing**: the outbox, sheets and inbox jobs (the inbox job only reads merchant replies and counts mail sent
  outside the CRM), the Netlify scheduled functions, the trash and restore, CSV import, export of the manager's own
  data.

## Goes

- **Deals**: submit to ops, the ops queue and kickbacks, My Deals and the deal page, the Submission Board, the deal
  status model, deal reminders.
- **Lenders**: the lender list and rules, send to lenders and the shotgun guard, chase and expiry, the lender inbox
  reader and the Review tray, offers and compare, reshop, pasted and screenshot offer import, asking a deal a
  question, the lender scoreboard.
- **Money**: FUND, the Funded sheet, commission plans, the ledger, clawback clocks, renewals and the renewal emails,
  month-end close and statements, lender payout tracking, the earnings, renewals and long-game pages, goals and pace
  (they were funded dollars).
- **Win-back**: the pools, the sequences, rescue nudges, the AI opener, the hot list, recovered money.
- **Trust and compliance**: the access log and copy logging, canaries, watermarked documents and expiring lender
  links, the leak tracer and backdoor score, the trust panel and trust alerts, the first-login policy, one-click
  offboarding with its report, state rules and registrations, dead-deal document retention.

## Decisions taken so the build could proceed (the owner can change any)

1. **The finish line is "Brought in".** When a merchant's file is complete (signed application and the required
   statements) the rep gets an alert and a "Hand off" button. Handing off marks the merchant as brought in, stops
   every sequence, takes them out of the buckets and counts on the dashboard. The managers get one email.
2. **The database schema stays.** The deal, lender, money, win-back and trust tables and functions are left in place,
   unused and harmless, so nothing is lost and nothing can break; a later migration can drop them. Only code, pages,
   automations and tests are removed.
3. **Cold gets its monthly nudge back.** The Cold bucket's own 30/60/90-day emails were removed when win-back took them
   over; with win-back gone they return.
4. **Roles: rep and manager.** Ops has no work left. The ops role stays in the database but is not offered.
5. **The dashboard measures bringing merchants in**: new leads, contacted, replied, docs requested, docs received,
   brought in, overdue follow-ups, speed to lead, per rep, the "do this now" list, the email meter.
6. **Texting and calling stay parked.**

## Status (2026-11-16, night)

Built on branch `scope/redesign`, in three parts that were merged there:

1. **Removal** (`scope/follow-up`): the deal, lender, money, win-back and trust pages, automations, code and tests are
   gone; the schema is untouched.
2. **The finish line and the numbers** (`scope/handoff`): migration `0540_hand_off.sql` (`clients.brought_in_at`,
   `hand_off`, `undo_hand_off`, no automated mail after a hand-off, "Ready to hand off", Cold's nudge), the Hand off
   action, and `loadOverview` behind the Overview.
3. **The interface** (`scope/redesign`): the whole app rebuilt in the look in `docs/DESIGN.md`: a dropdown sidebar,
   New lead as a sheet instead of a page, and every page redone.

Decision 1 as built: Hand off is on the merchant page, on each row and in the merchant sheet in Follow Up, and in
bulk; it can be undone. It is the rep's press, not automatic. Reaching "Ready to hand off" sends the rep one "File
complete" alert (`0543_engine_fixes.sql`); a handed-off merchant cannot be put back in a bucket until the hand-off is
undone, and a "not now" reply does not re-open their chase.
