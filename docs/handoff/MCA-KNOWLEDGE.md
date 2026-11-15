# MCA knowledge: the business, Isaac's rules, and where each lives in the code

Facts here come from the owner, from `docs/DOMAIN.md`, and from the code. Anything from general trade knowledge or a web
search is marked **unverified**. Do not build on an unverified legal claim.

## What a merchant cash advance is

A funder **buys a slice of a business's future receivables at a discount**. It is not a loan. That is why the words matter:
using loan words is how a CRM gets dismissed by the people who must use it. `tests/language.test.ts` fails the build if
the UI says loan, lender, borrower, installment, interest rate, or "payment".

| Say                                               | Never say            |
| ------------------------------------------------- | -------------------- |
| advance, funding amount                           | loan, principal      |
| factor rate (1.32)                                | interest rate, APR   |
| payback (amount times factor)                     | amount due           |
| remittance (daily or weekly)                      | payment, installment |
| funder                                            | lender               |
| merchant                                          | borrower, customer   |
| position, stips, term, commission points, renewal |                      |

## The money maths (all in `src/lib/mca/funding.ts` and `src/lib/earnings/`)

- **Payback = amount times factor**, rounded half-up to the cent on integers (`paybackCents`). The database computes the same
  with a generated column, so the two always agree. Money is whole cents (bigint). Factor rate is `numeric(5,3)`, 1 to 3.
- **Remittances elapsed** since funding: daily counts business days Monday to Friday (holidays ignored), weekly counts 7-day
  blocks, biweekly 14-day blocks, monthly counts calendar months. **Paid to date** = min(payback, elapsed times remittance),
  unless Isaac typed a collected figure, which wins.
- **Renewal line**: a merchant is renewable once paid down about **50%** (`RENEWAL_PAYDOWN_PCT`). A funder can have its own
  percent (`renewal_paydown_pct`). Funding a deal creates a 30-day check-in timer and a renewal-call timer on the crossing day.
- **Hot lead**: paid in full in the last 30 days (`HOT_DAYS` in `src/lib/earnings/radar.ts`), unless do-not-contact.
- **Commission** is in points of the funded amount: the funder's own points if known, else Isaac's average. Typed text is
  parsed by `parseCommissionText` (a bare number under $20 is ambiguous and is asked about; `6%` means points; commas must be
  thousands separators). Earnings views: money still to arrive (funded, not yet received, 90-day window), pipeline value
  (best live offer, else estimated approval times average points), renewal forecast, price book from competing offers.

## The product rules Isaac asked for

1. **Every client always has a next date**, from one week to 36 months. Nobody leaves the system. Enforced in SQL functions,
   not just on screen: `replace_timers` refuses an empty list. A "lost" client still gets a date months out.
2. **Timers on every stage**, draggable board and follow-up buckets. 1 to 3 days means business days; longer is calendar days.
   Timer kinds: `follow_up`, `check_in`, `renewal`, `scheduled_call`, `chase` (one per funder submission, closes when that funder
   answers). A booked call is an appointment and survives a stage move until its day passes. Stage rules: `src/lib/mca/stages.ts`.
3. **Notes on everything.** Last call, last follow-up and next follow-up show on every card. The timeline is append-only.
4. **What he wanted, now and before**: the ask is stored as snapshots (newest is current).
5. **Offers, funder approvals, other advances (the position stack), competing offers, stips checkmarks, promise to pay.**
6. **Position matters** (1st, 2nd, 3rd). It is a field on offers and advances, never a note.
7. **One application fans out to many funders** (submissions). Each funder has its own appetite (revenue floor, time in
   business, max position, amount range, excluded states and industries, commission points). Most home-grown MCA CRMs model this
   one-to-one, which is wrong.
8. **Funded merchants** get check-in and renewal timers automatically. Paid in full goes to the renewal list. The one-click
   list "who is 50% paid down" is the heart of the business.
9. **Email**: Resend for reminders to Isaac; Gmail ("send as Isaac") for messages to merchants.
10. **Calls and texts**: click-to-call, and click-to-text through Google Voice or a plain `sms:` link. **No SMS API.** Whether the
    Text button opens the right app on Isaac's phone is unproven; only his phone can show it.
11. **Reminders** (added later): a booked time plus a channel (call, text or email), a bright tag on cards, an in-app banner, a
    browser notification, and the email names the channel. Setting one no longer moves the stage.
12. **Do not contact** is a switch the system enforces everywhere (`contact_status`: `ok`, `no_text`, `no_call`, `no_email`,
    `dnc`). `dnc` closes every timer, leaves one 36-month review timer, and stops reminders. Import never re-adds a trashed
    do-not-contact merchant. `contactAllowed()` in `src/lib/mca/contact.ts` is the one gate; reuse `<ContactActions>`.

## Two things called "Trash"

The stage with key `dead` is **labelled "Trash"** (a lost deal that is still alive and still has a next date). Separately, the **Trash page**
(`/trash`, `trashed_clients`, migration `0040_trash.sql`) is a soft delete: a trashed merchant is frozen and can be restored. They are not
the same thing. Do not merge them.

## Deliberately not built (do not drift; ask the owner first)

From `docs/BACKLOG.md` section 5: syndication, rep splits (row-level security is single-user), real file upload (needs a storage decision),
disclosure document generation (needs counsel), and an SMS API (the owner said no). Being told to "build what is missing" does not cover these.

## Personal and financial data (decided before any field existed)

- Never store bank logins or card numbers. SSN or EIN: last four only, and only with a written legal reason in `docs/DECISIONS.md`.
- Bank statements are documents: private object storage behind an authenticated link, never a column, never git. **Not built**:
  today "stips received" is a checkbox. A statement upload needs the owner's storage decision.
- Free text passes through `findSensitive` in `src/lib/data/sensitive.ts`. It reports a hit (an SSN, a card number, a full EIN, an account or
  routing number) and the zod schemas **refuse the save**. Only the CSV import path drops the offending value from that row and keeps the rest.
- Every table with merchant data has row-level security from the day it exists. Details and the exact policy shape:
  `docs/CREW-RULES.md` and `db/migrations/0001_init.sql`.

## Where the business logic lives

| Topic                                                                              | Files                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stages, timers, follow-up rules, the seven-stage fold (`foldStage`, `CORE_STAGES`) | `src/lib/mca/stages.ts`, `dates.ts`, `callback.ts`, `reminder.ts`                           |
| Advance maths, renewal dates                                                       | `src/lib/mca/funding.ts`, `src/lib/earnings/progress.ts`, `terms.ts`                        |
| Commission, expected earnings, renewal radar, price book                           | `src/lib/earnings/*`                                                                        |
| Do-not-contact                                                                     | `src/lib/mca/contact.ts`, migration `0002_do_not_contact.sql`                               |
| Funders, submissions, offers                                                       | migration `0010_funders.sql`, `src/lib/data/*`, `src/app/(app)/funders`                     |
| Import, backup, restore, merge duplicates                                          | `src/lib/data/import.ts`, `src/lib/export/*`, `scripts/restore-backup.ts`, `docs/BACKUP.md` |
| Lead intake (website forms, vendors)                                               | `src/lib/leads/*`, `docs/LEAD-INTAKE.md`                                                    |
| Reminder emails and the hourly job                                                 | `src/lib/system/reminders.ts`, `src/app/api/cron/reminders/route.ts`                        |
| Every database change                                                              | `db/migrations/*.sql` (0001 to 0280), applied in name order, each in its own transaction    |

## Regulation and legal (all unverified; ask counsel)

- Several states reportedly require commercial financing disclosures or broker registration (secondary sources named California,
  New York, Utah, Virginia, Florida, Georgia, Connecticut, Kansas, Missouri and Texas, and a Texas broker registration deadline at
  the end of 2026). None was confirmed from a primary source. The app generates **no** disclosure documents. Do not add any until
  the owner says which states Isaac writes in and counsel agrees.
- Texting merchants has consent rules (TCPA and state versions). The app blocks do-not-contact merchants and warns outside 8am to
  9pm. Whether his merchants consented is a legal fact, not a feature. A per-merchant consent date is on the backlog.

## Open questions for Isaac (still unanswered as far as this session knows)

Does he submit to outside funders, fund himself, or both? Which states? Which funders and what are their appetites? How many reps
and how are commission splits calculated? Does he need syndication tracking? Is he on Google Workspace or plain Gmail? What time
zone and what hour should the morning email arrive? What are his real stage names (the board now shows seven)?

## What MCA shops commonly buy tools for (general trade knowledge, unverified)

Bank-statement analysis (cash flow, existing positions, NSFs), e-signature for the application and contract, submitting to funders
through their portals or APIs, a merchant-facing upload link for statements, and call recording through a dialer. The first two
that fit this build are the statement upload link and storage.
