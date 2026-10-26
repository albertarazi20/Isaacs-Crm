# Review 3A — adversarial review of today's money and database code (funders, earnings, lead intake, chase/move, trash fixes)

Scope: `db/migrations/{0010_funders,0020_earnings,0040_trash,0070_keep_chase_on_move,0080_lead_tokens,0090_review_fixes}.sql`; `src/lib/funders/**`, `src/app/funders-actions.ts`,
`src/components/funders/**`, `src/components/client/{SubmissionsCard,FundingCard}.tsx`; `src/lib/earnings/**`, `src/app/earnings-actions.ts`, `src/components/earnings/**`,
`src/app/(app)/{earnings,renewals}/page.tsx`; `src/lib/leads/**`, `src/lib/system/leads.ts`, `src/app/api/leads/route.ts`, `src/app/lead-actions.ts`.
Also read because the lead route now calls them: `0100_new_lead_alert.sql`, `src/lib/system/leadAlert.ts`, `src/lib/funders/package.ts`.
Read at HEAD `0ddf0ab` (it moved four times while I worked: `be0645f`, `b393d54`, `e85ed7d`, `0ddf0ab`) plus the uncommitted working tree.
Every repro below was re-run at `0ddf0ab`. Nothing under `src/`, `db/`, `tests/`, `e2e/` was edited. I read `docs/REVIEW-3B.md` only after the repros were done, to avoid repeating it; the one overlap (its B-1 item 2) is named in A-22.
Existing suites for this scope pass: `npx vitest run tests/review-fixes.test.ts tests/leads-db.test.ts tests/chase-move.test.ts tests/earnings-db.test.ts` → 4 files, 66 tests passed.

How things were verified: tsx scripts against throwaway databases (`r3_*`, created and dropped by each script; Postgres on localhost:5433; `isaac_dev` never opened). The scripts live outside the repo in
`/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/r3/`. Run one with `cd /home/user/Isaac && npx tsx <that dir>/<file>.mts`. `h.mts` is the shared helper (migrates a fresh DB;
`mk(true)` makes a UTF8 + `C.utf8` database like a hosted one, `mk(false)` makes the SQL_ASCII database `tests/helpers/db.ts` makes). The route repros call the real `POST` from `src/app/api/leads/route.ts` with a `Request`.
Labels: CONFIRMED = I reproduced it; LIKELY = argued from code; QUESTION = needs a decision.

Counts: 0 blocker, 8 bug, 9 risk, 5 nit.

What did not turn up: no cross-user read or write through any table, view or function (matrix in "Looked at and fine"), no way to reach zero open timers on a live merchant or an open timer on a trashed one
(about 10,000 randomised operations, below), no SECURITY DEFINER, no unscoped RLS-bypass query. The bugs are in what the numbers mean, in lead intake under concurrency and bad input, and in the edit path.

---

## Bugs

### A-1 [bug] Lead intake: the same lead arriving twice at once creates duplicate cards, and some of the requests die in a deadlock answered as "400"

**Status:** CONFIRMED (`leads2.mts` case d, three runs)

**Where:** `src/lib/leads/intake.ts:24` (look up, then create, no lock between), `:32-44` (`addNote` then `set_follow_up`), `src/app/api/leads/route.ts:63-65` (every exception becomes 400).

**Why it matters:** a webhook sender that fires twice (Zapier retries, a form double-submit, a vendor re-posting after a timeout) is the normal case for lead delivery, not the exception. Two requests that both find no match both create a card, so Isaac gets two "call now" cards for one merchant.
Two requests that both find the existing merchant deadlock: `addNote` inserts an `activities` row (a `KEY SHARE` lock on the `clients` row through the foreign key), then both ask `set_follow_up` for `FOR UPDATE` on the same row, and each waits for the other.
Postgres kills one with 40P01. The sender is told "400 Something went wrong — try again", which says "do not retry as is", for an error a retry would have fixed.

**Repro/evidence:** 12 simultaneous POSTs of `{"businessName":"Twin Pizza","phone":"3057770000"}` on one token, three runs: 6 cards created / 2 "duplicate" / 4 answered 400; 4 / 2 / 6; 3 / 1 / 8. It should be 1 card and 11 "duplicate".
Server log: `deadlock detected … while locking tuple in relation "clients" … SQL statement "select * from clients where id = p_client for update" PL/pgSQL function set_follow_up(uuid,date,text) line 4`.
A single sequential retry correctly becomes a "duplicate" (tested in `tests/leads-db.test.ts`), so only the concurrent case is broken, and no test is concurrent.

**Suggested fix:** take `pg_advisory_xact_lock(hashtext(user_id || normalized_phone))` at the top of `ingestLead`, and call `set_follow_up` before `addNote` (or `select … for update` on the card first). Answer 40P01/40001 with 503 + `Retry-After`.

---

### A-2 [bug] Lead intake: a lead with the same business name but a different phone is swallowed, and its phone, email, contact and amount are thrown away

**Status:** CONFIRMED (`leads1.mts`, `leads3.mts`)

**Where:** `src/lib/data/queries.ts:125-130` (`findDuplicates` matches on normalised name OR phone, always), `src/lib/leads/intake.ts:26-45` (the duplicate branch stores only a note), `docs/LEAD-INTAKE.md:27` ("same phone, or same business name **when there's no phone**").

**Why it matters:** "Subway", "Mike's Pizza" and "Main Street Auto" are many different merchants. The second one is reported "duplicate", gets no card, and the only trace is a note reading "Came in again". Its phone number, email, contact name and wanted amount are not saved anywhere.
It is a lost lead in a business where speed to lead is the metric, and the sender is told it was handled. Worse, the first Subway's follow-up is moved to today and Isaac calls the wrong merchant.
The docs promise name matching only when there is no phone; the code does not do that.

**Repro/evidence:** card "Mike's Pizza" (305-555-0100); POST `{"businessName":"mikes pizza","phone":"786-555-9999"}` → `200 duplicate`, `clients` still has one row with the old phone, notes `["Came in again"]`.
At `e85ed7d`: POST `{"businessName":"Subway","phone":"786-555-0199","email":"owner@othersubway.example","contactName":"Dana","wantedAmount":"80k"}` after a first Subway → `200 duplicate`, nothing of the second one stored.

**Suggested fix:** match on name only when the lead has no phone (as documented), or when it does, create the new card and mention the possible match in a note. Either way, put the lead's phone/email/contact/amount into the note rather than dropping them, and return the matched `reason`.

---

### A-3 [bug] Lead intake: a JSON `null` on any optional field rejects the whole lead as "Invalid input"

**Status:** CONFIRMED (`leads3.mts` cases 3 and 4, `schema.mts`)

**Where:** `src/lib/leads/schema.ts:5-9, 17-25` (`str(max).optional()` accepts a missing key but not `null`).

**Why it matters:** form tools, Zapier/Make mappings and most CRMs serialise an empty field as `"email": null`. `{"businessName":"X","phone":"3055550111","email":null}` is the most ordinary payload there is, and it is refused with `400 {"error":"Invalid input"}`.
The message names no field (zod's union error), so the sender cannot tell which one to fix. Every lead from such a sender with any blank field is lost until someone debugs it.

**Repro/evidence:** `{"businessName":"Nully","phone":"305-555-0111","email":null}` → `400 Invalid input`; `{"businessName":"Nully2","phone":"305-555-0112","contactName":null,"notes":null}` → `400 Invalid input`; `{"phone":true,…}`, `{"phone":["1"],…}`, `{"wantedAmount":{}}` → the same bare "Invalid input".

**Suggested fix:** `z.preprocess(v => v === null ? undefined : v, …)` (or `.nullish()`), and put the field name in the error (`path.join('.')`).

---

### A-4 [bug] Renewals: "Ready to renew" and its dollar total include merchants who said no and merchants marked do-not-contact

**Status:** CONFIRMED (`earn.mts`)

**Where:** `src/lib/earnings/radar.ts:106-127` (every card with an `active` advance and enough paid down is listed, whatever its stage or contact status), `src/lib/earnings/expected.ts:187-200` (same for the forecast), `src/lib/data/mutations.ts:186-189` (only the move to Paid in full ever changes `fundings.status` away from `active`; a move to Not interested, Lost, Dead or Killed does not).

**Why it matters:** the renewal call is Isaac's best lead list and "~$X renewal commission" is the number he reads off it. A merchant who answered the renewal call with "not interested", and was moved to Not interested (12-month timer), stays at the top of the list for good, marked "Not contacted since eligible" if he never logged a touch, and counted in the total.
A do-not-contact merchant is listed with the call buttons disabled but is still counted. Isaac is shown work that cannot be done and money that cannot be earned.

**Repro/evidence:** four funded merchants all past 50%: A moved to `not_interested`, B set `dnc`, C untouched, D in a renewal deal (A-5). `buildRadar` → `ready` = `["D Renewing now [offers_in/ok]", "A Declined Renewal [not_interested/ok]", "B Do Not Contact [funded/dnc]", "C Control [funded/ok]"]`,
`totals.expectedCents` = 1,600,000 ($16,000) when only C ($4,000) is a real call. "Renewals still to come" lists the same four.

**Suggested fix:** exclude exit stages (`declined`…`not_interested`, `written_off`) and `contact_status = 'dnc'` from the radar and forecast (or flip the advance to `paid_off`/`lapsed` when the deal leaves the funded group), and show the excluded count in one muted line.

---

### A-5 [bug] Earnings: one renewal is counted in both "Renewals still to come" and "Deals close to funding"

**Status:** CONFIRMED (`earn.mts`)

**Where:** `src/lib/earnings/expected.ts:102-103` (pipeline = stage in Offers in / Offer presented / Contract out, no look at the merchant's existing advance), `:187-200` (forecast = every `active` advance), `src/app/(app)/earnings/page.tsx:116-135` (the two tiles side by side).

**Why it matters:** when Isaac works a renewal he moves the merchant back into the funding pipeline, and the old advance stays `active` until `record_funding` marks it `renewed`. For that whole stretch the same merchant is $4,000 in the renewal tile and $4,800 in the pipeline tile. Nothing sums the tiles, but he reads them together as "what is coming".

**Repro/evidence:** merchant D funded 90 days ago (active, $4,000 entered commission), moved to Application in, sent to a funder, offer of $60,000 recorded → stage `offers_in`. `buildEarnings`: `renewals.rows` contains D (`~$4,000`) and `pipeline.deals` contains D (`$4,800`).

**Suggested fix:** drop an advance from the forecast when its merchant is at a pipeline stage (the deal row already prices it), or mark the row "renewal in progress" and leave it out of the tile total.

---

### A-6 [bug] Price book: one deal can be three "prices", so a single merchant produces an average

**Status:** CONFIRMED (`earn.mts`)

**Where:** `src/lib/earnings/pricebook.ts:32-66` (every funded advance, every offer of any status, and every competing offer is an observation), `src/components/earnings/PriceBook.tsx:199` (all three sources on by default), `src/lib/earnings/pricebook.ts:5` (`MIN_SAMPLE = 3`).

**Why it matters:** the rule "below three prices show no average — three is the least that is not an anecdote" is defeated by counting one price more than once. An accepted offer and the advance funded from it are the same price; the other funder's lower-ranked offer is a third. "Based on 3 prices, the average factor is 1.36" can come from one merchant.
`accept_offer` keeps no link to the funding (no `offer_id` on `fundings`), so the app cannot dedupe them.

**Repro/evidence:** merchant E: two funders offered 1.35 and 1.38, Isaac accepted the 1.35 and funded it at 1.35. `observations()` → `funded:1.35, offer:1.35, offer:1.38`; `groupFactors` → `{n: 3, average: 1.36}`. One deal, an average shown.

**Suggested fix:** store the accepted offer id on the funding and drop the offer from the offer source once it is funded (or count one price per merchant per source); default the book to a single source.

---

### A-7 [bug] `update_funding_terms`: correcting the funded date of the latest advance can demote it, so the renewal call does not move and the card flips to the older advance

**Status:** CONFIRMED (`upd.mts` S1)

**Where:** `db/migrations/0020_earnings.sql:299-302` (`is_latest` is computed AFTER the update), `:303-320` (the renewal call is only re-derived when `is_latest`), `src/components/client/FundingCard.tsx` (the dialog says "Saving moves the renewal call" for the card it was opened on).

**Why it matters:** this is the typo Isaac will make: the funded year or month. If the corrected date is earlier than the previous advance's, the row stops being the newest, the function treats it as "an older advance", and moves nothing.
The renewal timer stays on the date the wrong terms gave (a wrong call date for real money). `client_cards` then picks the older advance as current: the card shows the `renewed` one and its funded date. The timeline says "Past advance … terms corrected", which is wrong in the other direction.

**Repro/evidence:** advance 1 funded 200 days ago (renewed), advance 2 funded 10 days ago, active, renewal timer 2027-01-05. `update_funding_terms(adv2, {"funded_on": <300 days ago>})` → open timers unchanged (`check_in 2026-11-22`, `renewal 2027-01-05`); the date the new terms give is 2026-03-20 (today, already past);
`client_cards.funding_status` = `renewed`, `funded_on` = 2026-04-06.

**Suggested fix:** compute `is_latest` from the row as it was (`f`), and refuse a `funded_on` that would reorder the client's advances unless it is the only change ("this would make it older than the 6 Apr advance").

---

### A-8 [bug] Offers: "Undo accept" leaves the other offers declined, and an offer from a funder that has since declined can be accepted

**Status:** CONFIRMED (`offers.mts`)

**Where:** `db/migrations/0010_funders.sql:468-470` (accepting turns every other live offer on the deal to `declined`), `:479-502` (`set_offer_status` reopens one row only), `:454-476` (no check of the offer's own status or the submission's), `src/components/client/SubmissionsCard.tsx:451` ("Undo accept").

**Why it matters:** Isaac accepts one funder's offer, the merchant changes his mind, he presses Undo. The accepted offer goes back to open; the other funder's offer stays declined, and the Pipeline tile and the offer chips now price the deal from one offer. He has to notice and Reopen each one by hand. The other direction: after a funder declines (its offers become `expired`),
`accept_offer` on one of them succeeds and the merchant's other live offers are turned down for an offer nobody will honour.

**Repro/evidence:** two funders, offers 1.30 and 1.28 (both `open`) → accept the first → `[accepted, declined]` → `set_offer_status(first,'open')` (what "Undo accept" calls) → `[open, declined]`. Then `set_submission_status(first,'declined')` → `[expired, declined]` → `accept_offer(first)` → `[accepted, declined]`.
(Which funder is "first" varies run to run in `offers.mts`; the states are the same.)

**Suggested fix:** remember which offers `accept_offer` declined (a `declined_by` column or a status like `passed`) and restore them on undo; refuse to accept an `expired`/`declined` offer or one whose submission is `declined`/`withdrawn`.

---

## Risks

### A-9 [risk] Lead intake: bad input and unexpected failures drop the lead with a generic "400", and the server's own errors are also 400

**Status:** CONFIRMED (`leads1.mts`, `leads3.mts`)

**Where:** `src/app/api/leads/route.ts:63-65` (the `catch` returns 400 for everything), `src/lib/leads/schema.ts:5-9` (no control-character or well-formed check on `notes`, nothing on `wantedAmount` size), `src/lib/data/errors.ts:7-18`.

**Why it matters:** the whole request runs in one transaction, so one bad character loses the lead. A lone UTF-16 surrogate (what any JavaScript/Java `substring` cut through an emoji produces) in a business name, a NUL byte in notes, or `wantedAmount: "100000000000000000000"` each end as `400 Something went wrong — try again` and nothing is saved.
A deadlock (A-1) or a database timeout also answers 400. A sender that retries only on 5xx/429 (LIKELY: that is the usual rule) will never resend these.

**Repro/evidence:** `{"businessName":"Caf\ud83d","phone":"3055550113"}` → 400 generic (Postgres `22P02 Unicode low surrogate must follow a high surrogate`); `notes: "a\u0000b"` → 400 generic (`22021 invalid byte sequence … 0x00`); `wantedAmount: "100000000000000000000"` → 400 generic (`22P02 invalid input syntax for type bigint: "1e+20"`).
Nothing in the response leaks SQL or stack text (good).

**Suggested fix:** `.toWellFormed()` and strip `\u0000` in `str()`, cap `wantedAmount` at the $100M the earnings code already uses, and answer unexpected exceptions with 500 (or 503 for 40P01/57014).

---

### A-10 [risk] Lead token: the "duplicate" answer is a lookup, duplicates change existing merchants, there is no daily cap, and the docs say otherwise

**Status:** CONFIRMED (mechanism); QUESTION (how much the leak matters)

**Where:** `src/lib/leads/intake.ts:26-45`, `docs/LEAD-INTAKE.md:34` ("can do exactly one thing … can't read anything"), `docs/DECISIONS.md:198-199` ("it reads nothing"), `db/migrations/0080_lead_tokens.sql` (no token id on the client).

**Why it matters:** _Probe:_ a caller learns whether a phone number is in the CRM (`201 created` vs `200 duplicate`), gets the card's UUID, and for a do-not-contact or trashed-DNC merchant gets `doNotContact: true`. Tested: the DNC phone returns `doNotContact: true` before and after the merchant is trashed; a trashed ordinary merchant is invisible (a new card is created); tenancy holds (A's token posting B's phone and name gets `created`, nothing about B).
_My judgement:_ the read leak is small. The caller is the owner's own form or a lead vendor he chose to give a token, and they already hold the number. What I would not accept is the write side: every probe either creates a "call now" card or adds a note and moves an existing merchant's follow-up to today
(including a lost or snoozed one: `set_follow_up` replaces the snooze). A leaked token, 30 a minute × up to 10 tokens, can bury Today in junk cards and rewrite follow-ups of numbers it already knows. There is no per-day creation cap (the new-lead email has one, the card creation has none) and the client row does not record which token made it,
so after revoking the token Isaac cannot tell the junk from his real leads (the `source` is whatever the sender typed).

**Repro/evidence:** `leads2.mts` (e) and (f).

**Suggested fix:** record `lead_token_id` on the client (or in the creation activity), add a daily creation cap per token, answer duplicate and created identically (`202 {"ok":true}`) unless the sender needs the id, and correct the two doc sentences.

---

### A-11 [risk] "When to call about a renewal" has three definitions that disagree

**Status:** CONFIRMED (`upd.mts` S2, `offers.mts`)

**Where:** `db/migrations/0020_earnings.sql:303-304` and `src/lib/mca/funding.ts:85-92` (the renewal timer is the schedule date at a fixed 50%, ignoring the funder and any collected figure), `src/components/client/logic.ts:388-402` + `FundingCard.tsx:149` ("Renewal call: now — already past 50%" uses the collected figure),
`src/lib/earnings/progress.ts:31` (the Renewals page uses the funder's own `renewal_paydown_pct`, else 50), `src/lib/data/priority.ts:136` (Today's "ready to renew" reason is a constant 50).

**Why it matters:** Today's timer, the card text and the Renewals page can each say a different day for the same merchant. (1) A funder that renews from 60% (set on its page): the timer fires at 50% on Today, the Renewals page does not list the merchant until 60%.
(2) Isaac types "collected so far" ($40,000 of $66,000): the Funding card says "Renewal call: now", the Renewals page agrees, and the renewal timer on Today stays at the schedule date, so nothing nags him. `docs/DECISIONS.md:225` records (1) as intended; (2) is not mentioned.

**Repro/evidence:** (1) funder Alpha `renewal_paydown_pct = 60`, merchant funded 31 days ago at $1,500/day on $66,000 payback → renewal timer due 2026-10-23 (today); `buildRadar` with that funder's threshold lists nobody. (2) `update_funding_terms(f, {"paid_back_override_cents": 4000000})` → open timers unchanged (`renewal 2027-01-08`).

**Suggested fix:** one function for "the day this advance can renew" used by the timer (DB), the card, the radar and the ranking; derive the timer from the funder's pct and re-derive it when the collected figure changes.

---

### A-12 [risk] A stale Funding dialog silently erases a commission recorded since it was opened

**Status:** CONFIRMED (`upd.mts` S4)

**Where:** `src/lib/earnings/mutations.ts:26-43` (the full form sends every key, including `commission_received_*` as null), `db/migrations/0020_earnings.sql:203-204` (a present key is written, no version check).

**Why it matters:** Isaac opens "Update funding" on his laptop, records the commission on his phone from the Earnings page, then saves the laptop dialog. The received amount and its date go back to null; the timeline says "Commission received cleared" and the Received tiles drop. Last writer wins, for money.
The same overwrite hits the collected figure, promise to pay and last remittance.

**Repro/evidence:** record $4,000 received, then `update_funding_terms` with the full key set the dialog sends and `commission_received_cents: null` → the column is null.

**Suggested fix:** send only the keys that changed (the dialog already holds `initial`), or add `expected_updated_at` and refuse a stale save.

---

### A-13 [risk] A trashed merchant's advance and offers can still be edited, and restore revives the old renewal date

**Status:** CONFIRMED (`upd.mts` S3)

**Where:** `db/migrations/0020_earnings.sql:175-186` (no trash check; the `timers_live_only` trigger only guards inserts), `0010_funders.sql:454-502` (`accept_offer`, `set_offer_status`), `0090_review_fixes.sql:257-287` (`restore_client` reopens the timer closed by the trash with its old date).

**Why it matters:** a stale tab is enough. Edit the remittance of a trashed merchant's advance: the row changes, the (closed) renewal timer does not, and on restore the timer comes back with the date the old terms gave. The Funding card then says one date and Today another (see A-11).
`accept_offer` on a trashed merchant works too (no timer is touched, so the trigger does not stop it).

**Repro/evidence:** fund, trash, `update_funding_terms(f, {"payment_cents": 200000})` succeeds, restore → renewal timer `2027-01-08`; the new terms give `2026-11-10`.

**Suggested fix:** one `app.assert_live(client)` helper called at the top of every client-scoped function, as REVIEW-2 R-10 suggested.

---

### A-14 [risk] Estimates are presented as facts in two places

**Status:** CONFIRMED (code)

**Where:** (1) `src/components/earnings/RecordCommission.tsx:52-54, 83-88` with `ExpectedLists.tsx:54`: the "Record received" box is pre-filled with the expected amount, which can be an estimate (average points × advance). (2) `src/lib/earnings/radar.ts:115`, `expected.ts:198` + `src/components/earnings/bits.tsx:92-100`: a renewal's commission is the commission entered on the CURRENT advance, tagged `basis: "entered"`, and `Commission` shows `entered` as a plain `$4,000` with no `~` and no "est.".

**Why it matters:** (1) one click on Save turns an estimate into a "received" fact: it lands in This month / Year to date, and `averagePoints` falls back to `commissionReceivedCents` for an advance with no entered commission, so the invented number counts as one more advance "with a commission on record" and inflates the sample size the tooltip quotes. The hint says "filled in with what you expected", not "this is an estimate".
(2) The Renewals page row "Renewal commission $4,000" is a projection from the last advance, not a figure anyone entered for a renewal; only the section total carries a "~".

**Repro/evidence:** `buildRadar` row for a funded merchant with `commission_cents` set → `expected.basis === "entered"`.

**Suggested fix:** leave the box empty when the suggestion is an estimate (show it as placeholder text); tag renewal figures `basis: "estimate"` so they get the `~ est.` treatment.

---

### A-15 [risk] The duplicate check depends on the database's character classes, and the dev and test databases are not like production

**Status:** CONFIRMED

**Where:** `src/lib/data/queries.ts:125-130` (`regexp_replace(lower(business_name), '[^[:alnum:]]+', '', 'g')` compared with a JavaScript-normalised name), `tests/helpers/db.ts:22` (`create database` with no encoding or locale; the cluster default here is SQL_ASCII / C, and so is `isaac_dev`). Same family as REVIEW-2 R-15.

**Why it matters:** in a database whose ctype is C (any C locale cluster, including UTF8 + C), every business name containing an accented letter fails to match itself, so the duplicate warning, CSV import skip and lead-intake dedupe never fire for "Café Olé", "Peña's Tacos", "Ñandú Grill", "Müller & Söhne". Those are normal names in this trade. On a glibc `C.utf8` / `en_US.UTF-8` database they match. Nothing in CI runs a UTF8 database, so the tests cannot see it.
I do not know the production database's ctype.

**Repro/evidence:** `uni.mts`: five accented names, each looked up exactly and upper-cased. SQL_ASCII/C: 10 of 10 miss. UTF8/C: 10 of 10 miss. UTF8/C.utf8: 10 of 10 match.

**Suggested fix:** normalise in one place (store a `name_key` column computed in TypeScript, or use `unaccent` + `lower` explicitly) and have `createTestDb` create a UTF8 database; ask the owner to run `select pg_encoding_to_char(encoding), datcollate, datctype from pg_database where datname = current_database()` on the real database (QUESTION).

---

### A-16 [risk] Lock order is not client-first everywhere; `record_default` and `update_funding_terms` deadlock

**Status:** CONFIRMED (`lock.mts`, `lock2.mts`)

**Where:** `db/migrations/0001_init.sql:617-637` (`record_default` updates the `fundings` row, then `move_client` locks the client), `0020_earnings.sql:179-181` (comment: "same lock order as every other function: the client, then its advance"; it locks the client, then the advance).
Same shape, LIKELY: `accept_offer`/`set_offer_status` (offer row, then client, `0010_funders.sql:459-463, 487-491`) against `set_submission_status` (client held, then `update offers`, `:368`).

**Why it matters:** two actions on one merchant at the same moment (two tabs, a double tap, the Earnings page and the client page) can abort one with 40P01, shown as "Something went wrong — try again". No corruption: Postgres rolls one back.

**Repro/evidence:** 40 rounds of one `record_default` plus one `update_funding_terms` started together: 2 deadlocks. 150 rounds of two of each: 177 of 600 calls deadlocked.

**Suggested fix:** `select … for update` on the client first in `record_default`, `accept_offer`, `set_offer_status`, `record_offer`, `set_submission_status` and `remove_submission`, then the child row. Correct the comment in `update_funding_terms`.

---

### A-17 [risk] Row-level security keys on a setting the app role can change

**Status:** CONFIRMED (mechanism, `guc.mts`)

**Where:** `db/migrations/0001_init.sql:21-24` (`app.current_user_id()` reads `current_setting('app.user_id')`), `src/lib/db/index.ts:38-44` (`set_config('app.user_id', …, true)` as `isaac_app`).

**Why it matters:** all tenancy rests on a custom setting that `isaac_app` can reassign. Any SQL injection, now or in a future dynamic query, can run `select set_config('app.user_id', '<victim>', true)` and read or write that user's rows through the same policies. RLS here protects against a forgotten `where`, not against injected SQL.
No injection exists today (I grepped every `query(` with a `${…}`: identifiers come from fixed maps or literals, e.g. `CLIENT_COLUMNS` in `src/lib/data/mutations.ts:287`), and there is one real client, so I rate it a risk, not a bug.

**Repro/evidence:** as user B in `withUser`: `select business_name from clients` → B's row; `select set_config('app.user_id', <A>, true)`; same select → A's row.

**Suggested fix:** record the decision in `docs/DECISIONS.md`; keep `tests/boundaries.test.ts` honest by also failing on template-literal SQL with `${` in `q.query(`; longer term, one database role per user or a policy on `session_user`.

---

## Nits

### A-18 [nit] The payback in TypeScript and the generated column can differ by 1¢

**Status:** CONFIRMED (`upd.mts` S5, `round.mts`)

**Where:** `src/lib/mca/funding.ts:23-25` (`Math.round(amount × factor)` in floating point) against `db/migrations/0001_init.sql:178` (`round(amount_cents * factor_rate)` in numeric).

**Why it matters:** `AdvanceRow.paybackCents` and the "Payback" stat come from the database; balance, % paid down and the radar come from TypeScript. They disagree on exact half-cent products. None arise with 2-decimal factors and whole-dollar advances; with 3-decimal factors they do: $1,385 × 1.251 = $1,732.635 → TypeScript 173,263¢, database 173,264¢.

**Repro/evidence:** whole-dollar advances $1,000–$150,000 (step 11) × factors 1.100–1.600 (step .001): 609,650 exact half-cent cases, 27,541 differ (4.5%); zero cases with 2-decimal factors.

**Suggested fix:** compute payback in one place (read `payback_cents` from the row everywhere), or round half-up on integers: `Math.floor((amount * thousandths + 500) / 1000)`.

---

### A-19 [nit] Lead endpoint: small things

**Status:** CONFIRMED unless noted

- `Authorization: bearer …` (lowercase scheme) is refused with 401 (`parseBearer`, `src/lib/leads/token.ts:17`); RFC 7235 says the scheme is case-insensitive.
- A JSON body with a UTF-8 byte-order mark is refused as "isn't valid JSON" (`readLimitedJson`, `token.ts:58`).
- `phone: 1e300` or `-5` is stored as the text `1e+300` / `-5`; `phone` is any 40-character string, so "N/A" is stored and never matches a later lead.
- The new-lead email is awaited inside the request and runs inside a `withSystem` transaction (`leadAlert.ts:26-82`), so a slow Resend holds a pool connection and delays the answer up to its 10 s timeout. Bounded by the 20-a-day cap. (LIKELY: slow-Resend case not timed.)
- A token with unknown value is not throttled (only live tokens count attempts); each attempt costs one pooled transaction. A 256-bit token cannot be guessed, so this is load only.
- `revoked_at` can be set back to null by the app role (`grant update (revoked_at)`), so revoke is reversible in the database; no UI path does it.

**Suggested fix:** `/^bearer /i`; strip a BOM; reject phones with fewer than 7 digits; fire the alert after the response; ignore.

---

### A-20 [nit] Foreign keys prove "same user", not "same merchant"; two helper functions miss `search_path`

**Status:** CONFIRMED

**Where:** `db/migrations/0010_funders.sql:112-113` (`offers.client_id` and `offers.submission_id` are separate composite keys), `:146` (`timers.submission_id`), `0001_init.sql:21-31` (`app.current_user_id`, `app.touch_updated_at` have no `set search_path`; `docs/CREW-RULES.md` says every function).

**Why it matters:** a direct `insert into offers (client_id = One, submission_id = Two's)` is accepted (same user), and `listClientSubmissions` for Two would show it. Only server code writes these rows and it always copies `client_id` from the submission, so there is no live path. The two functions are harmless today (built-ins only), but the rule is absolute.

**Suggested fix:** a unique `(id, client_id, user_id)` on `submissions` and a three-column FK from `offers`/`timers`; add `set search_path = pg_catalog, public` to the two functions.

---

### A-21 [nit] The funders functions compute "next business day" from the database's UTC date

**Status:** LIKELY

**Where:** `db/migrations/0010_funders.sql:225, 238, 250, 268-273, 304, 398` (`current_date`, `app.add_business_days(current_date, 1)`); only `update_funding_terms` converts to the user's zone (`0020:186-187`).

**Why it matters:** the production database runs in UTC. At 8 PM in New York it is already tomorrow there, so a follow-up "tomorrow" or a chase "next business day" lands a day later than Isaac's calendar. REVIEW-2 R-17 saw the same family in reports.

**Suggested fix:** pass the user's today into these functions (as `update_funding_terms` derives it), or read it from `app_users.timezone` in `app.ensure_open_timer`/`promote_to_offers_in`.

---

### A-22 [nit] A deal that leaves the funding pipeline and comes back has no chase, and "Send to funders" replaces a do-not-contact merchant's review timer

**Status:** CONFIRMED (`chase.mts`, `dnc.mts`)

**Where:** `db/migrations/0070_keep_chase_on_move.sql:152-155` (chase timers are closed on leaving the pipeline and never recreated), `0010_funders.sql:302-306` and `app.promote_to_offers_in` (`move_client` replaces every non-chase timer).

**Why it matters:** (1) Move a deal with a waiting submission to Lost, then back to Submitted: the submission is still `sent`, the card says "Waiting 40 days", and there is no chase timer; the funder is never asked again unless Isaac presses Reopen. (2) A merchant marked do-not-contact whose application is sent to a funder (or approved) loses the 36-month "review this status" timer and gets a normal follow-up the next business day.
Since the fix for REVIEW-3B B-1 (`e85ed7d`) the digest and badge skip that merchant, so nobody is called, but the review timer is gone; this is the same root cause as 3B B-1 item 2.

**Repro/evidence:** `chase.mts`: after Lost and back, `timers` for the client show only the `stage_moved` chase, submission status `sent`. `dnc.mts`: after `create_submissions` the DNC merchant's open timers are `follow_up 2026-10-26` and a chase; the 2029 review timer is closed.

**Suggested fix:** on entering a pipeline stage, create chase timers for every `sent` submission that has none; make the timer helpers keep a `dnc` merchant on the review timer.

---

## Missing tests

Behaviours that can regress and have no test (checked with `grep` over `tests/` and `e2e/`; the route `src/app/api/leads/route.ts` is imported by no test in CI, only `e2e/leads.e2e.mjs`, which is local):

1. Two or more concurrent leads for the same phone: one card, no 40P01 (A-1). `grep Promise.all tests/leads-db.test.ts` is empty; the rate-limit test is sequential, so "31 concurrent requests cannot all pass" is true today (I ran 60: 30 pass, 30 refused) but unpinned.
2. A same-name / different-phone lead keeps its phone and email (A-2); `{"email": null}` and other nulls (A-3); a lone surrogate, NUL byte and a 21-digit `wantedAmount` get a clear 4xx, a database failure gets 5xx (A-9).
3. The route handler itself: 401 / 429 / 413 / 400 bodies, the allowlist check, and that a failed alert never fails the lead, as a unit test with a `Request`.
4. Radar and forecast leave out `not_interested`, `dead`, `lost`, `killed`, `declined` and `dnc` merchants (A-4); a renewal in a deal appears once across the two tiles (A-5); one deal is one price in the price book (A-6).
5. `update_funding_terms`: a `funded_on` edit that reorders advances (A-7); collected-figure and funder-threshold effects on the renewal timer (A-11); an edit on a trashed merchant followed by restore (A-13); a stale full-form save versus commission received (A-12).
6. Offers: Undo accept restores the others; accept after the funder declined (A-8).
7. A UTF8 test database and a duplicate check on accented names (A-15); `createTestDb` should say which encoding it makes.
8. Two-connection lock-order tests: `record_default` against `update_funding_terms`, `accept_offer` against `set_submission_status` (A-16).
9. A deal that leaves and re-enters the pipeline keeps a chase on every waiting submission; a DNC merchant keeps the review timer through `create_submissions` and an approval (A-22).
10. TypeScript payback equals `fundings.payback_cents` on half-cent products (A-18).
11. Prefilled "Record received" is empty when the suggestion is an estimate (A-14).
12. `restore_client` after an edit-while-trashed shows the new renewal date (A-13).

---

## Looked at and fine

- **Tenancy, called as the wrong user.** `wrong.mts`: user B calls 24 functions (`move_client`, `set_follow_up`, `log_touch`, `cancel_call`, `schedule_call`, `add_stips`, `set_stip_received`, `record_funding`, `record_default`, `set_contact_status`, `trash_client`, `restore_client`, `purge_client`, `create_submissions` with A's client and with A's funder, `set_submission_status`, `record_offer`, `remove_submission`, `accept_offer`, `set_offer_status`, `update_funding_terms`, `app.ensure_open_timer`, `app.promote_to_offers_in`, `app.move_keeping_chase`) once with A's real ids and once with a random id: the error code and text are identical for all (0 differences), so existence of A's funders, submissions, offers, advances, stips and clients cannot be told apart from absence. A's data was unchanged afterwards (client, 2 open timers, submission, offer, active advance, stage `funded`).
  B reads 0 rows of A's `funders`, `submissions`, `offers`, `fundings`, `lead_tokens`, `stips`, `trashed_clients`, `positions`, `competing_offers`, `client_asks`; sees only its own `clients`, `timers`, `activities`, `client_cards`, `app_users`. Direct writes refused: insert funder as A (RLS), submission with A's client or A's funder (composite FK), offer on A's submission (FK), insert a token for A (RLS), update/delete A's token, advance or offer (0 rows).
- **Lead tokens.** `token_hash`, `window_start`, `window_count` are unreadable by the app role (`42501`); the column grants are exactly `select (id, user_id, label, created_at, last_used_at, revoked_at)`, `insert (user_id, label, token_hash)`, `update (revoked_at)`. The one cross-user signal is a `23505` on a duplicate `token_hash` insert, which needs the SHA-256 of someone's 256-bit token to use.
- **Tables.** RLS is enabled with owner policies on `funders`, `submissions`, `offers`, `trashed_clients`, `lead_tokens`, `snippets` and the older tables; `job_runs`, `reminders_sent`, `gmail_connections` have RLS and no grant to `isaac_app`. There is no `SECURITY DEFINER`; 38 of the 40 functions in `public` and `app` pin `search_path` (the other two are A-20). Every child table that holds merchant data has the composite `(client_id, user_id)` FK; `submissions.funder_id` and `timers.submission_id` are composite on `(id, user_id)`.
- **Rate limit.** `checkLeadToken` is one `UPDATE`: 60 simultaneous POSTs on one token → exactly 30 × 201 and 30 × 429, `window_count` 60; after the window is aged 61 s the next request resets the count to 1; revoked and garbage tokens both answer the same 401. The hash is SHA-256 of a 256-bit token, looked up by equality; `ALLOWED_EMAILS` removal is checked after the token.
- **Body and JSON handling.** 21,000-byte body → 413; 20,001 bytes with a lying `Content-Length: 5` → 413; arrays, `null`, numbers, strings, empty body, bad JSON → 400 with plain words; `__proto__` and `constructor` keys are ignored and `Object.prototype` stays clean; `stage` and `user_id` in the body are ignored (the card was created at `name_in`); CR/LF or NUL in names, email or source → refused by `line()`; an SSN in `notes` → refused. Error bodies never contain SQL, stack or table names.
- **Injection into outputs.** `csvCell` prefixes `'` to cells starting `= + - @`, tab, CR, or a space before them; phones are exported as `formatUS`; digest and alert HTML go through `esc()`; subjects through `oneLine()`; `buildRawEmail` refuses CR/LF in headers; links use the normalised E.164 number.
- **Timers.** About 10,000 randomised operations over 4 merchants and 4 funders (seeds 1, 2, 3, 5; `fuzz.mts`): create/accept/expire offers, send, answer, remove submissions, record funding and default, edit terms, trash, restore, move, snooze, log touch, book and cancel calls, DNC on and off. After every operation: a live merchant has at least one open timer; a trashed merchant has none; no open timer is beyond today + 36 months + 1 day; at most one open chase per submission and every open chase belongs to a `sent` submission. Zero violations.
  `timers_live_only` blocks every timer-creating path for a trashed merchant (error "That merchant is in the trash — restore it first").
- **`update_funding_terms`.** The date arithmetic equals TypeScript: `app.date_at_paydown` vs `dateAtPaydown` on 40,000 random terms across all four frequencies (weekend starts, month-end clamping): 0 differences. A key that is absent keeps the stored value; a JSON null clears; validation is all-or-nothing; B cannot see A's advance. The 36-month limit cannot be hit: a payoff over 1,830 days is refused, so the 50% date is at most about 30 months out.
- **0090 fixes.** R-8 (booking a call writes stage history), R-1/R-3 (`purge_client` locks the row and refuses a merchant with any contact limit; duplicate check and lead intake still see a trashed do-not-contact merchant), R-9 (overdue renewal, check-in and chase come back due today), R-10 (`timers_live_only`) all work at `e85ed7d`; also R-2 (directory hides trash), R-4 (activity export), R-16 (scoreboard excludes trash).
- **Commission math.** `pointsOf` guards a zero amount; `averagePoints` skips null and zero; unknown figures are counted and never added as $0; `awaitingCommission` excludes defaulted and treats a 90-day-old missing entry as "not recorded"; `earnedSummary` counts only received commission by its arrival day; `meanFactor` and `lossGap` need three prices and say so. A renewed advance leaves the forecast (`status !== 'active'`) and is counted once in "Funded, not yet received".
- **Performance.** `loadEarningsData` (the Earnings and Renewals read) on 10,000 merchants: about 0.5 s; on 30,000: 1.3–1.4 s (`perf.mts`, run at `0ddf0ab`).
- **Funder submission package** (`src/lib/funders/package.ts`): business facts only, no internal notes, the compose URL encodes spaces and plus signs correctly. One wording nit: it says "Documents attached" although Isaac attaches by hand.
