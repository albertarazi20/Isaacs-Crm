# Issues

Append-only. Every failure found by the manual and browser test passes (`docs/TEST-PLAN.md`), numbered I-1…, with where it is, how to reproduce it, what was expected and seen, the evidence, and a one-line fix. Found first, fixed after (CLAUDE.md step 4).

## Board + Client page pass (QA crew, 2026-10-23)

Found by `e2e/board.e2e.mjs` and `e2e/client.e2e.mjs` (run: `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm -s e2e board` / `… e2e client.e2e`)
plus a look at screenshots of every page in light, dark and 390px. Nothing was fixed while discovering (CLAUDE.md step 4).
"Evidence" names the failing check in the e2e file (the check is kept so it goes green when the bug is fixed) or a screenshot under
`/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/` (`qa-board/`, `qa-client/`, `qa-pages/`).
Test merchants are the 51 seeded ones; "today" in every run was Fri 2026-10-23 (America/New_York).

### I-1 [severity: blocker] Dragging a funded merchant to a far follow-up column silently pushes his renewal call (and check-in) out to that date, with no Undo

- Where: Board → Follow-ups view, `src/components/board/Board.tsx:179-198` (`followUp`: plain success toast, no action); SQL `set_follow_up` in `db/migrations/0001_init.sql:450-451` (`update timers set due_on = p_due_on where kind in ('check_in','renewal') and due_on < p_due_on`).
- Steps to reproduce: Board → Follow-ups. Apex Dental Lab (Funded, 58.8% paid down, "Renewal call Today"). Drag it onto "36 months" (or press Space, ArrowRight ×N, Space).
- Expected: only the follow-up moves; or the renewal call (the best lead in the shop) is protected / asks first; and the toast offers Undo like a stage move does.
- Actual: DB before `renewal:2026-10-23, check_in:2026-11-26`, after `check_in:2029-10-23, follow_up:2029-10-23, renewal:2029-10-23`. The toast is "Apex Dental Lab → follow up Oct 23, 2029" with no Undo. One slip of the mouse loses a renewal call for three years; there is no one-tap way back. `docs/DECISIONS.md` ("a booked call is an appointment…") says snoozing pushing a renewal out is deliberate, but it is deliberate for the Snooze button, where he chose a date on purpose, not for a drag.
- Evidence: board check "dragging a hot renewal to 36 months leaves the renewal call date alone" and "a follow-up drop can be undone from its toast (stage moves can)".
- Suggested fix: add an Undo action (restore the previous timers) to the follow-up drop toast, and don't move `renewal` timers on a drag (only on the explicit Snooze).

### I-2 [severity: bug] Re-entering a default stage cannot change the default date

- Where: `db/migrations/0001_init.sql:632` (`record_default`: `defaulted_on = coalesce(defaulted_on, p_defaulted_on)`); the picker promises it in `src/components/board/Sheets.tsx:12-21` ("Update the default date or promise to pay").
- Steps to reproduce: Board → Rapid Courier (Bad default, defaulted 2026-10-11) → "Move to…" → "Bad default (current)" → set "Defaulted on" to yesterday and "Promised amount" $1,250 → Save and move.
- Expected: both values saved.
- Actual: the promised amount saves (`promise_amount_cents = 125000`) but `fundings.defaulted_on` stays `2026-10-11`. The dialog accepted the new date without complaint, so a wrong default date can never be corrected.
- Evidence: board check "DB: the default date he just changed was saved (was 2026-10-11)".
- Suggested fix: in `record_default` use `p_defaulted_on` when the caller passes one (keep `coalesce` only for the "Skip details" path).

### I-3 [severity: bug] "Commission points ($)" stores "6" as $6.00 — wrong money for a broker who says "6 points"

- Where: `src/components/stage-move/dialogs.tsx:243-256` (Funded dialog), `forms.ts:114` (`moneyProblem`); elsewhere the app treats points as a percentage (`src/lib/funders/schemas.ts:105` "Commission points must be a number from 0 to 100, like 10"; Funding card "Commission points").
- Steps to reproduce: Board → drag Sparks Electric to Funded → Advance 50k, factor 1.3, remittance 400, Commission "6" → Mark funded.
- Expected: 6 points of $50,000 = $3,000, or a refusal that asks for dollars or a percent.
- Actual: `fundings.commission_cents = 600` ($6.00). The label itself is contradictory ("points" and "($)"), and anything that adds up commission will be off by thousands without a warning.
- Evidence: board check "typing '6' in the commission box … never stored as $6" (detail: `stored commission_cents = 600`).
- Suggested fix: accept "6 points"/"6%" and "$3k" explicitly (two fields or a toggle like the Funding card), and refuse a bare number below, say, 20 in a dollar box.

### I-4 [severity: bug] SSN typed into any single-line field is stored (guard only covers notes)

- Where: `src/lib/data/schemas.ts` — `line()` fields never call `findSensitive` (`source` :96/:189/:273, `wantedTerms` :201, `industry`, `dba`, `contactName`, funder names …); only `text()` does. CLAUDE.md: "Never store … SSN / card".
- Steps to reproduce: Client page → Edit details → Source: `referred by 123-45-6789` → Save. Also: The ask → "The offer he wants (terms)": `SSN 123-45-6789, 6 months` → Save.
- Expected: refused in plain words, like a note.
- Actual: both saved (`clients.source = 'referred by 123-45-6789'`, `client_asks.wanted_terms` holds the SSN) and are shown back on the page and exported in the CSV.
- Evidence: client checks "an SSN typed into 'Source' is refused, not stored" and "an SSN typed into the ask's 'terms' line is refused, not stored".
- Suggested fix: run `findSensitive` inside `line()` (one place), not just `text()`.

### I-5 [severity: bug] The notes guard misses a nine-digit SSN and a 16-digit number that fails the checksum

- Where: `src/lib/data/sensitive.ts:22-44` (`SSN` needs a space or dash; card test requires Luhn).
- Steps to reproduce: add a note `SSN 123456789`, and another `number is 1234 5678 9012 3456`.
- Expected: refused — a broker types what the merchant reads out, and typos break Luhn; "SSN 123456789" is the most likely way an SSN lands in a note.
- Actual: both stored. (Dashed/spaced SSNs, Luhn-valid cards, routing/account numbers are all refused with a clear message — those checks pass.)
- Evidence: client checks "16 digits that fail the checksum: refused…" and "SSN as nine digits: refused…".
- Suggested fix: also refuse 9 digits right after the word SSN / social security, and a 15-16 digit run next to the words card / visa / mastercard even when the checksum fails (phone numbers and dollar amounts already pass the "not mistaken for a secret" checks, keep it that way).

### I-6 [severity: bug] Skipping "Application in" leaves the application date empty

- Where: `src/lib/data/mutations.ts:179` (date is stamped only when `stage === "application_in"`).
- Steps to reproduce: Board → drag Coastal HVAC (Interested) straight to Collecting stips (or Submitted / Offers in …).
- Expected: the card is in underwriting, so the signed application is in; "App in <date>" shows and the client page's "Application in" is filled.
- Actual: `clients.application_received_on` stays NULL; the card shows no "App in" pill and the client page shows "—".
- Evidence: board check "Interested → Collecting stips directly still records the date the application came in".
- Suggested fix: stamp it (coalesce, today) on any move into the Underwriting group, not just `application_in`.

### I-7 [severity: ux] Cancelling a booked call leaves the merchant in "Phone call scheduled" with no call booked

- Where: `db/migrations/0001_init.sql:494-516` (`cancel_call` never touches `clients.stage`); `schedule_call` (:519) moved him there.
- Steps to reproduce: Client page (Green Leaf Market, "Spoke with owner") → Schedule a call tomorrow 10:30 → Book (stage becomes "Phone call scheduled") → Cancel call.
- Expected: back to the stage he was in, or at least not a stage whose hint reads "Time is booked".
- Actual: `stage = call_scheduled`, `scheduled_call_at = NULL`, one generic follow-up — the Board shows him under "Phone call scheduled" for ever.
- Evidence: client check "a cancelled call takes him out of 'Phone call scheduled'".
- Suggested fix: remember the previous stage on booking and restore it on cancel (only if still in `call_scheduled`).

### I-8 [severity: ux] Dragging a card to "Phone call scheduled" books nothing

- Where: `src/components/board/Board.tsx` `moveCard` (stage has no dialog) / `src/lib/mca/stages.ts:78`.
- Steps to reproduce: Board → drag any card onto "Phone call scheduled".
- Expected: asks "When is the call?" (or the stage is reachable only through Book a call).
- Actual: the card moves, a 1-business-day follow-up is set, `scheduled_call_at` is NULL; the column hint says "Time is booked" but there is no time, so no reminder and no pre-call email will ever fire for it.
- Evidence: board check "a card dropped on 'Phone call scheduled' either asks for the time or has a booked call" (`E2E_ONLY="Phone call" pnpm -s e2e board.e2e`).
- Suggested fix: open the same "book the call" prompt (date + time) on drop, with Skip.

### I-9 [severity: ux] Board forgets which view he was using

- Where: `src/app/(app)/layout.tsx:21` and `src/components/power/MobileTabBar.tsx:32` (links are bare `/board`); view is only in `?view=` (`src/components/board/logic.ts` `parseView`).
- Steps to reproduce: Board → Follow-ups → go to Clients → tap "Board" in the nav.
- Expected: Follow-ups again (the brief says the toggle persists; only collapsed groups and "Hide empty stages" do, in localStorage).
- Actual: always Pipeline. A reload on the same URL does keep it.
- Evidence: board check "coming back to Board from another page remembers he last used Follow-ups".
- Suggested fix: store the last view in localStorage (guarded, like `storage.ts`) and use it when `?view=` is absent.

### I-10 [severity: ux] 9-month and 18-month follow-ups exist in the picker but not as Board columns

- Where: `src/lib/mca/dates.ts:129` (`BUCKET_ORDER` filters out 9m and 18m) vs `src/components/board/Sheets.tsx` `FollowUpSheet` (offers them).
- Steps to reproduce: Board → Follow-ups → "Follow up in…" on a card → "9 months".
- Expected: he sees the card under "9 months".
- Actual: due date is correct (today + 9 calendar months = 2027-07-23) but the card sits under "12 months" next to cards due in a year, and there is no 9 or 18 month column to drag onto.
- Evidence: board check "the card lands in a column named for what he picked (9 months)".
- Suggested fix: show columns "9 months" and "18 months", or drop those two presets from the sheet and the timer picker.

### I-11 [severity: ux] A disabled Call/Text button does not say why when the phone number is unusable

- Where: `src/components/ContactActions.tsx:165,175` (`disabled={!e164 || …}`; `title` only set for do-not-contact reasons).
- Steps to reproduce: Edit details → Phone `call his cell` → Save → look at Call.
- Expected: tooltip / visible text "No usable phone number — add one" (TEST-PLAN C6).
- Actual: a greyed button with `title=null`; on a phone there is no tooltip at all, so he can't tell a bad number from a bug.
- Evidence: client check "…and says why (tooltip / label)".
- Suggested fix: add the reason to `title` and as a visible hint under the buttons on the client page; flag the phone field in Edit details.

### I-12 [severity: ux] Tap targets under 40px on the cards and the client page (390px)

- Where: `src/components/ui.tsx:32` (`sm` = `h-8`), `src/components/board/cards.tsx:80-95` (`Move to…` ≈ 22px), `NameLink` (19px), `src/components/TimerPicker.tsx:31` (`h-8` presets), `src/components/client/*` small buttons, `Dialog` close button.
- Steps to reproduce: open the Board and a client page at 390px with touch.
- Expected: every button/link/field ≥ 40px tall.
- Actual: board card: name link 19px, "Move to…" 22px, Call/Text/Email 32px. Client page: 28-29 elements under 40px, e.g. phone and email copy links 20px, Edit details / Contact status / Move to trash 32px, timeline filter pills 32px, 1w…36m presets 32px; dialog "Close" 32px.
- Evidence: board check "mobile: every button on a card is at least 40px tall"; client checks "[light]/[dark] every button, link and field is at least 40px tall" and "buttons and fields inside the dialog are at least 40px tall"; `qa-client/mobile-client-light.png`.
- Suggested fix: `size="sm"` becomes `h-10` below `sm:`; add `py-2.5` hit areas to links and presets; keep the dense look on desktop only.

### I-13 [severity: ux] On a phone the client page puts the note box 1,297px down (1.5 screens)

- Where: `src/components/client/ClientView.tsx` (mobile order: header, details, follow-up panel with presets and "Schedule a call", then the timeline); BACKLOG R9 "note box first on the client page" is still open.
- Steps to reproduce: 390×844, open Rivera Auto Repair, scroll to the note box.
- Expected: note box within one screen of the top (he is on the phone with the merchant right now).
- Actual: `#new-note` is 1,297px from the top of a 3,287px page; the pinned header block (app bar + name/stage/next date/Call-Text-Email) takes 197px (23%) of the screen all the time.
- Evidence: client check "the note box is reachable without scrolling past a wall of cards"; `qa-client/mobile-client-light-full.png`.
- Suggested fix: on mobile put the note composer right after the pinned header and collapse "Schedule a call" / the preset grid behind a "Change follow-up" button; make the pinned bar one line.

### I-14 [severity: ux] Clients page on a phone: six stacked buttons, and the "Next follow-up" column is off-screen

- Where: `src/app/(app)/clients/page.tsx` toolbar; `src/components/ClientsTable.tsx:200-201` (`min-w-[760px]` table inside `overflow-x-auto`).
- Steps to reproduce: 390px wide → Clients.
- Expected: the list starts near the top and shows the date the product is about.
- Actual: Download clients / Download notes / Import / Lead intake / Reports / Trash stack to ~280px before the search box; the table shows Business, Merchant and a clipped Stage ("Lost de…", "Interes…"); the Next follow-up and Last contact columns need a sideways swipe.
- Evidence: `qa-pages/clients-v390.png` (viewport shot) and `qa-pages/clients-m390.png` (full page).
- Suggested fix: on mobile render rows as cards (name, stage, due chip), and move CSV/Import/Reports/Trash into a "…" menu.

### I-15 [severity: ux] Editing a merchant's phone to match another merchant gives no duplicate warning (Add client does)

- Where: `src/lib/data/mutations.ts:301` (`updateClient`) vs `src/components/QuickAdd.tsx:112` (`findDuplicatesAction`).
- Steps to reproduce: Edit details on Cruz Landscaping → Phone = Mike's Pizza's number → Save.
- Expected: "This looks like Mike's Pizza" warning, as when adding.
- Actual: saved silently; two cards now share one number, so a phone search returns both.
- Evidence: client check "giving him Mike's Pizza's phone number warns about the duplicate (Add client does)".
- Suggested fix: call `findDuplicates` (excluding self) in the Edit dialog before saving.

### I-16 [severity: ux] Payback smaller than the advance, or a balance bigger than the payback, are accepted for "Other advances"

- Where: `src/lib/data/schemas.ts` `positionSchema` (no cross-field checks); `src/components/client/PositionsCard.tsx`.
- Steps to reproduce: Client → Other advances → + Add → advance $20k, payback $10k, balance $50k → Save.
- Expected: a plain-words question ("payback is less than the advance — did you mean 27k?"). An MCA factor is ≥ 1.00.
- Actual: saved; the rollup quietly clamps the % paid down.
- Evidence: client check "a payback smaller than the advance, and a balance bigger than the payback, are questioned".
- Suggested fix: refuse payback < advance and balance > payback (factor rate is already limited to 1.00–3.00 elsewhere).

### I-17 [severity: polish] Some refusals are raw validator or database wording, or name the wrong thing

- Where: `src/lib/data/errors.ts` (`ZodError → issues[0].message`, `23514 → "One of those values isn't allowed"`), `db/migrations/0001_init.sql:357-367` (`assert_due_on`).
- Steps and actual: a 5,001-character note → "Too big: expected string to have <=5000 characters"; a 250-character business name → "Too big: expected string to have <=200 characters"; The ask → amount `0` → "One of those values isn't allowed" (which value? why?); Book a call three days ago → "follow-up date 2026-10-20 is in the past" (it's a call, and the date is ISO).
- Expected: "That note is too long — the limit is 5,000 characters", "Enter an amount above $0", "That time has already passed — pick a time from now on".
- Evidence: client checks "a note over 5,000 characters is refused in plain words", "a 250-character business name is refused in plain words", "an amount of 0 is refused in plain words", "booking a call three days ago is refused in plain words about a CALL".
- Suggested fix: pass `error:`/`message:` strings on every `.max()`/`.min()` in `schemas.ts`; give `schedule_call` its own message; map 23514 by constraint name.

### I-18 [severity: polish] "Change the follow-up date" opens with 1w highlighted even when the current follow-up is today

- Where: `src/components/client/FollowUpPanel.tsx:61-63` (initial = today + 7 when the next date is not in the future).
- Steps to reproduce: open a merchant whose follow-up is today (Rivera Auto Repair).
- Expected: nothing highlighted until he picks one (or the highlight means "current").
- Actual: "1w" looks selected while the panel above says "Oct 23 · Today"; a tap on "Set follow-up" without thinking moves him a week.
- Evidence: `qa-pages/client-light.png`, `qa-client/desktop-client-dark.png`.
- Suggested fix: start with no preset pressed and "Set follow-up" disabled until a date is picked.

### I-19 [severity: polish] The Import page shows the browser's raw "Choose File — No file chosen" control

- Where: `src/app/(app)/import/page.tsx` / `ImportWizard.tsx`.
- Evidence: `qa-pages/import-light.png`, `qa-pages/import-v390.png` (unstyled file input; the rest of the app is styled).
- Suggested fix: a styled "Choose a spreadsheet" button (label wrapping the input) at least 40px tall.

### I-20 [severity: polish] Board on a phone is one 7,600px-wide strip with no jump-to-stage

- Where: `src/components/board/views.tsx` (`Scroller`), 23 stage columns at 82vw each.
- Steps to reproduce: 390px → Board → Pipeline; try to reach "Funded" or "Exits".
- Actual: about 20 swipes from Name in to Not interested; collapsing groups helps but starts expanded, and nothing shows how far along the strip you are. (Follow-ups view is 12 columns.)
- Evidence: board check "mobile pipeline: the board itself scrolls sideways" (scrollWidth 7,619px in a 358px box); `qa-board/mobile-pipeline.png`.
- Suggested fix: a sticky stage-group tab row (Prospecting / Underwriting / Funded / …) that scrolls to that group.

### I-21 [severity: polish] Unconfirmed: one hydration-mismatch console error on the Board

- Where: Board page after a reload with a collapsed group saved in localStorage (first full run only).
- Actual: once, `A tree hydrated but some attributes of the server rendered HTML didn't match the client properties`. Not seen in the next five Board runs (`no console errors on the desktop board` passes) and not reproduced in a plain load of Board/Today/Clients, so it is logged here as unreproduced, not a verified bug. The Board/Client suites now print the first 500 characters of any console error and every 4xx/5xx URL so the next occurrence names itself.

## What passed (so nobody re-tests it)

Follow-ups view: drag into every column writes the exact calendar-month date (1w…36m, Today) and leaves exactly one open follow-up; same-column drop and Overdue/Later drops change nothing; keyboard Space/arrows/Space works in both views with screen-reader announcements and skips the disabled Overdue column; three drags in a row end consistent in the DB. Pipeline: Interested → Application in stamps the date and writes `stage_change`; Undo and the toast's Change work; Dead deal / Not interested / Declined / Killed move straight away with 9/12/3/6-month timers; Lost deal asks who won, stores the rival offer (`won = true`, every field) and calls back at half the term; Funded stores amount × factor = payback, a 30-day check-in and a 50% renewal call; Workable default stores default date, promise time (in Isaac's timezone) and amount; walking one merchant through all 23 stages gave every stage the documented default timer and never left zero timers; a blank/invalid dialog keeps the card put and the typed values; a server refusal (SSN in a note) keeps the dialog open with the text; a vanished client snaps the card back with a toast. Search, Overdue-only, group collapse and Hide-empty work; collapse/hide persist across reload; the page works with `localStorage` throwing. Mobile: no horizontal overflow, the sheet move works, touch long-press drag and swipe-to-scroll both work. Client page: notes, call outcomes (suggested follow-up lands in the DB; Skip changes nothing; prompt survives a reload), book/cancel call (booking survives an unrelated logged call), presets 1w…36m, custom date, 37 months and past dates refused in plain words, ask history (both snapshots kept), positions and competing offers add/edit/delete with two-click delete, stips tick/untick with "Ready to submit", edit details, stage move from the client page, SSN / card / routing-number notes refused.
Timings with 51 merchants (`E2E_ONLY=perf pnpm -s e2e board`): Board render to first interactive card 560–770 ms; first drag shows in the new column in ~0.8 s including ~0.6 s of scripted mouse travel; the database row follows 140–280 ms later; JS heap 28–35 MB.

### I-22 [severity: polish] `/favicon.ico` returns 404

- Where: no `src/app/favicon.ico` (only `icon.svg` and `apple-icon.png`); Chrome asks for `/favicon.ico` on its own.
- Steps to reproduce: open any client page with DevTools console open (or run `pnpm -s e2e client`).
- Expected: no failed request in the console of a fresh page load.
- Actual: `Failed to load resource: the server responded with a status of 404 (Not Found) @ /favicon.ico` on the client page.
- Evidence: client check "no console errors on the client page (desktop)".
- Suggested fix: add `src/app/favicon.ico` (or an explicit `icons` entry in the metadata so the browser never guesses).

## Status note, end of this pass

The last `pnpm -s e2e client` run (after the lead's first fixes landed) shows I-4 and I-5 green: an SSN in "Source" / the ask's terms line, `SSN 123456789` and a checksum-failing 16-digit number are now refused. Everything else above was still failing in that run, so the checks stay in the suite as the regression tests.

## Fix status (after the fixes, 2026-10-23)

Fixed in the commits after `fa0c322` and re-checked by `pnpm e2e` (full run: 19 files, 765/765 checks, exit 0; command and counts in `docs/TEST-PLAN.md` "Run log"). The QA checks named in each "Evidence" line above stayed in the suite and now pass.

| #             | Status         | Where it was fixed                                                                                                                |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| I-1 (blocker) | Fixed          | 0150 `set_follow_up(keep_calls)`; Board drop toast names the call that stayed and has Undo                                        |
| I-2           | Fixed          | 0130 `record_default` saves the date it is given                                                                                  |
| I-3           | Fixed          | Funded dialog and Update funding: bare "6" is a question, "6%" is points, "$3k" is dollars (`parseCommissionText`)                |
| I-4, I-5      | Fixed          | Secrets guard on every one-line field; `SSN 123456789` and checksum-failing card numbers refused                                  |
| I-6           | Fixed          | Application date stamped on any move into underwriting or funded                                                                  |
| I-7           | Fixed          | 0160 `cancel_call` puts the merchant back in his earlier stage                                                                    |
| I-8           | Fixed          | Dragging to Phone call scheduled asks when the call is (or moves without a time)                                                  |
| I-9           | Fixed          | Board remembers its view in a cookie the server reads (no flash of Pipeline)                                                      |
| I-10          | Fixed          | 9-month and 18-month Board columns                                                                                                |
| I-11          | Fixed          | Disabled Call/Text say why; Edit details warns about an unusable phone                                                            |
| I-12          | Fixed (scoped) | 40px targets on Board cards, the client page and dialogs below `sm:`. The Today page's small targets are on the backlog           |
| I-13          | Fixed          | Note box 372px down at 390px wide (was 1,297px)                                                                                   |
| I-14          | Fixed          | Clients on a phone: "…" menu and card rows                                                                                        |
| I-15          | Fixed          | Edit details warns when the new phone or name matches another card, and offers "merge into this card" (0190 `merge_clients`)      |
| I-16          | Fixed          | Payback below the advance, balance above the payback: refused                                                                     |
| I-17          | Fixed          | Plain wording for too-long text, a $0 ask, past call times; database checks explained by name                                     |
| I-18          | Fixed          | Follow-up picker opens with nothing lit and Set follow-up disabled                                                                |
| I-19          | Fixed          | Styled "Choose a spreadsheet" button                                                                                              |
| I-20          | Fixed          | Sticky stage-group tabs on the phone Board                                                                                        |
| I-21          | Not reproduced | One hydration warning seen once; the suites now print the first 500 characters of any console error, so the next one names itself |
| I-22          | Fixed          | `src/app/favicon.ico`                                                                                                             |

## Pass 2 — the Selective CRM pages and automations (2026-11-16, overnight, autonomous)

Plan: `docs/TEST-PLAN-SELECTIVE.md`. Users: `qa-manager@example.com` (manager, 51 seeded merchants), `qa-rep@example.com`
(rep, 51), `qa-ops@example.com` (ops, none). Collected first, fixed after; each item names the plan case it came from.

### P2-1 [severity: polish] Dashboard goal card says "Set a my own book goal" (A1)

The second goal card's call to action is built as "Set a {label} goal" with the label "my own book". Read it as a sentence:
"Set my goal" / "Set the shop goal".

### P2-2 [severity: ux] A manager's (and ops') "Do this now" list does not say whose merchant each line is (B3, B5)

With two reps holding merchants of the same name (the seed gives every user the same 51 names), the manager's list shows
"Follow up · Park Place Parking" twice in a row with nothing to tell them apart. Add the rep's name on each line when the
viewer can see more than their own book.

### P2-3 [severity: ux] Pages outside a role's nav still open by URL (A4)

A rep can open `/board` (lanes empty — row security hides other reps' deals — but the "Every rep" filter lists every
user on the team); ops can open `/lead-intake`, `/follow-up`, `/winback` and `/funded` and gets a working intake form
and empty pages. Only `/settings/team` and `/settings/plan` redirect (a rep lands on the Dashboard, silently). One gate
in the app layout — "is this page in `navFor(role)`?" — should send the user to their home with a one-line notice.

### P2-4 [severity: ux] Ops sees the rep Dashboard (My month, MY CUT, NEW LEADS) instead of the queue (A3, B5)

Ops has no book and no commission; the tiles read "MY CUT $0" and "NEW LEADS 12" (the 12 merchants behind queued deals).
The plan's Dashboard for ops is the queue with ages and kickbacks. At least hide the money tiles for ops and lead with
"Files waiting on you".

### P2-5 [severity: polish] The login page still carries the old brand: a big "I" and "Follow-ups, funded deals and renewals — one place." (A7)

The app shell says "S · Selective CRM"; the login page should match (the "S" mark and a line about the shop).

### P2-6 [severity: ux] Settings → Lenders is the old Funders page: none of the money terms the FUND guardrails read can be set (I4, F13)

`/settings/lenders` redirects to `/funders`, whose form stops at appetite, commission points and renewal paydown. The
per-lender terms added in 0350 — max upsell points, PSF cap, clawback days, approval validity, statement-freshness day,
commission pay timing, renewal commission basis — have no field anywhere, so `propose_funding`'s refusals ("Pearl caps
points at …") can only ever fire from SQL. Add a "Money terms" block to the lender form.

### P2-7 [severity: ux] Two pages scroll sideways on a phone: Follow Up and Funders (A8)

`node e2e/shots.mjs qa-manager@example.com <dir>` at 390px: `/follow-up` renders 656px wide (the lead line
"Business · Owner · phone · email · ET · wants $65k" never wraps) and `/funders` 433px wide (the card header's name plus
Edit / Archive / Delete sit on one row). Every other page fits. Let the lead line wrap (or stack its segments) and put
the lender card's buttons under the name below `sm:`.

### P2-8 [severity: blocker] A new lead that autofilled from the sheet is refused as "already here", and the sheet row is marked filed with no merchant (C4, C1)

Steps: Lead Intake as a rep, phone `3105550199` (a staged `sheet_rows` row for "Harbor Tacos", wanted "$60k for a second
truck", revenue 65,000, state CA), bucket Missing statements, Submit. Screen: "Harbor Tacos was already here — No second
merchant was made. Open the existing one and log the call" (and no link to open anything). Database: no `clients` row,
no enrolment, no welcome email; `sheet_rows.filed_at` set with `client_id` null, so the daily sheet loop will never file
it either.
Cause: `fileOneRow` (src/lib/sheets/file.ts) wraps `createClient` in a bare `catch` that marks the row filed and returns
"skipped"; `intakeLeadAction` (src/app/intake-actions.ts) reports anything that is not "filed" as a duplicate. The
throw comes from the row's free-text "looking for" being passed as `wantedAmount` (the action sets `wanted:
i.lookingFor || row.wanted`, and `newClientSchema` parses `wantedAmount` as money). Fix: pass the looking-for text to
`looking_for`, not `wantedAmount`; on a create failure leave the row unfiled and surface the real error; make the
intake result say "skipped: <reason>" rather than "duplicate"; and give the duplicate card a link to the merchant.

### P2-9 [severity: polish] The duplicate notice on Lead Intake names the merchant but not whose it is or where it sits (C3)

"This number is already in the CRM as Bella Nails & Spa" — the plan's line is "Already in the system: Mike's lead, in
Missing statements, touched 3 days ago". Add the owning rep and the bucket/stage so two reps stop working the same
merchant on purpose.

### P2-10 [severity: polish] Lead Intake leaves `clients.timezone` / `timezone_source` empty (C5)

The merchant's zone is derived at read time by `app.client_timezone()` (state, then area code, then the rep's zone), so
sends and the "ET" chip are right; but the plan's "time zone filled in, from the state when known, otherwise the area
code" meant stamping it, so a rep can see where it came from and override it. Stamp `timezone` and `timezone_source`
on create (and when the state or phone changes).

### P2-11 [severity: polish] Browser-test templates ("E2E welcome 1794801925488") are left behind as shared templates (D8)

Three show in every rep's blast list on the dev database. The flow that makes them should create them as the test
user's own (owner_id = the user, so dropping the user removes them) or archive them in its cleanup.

### P2-12 [severity: polish] The per-merchant menu button on a Follow Up row has no accessible name (D1)

`button [ref_30] type="button"` in the accessibility tree — a screen reader says "button". Give it `aria-label="Actions
for Pioneer Auto Glass"`.

### P2-13 [severity: ux] A blast (and every sequence email) goes out with a blank postal line while Settings → Email has no address (D9)

`shop_settings.postal_address` is '' on a fresh shop; nothing in `blastAction`, the bucket engine or the worker refuses
to send, so the CAN-SPAM footer reads "Selective Capital / (blank) / To stop these emails: …". The plan: "Empty blocks
automation from switching on." Refuse bulk lanes (sequence, blast, winback) in the worker with skip_reason
`no_postal_address`, say so on the Follow Up page, and keep intake and reply lanes going.

### P2-14 [severity: ux] Blast confirms with a bare `window.confirm` and shows no merged preview (D8)

The plan's blast step is "preview the merged emails, send". Today the button asks "Send “Application — second ask” to 1
merchant?" in a native dialog and queues straight away; nobody sees what {first_name} or {upload_link} became, and the
dialog cannot be styled, shown on a phone with the names, or driven by the browser suite. Replace it with the app's own
confirm sheet showing the first merged email and the list of names.

### From the fresh-context correctness review (agent A, 2026-11-16 — each confirmed by reading the code path)

### P2-15 [severity: blocker] Google Sheets "Connect" is always rejected (I12)

`SheetsPanel.tsx` submits `{url, tab, targetBucketId, autoFile, shared}`; `connectSchema` (src/app/sheets-actions.ts)
requires `name` with no default and the panel has no Name field → "Invalid input: expected string, received undefined",
nothing created. Fix: default the name to the spreadsheet title or tab, or add the field.

### P2-16 [severity: blocker] "Auto-file" / "Turn off" on a connected sheet always fail (and would wipe the column mapping if they passed)

`updateSheetAction({ id, mapping: {}, … })` — the mapping is a Zod 4 `record` keyed by an enum (exhaustive), so `{}`
fails with 14 issues; and the update does `set mapping = $2`. Fix: `partialRecord(...).optional()` and `coalesce($2, mapping)`.

### P2-17 [severity: ux] Sheet-filed merchants get monthly revenue ×100 (C4)

`sheet_rows.monthly_revenue_cents` is already cents; `fileOneRow` hands it to `newClientSchema.monthlyRevenue`, which
runs `parseMoney` again (×100). $50,000/mo becomes $5,000,000/mo. Fix: pass dollars (`/100`) or bypass the schema.

### P2-18 [severity: ux] `requireRole()` inside `try` turns an expired session or a wrong role into "Something went wrong" in 13 actions

dashboard-actions, settings-actions (4), team-actions (3), trust-actions (5): the redirect Next throws is caught and
logged as an error. Fix: call `requireRole`/`requireSession` above the `try`, as the deals/buckets/docs actions do.

### P2-19 [severity: polish] Activity feed times are hard-coded to America/New_York

`ActivityFeed.tsx` formats the hour in New York while the date is the session zone; pass `ctx.timezone` and use
`formatDateTime`.

### P2-20 [severity: polish] Duplicate React keys in the Dashboard "Do this now" list

`stale_submission`, `decision` and `renewal_ready` rows are not `distinct on`, so one deal with three quiet lenders
yields three rows keyed `kind-client-deal`. Include the submission/proposal/funding id in the key.

### P2-21 [severity: polish] "Amount they want" on intake is silently dropped when unparsable

The intake action's local `optMoney` returns null on junk without a Zod issue; reuse the shared `optMoney`.

### P2-22 [severity: polish] Form controls with no accessible name

Board rep/lender filter selects, Follow Up filter and time-zone selects, GoalEditor input, NoteEditor textarea, the
TeamPanel role select, the SequenceEditor "✕" button (and the lender form's inputs, P2-6 page). Add `aria-label` or a
real `<label htmlFor>`.

### P2-23 [severity: polish] A crafted `/board?rep=…` of 36 dashes passes the loose regex and 500s on `::uuid`

Use the strict UUID regex the deal page uses.

### P2-24 [severity: polish] Reps are offered "Edit" on shared templates but Save is refused ("Only a manager can make a shared template")

Hide Edit for shared templates when the viewer is not a manager, or apply the check only on create.

### From the fresh-context security review (agent B, 2026-11-16 — each confirmed end to end)

### P2-25 [severity: ux] Lead-intake tokens and lead alerts outlive the account

`checkLeadToken` ignores `app_users.active`; `offboard_user` / `set_team_member` never revoke `lead_tokens`; the new-lead
alert mails the owner without checking `active`. An offboarded rep's Zapier keeps creating merchants in a dead book and
emailing the ex-employee the lead. Fix: `and u.active` in the token query; revoke the user's tokens on disable/offboard.

### P2-26 [severity: ux] Disabled accounts keep getting the digest, call reminders, weekly and new-lead emails

`reminders.ts`, `weekly.ts`, `leadAlert.ts` select on `digest_enabled` only (`sendReplyAlerts` is the one that checks
`active`). Add `and active` to each select/join.

### P2-27 [severity: blocker] A rep can rewrite the money on a confirmed funding

`updateFundingTermsAction` / `recordCommissionReceivedAction` (earnings-actions.ts) have no role check and
`update_funding_terms` has no `confirmed_at` guard, while confirm/record-paid are manager-only. After a manager confirms,
the rep can set commission and "received" to any figure: dashboard, Funded sheet and scorecard show it, no ledger line.
Fix: in `update_funding_terms` refuse money fields on a confirmed row unless `app.can_see_all()`; gate the received
action with `CAN.confirmFunding` or route it through `record_commission_paid`.

### P2-28 [severity: blocker] Unauthenticated inbound mail with a forged From drives merchant state (J6, D11)

Merchant match is `lower(c.email) = from`; then `record_merchant_reply` stops sequences, marks winback replied and on a
STOP phrase suppresses the address shop-wide; attachments are filed as documents and the trigger ticks the stip.
SPF/DKIM are stored but never consulted; the Resend path has no check at all. Fix: treat the sender as the merchant only
when the thread / In-Reply-To matches mail we sent, or SPF and DKIM both pass; honour STOP and file attachments only then.

### P2-29 [severity: ux] The merchant's permanent upload token is in every email, never rotates, and every GET mints a new 2-hour session

So `max_files` is no cap; each accepted file ticks the stip and re-buckets the merchant before the scan has run. Fix:
reuse an unexpired merchant-opened session (or cap mints per client per day), count files per client per day, tick the
stip on a clean scan rather than on insert, and add a "new upload link" action that rotates the token.

### P2-30 [severity: ux] `add_team_member`'s upsert changes an existing user's role without bumping `session_epoch`

A demotion by "adding" the email again leaves the old role in a live session for up to 14 days; several checks are
TS-only on that claim. Fix: bump the epoch in the `do update` when role or active changes.

### P2-31 [severity: ux] Blasts skip the manager-approval gate that sequences, winback and the welcome email apply

`queueBlast` selects `templates where id = $1 and not archived`; add `and app.template_may_auto_send(id)`.

### P2-32 [severity: ux] `syncSheetNowAction` / `updateSheetAction` sync any sheet id under `withSystem`

A rep holding another rep's private sheet id forces Google reads with that rep's token. Check visibility under
`withUser` first (zero rows → refuse).

### P2-33 [severity: ux] `setDealNoteAction` accepts `manager_note` / `ops_note` from a rep

Only the page hides the editors. Refuse those fields in the action unless the role allows them.

### P2-34 [severity: ux] Lender document links can never be revoked (F8)

`revoked_at` is honoured on download but nothing sets it; the only way to kill a wrongly sent link is to delete the
document. Add a revoke action and list live links on the document.

### P2-35 [severity: ux] The upload route reads the whole multipart body before checking the token or sizes

Validate the session first, cap `content-length`, check `file.size` before `arrayBuffer()`.

### P2-36 [severity: polish] Audit rows are insertable with any viewer: `document_views_write`, `send_ledger_insert`, `suppressions_insert` all `with check (true)`

Scope `document_views` to `viewer_user_id = app.current_user_id()`, drop the app role's insert on `send_ledger`, and
scope `suppressions` to `created_by = app.current_user_id() or app.can_see_all()`.

### P2-37 [severity: polish] `suppressions.display` (clear emails/phones) is readable by every rep's connection

The page is manager-only but the policy is `using (true)`. Make `app.is_suppressed` security definer and restrict the
select policy to managers.

### P2-38 [severity: blocker] A rep has no way to submit a file to ops (E1)

`submitToOpsAction` exists (src/app/deals-actions.ts) but no page or component calls it. My Deals' empty state says
"Submit a lead to ops from the merchant page", and the merchant page offers only the old "Send to funders". The browser
suite made its deals in SQL, which hid this. Fix: a "Submit to ops" button on the merchant page (kind, requested amount
pre-filled from the ask, use of funds, note) and "Resubmit" on a kicked-back deal page.

### P2-39 [severity: ux] Ops cannot send a file to lenders from the board or the deal page (E4)

The board's "Sent to lenders" only marks the status (`mark_deal_sent`). The lender picker (SubmissionsCard →
SendDialog) lives on the merchant page and on the deal page's Lenders & offers tab, but the board's button does not open
it, and sending never marks the deal sent (P2-42). Open the SendDialog from the board's button, mark the deal sent in
the same transaction, and show the shotgun warning there (P2-40).

### P2-40 [severity: ux] The shotgun warning never shows on the send dialog (E5)

`max_lenders_per_deal` is checked only in `submitToLenders` (src/lib/inbox/submit.ts, the package-by-email path); the
dialog reps and ops actually use (SendDialog → `sendToFundersAction` → `create_submissions`) has no check, so with the
limit at 2 and three lenders ticked nothing warns. One send path (P2-39) with the warning before the button.

### P2-41 [severity: blocker] Ops cannot send a file to lenders, record a lender's answer or an offer: row security on `timers` and `offers` is read-only for ops (E4, E8, E11)

Reproduced as `qa-ops` on the merchant page: "Send to 3 funders" → "Something went wrong — try again"; the server log says
`new row violates row-level security policy for table "timers"` from `create_submissions → move_client → replace_timers`.
0300 gave ops `timers_ops` and `offers_ops` **for select** only, while every lender function (`create_submissions`,
`set_submission_status`, `record_offer`, `set_offer_status`) inserts chase/follow-up timers and offers under the rep's
user_id. Fix (migration): `timers_ops_write` and `offers_ops_write` for all to isaac_app using/with check
`app.is_ops_deal(client_id)` (and `client_asks`/`positions` stay read-only). Add a unit test that runs the whole ops
loop as the ops role, not as the owner.

### P2-42 [severity: ux] After the merchant-page send, the deal stays "With ops" (queued) though three lenders have the file (E4, E7)

`create_submissions` writes the lender rows but never touches `deals.ops_status`, so `app.deal_status` keeps answering
`working_ops` and the board's "With lenders" lane stays empty until someone also presses the board's "Sent to lenders".
Seen on the deal page too: the header reads "Ops is working the file" under milestones that already show Sent, First
answer and Approved ticked, and the board's "Present it" lane stays empty with an approved offer waiting. Part of the
P2-39 fix: the send marks the deal sent (`mark_deal_sent`) in the same transaction, and `app.deal_status` should prefer
lender evidence over a stale `queued` once any submission exists.

### P2-43 [severity: ux] The decline picker still offers the old ten reasons, not the `decline_reasons` table (E9)

The merchant page's "Declined" dialog lists revenue / time in business / NSFs / position / industry / state / credit /
stips / over-leveraged / other. 0300 added the clean taxonomy (19 reasons with a curable-after clock: low balances,
negative days, falling revenue, funded too recently, lien, bankruptcy, failed BV, altered statements, prior default…)
that Winback's "declined, now curable" pool keys on. Read the options from `decline_reasons` (grouped by category) on
every decline dialog (merchant page, board chip, deal page).

### P2-44 [severity: blocker] "Accept" on an offer opens the legacy "Mark funded" dialog, which bypasses FUND's propose → confirm flow and the lender caps (F12, F13, F16)

On the deal page's Lenders & offers tab (and the merchant page), accepting Kalamata's offer immediately opened
"Marlin Charters — funded" (the old Funded dialog): terms prefilled, commission "$3,600 · 8 points" although Kalamata's
max upsell is 5, and a "Mark funded" button that calls `record_funding` directly — no `propose_funding` guardrails, no
manager confirmation, no sell/buy/PSF, no ledger line. The green FUND button in the header is the intended path. Make
Accept only accept (toast "Offer accepted — press FUND when the money lands"), and route "Mark funded" to the FUND
dialog.

### P2-45 [severity: polish] "Preview commission" shows empty cells when the terms break a lender cap (F13)

With 10 points against Kalamata's cap of 5, Preview rendered the Payback / Points / Gross commission / Your cut headers
with nothing under them; only "Fund and confirm" produced "Kalamata Capital Group caps points at 5.00 — you entered
10.00". Show the same refusal in the preview row.

### P2-46 [severity: polish] The PSF-cap refusal prints "%2.00 of the advance" (F13)

`propose_funding` raises `'% caps the PSF at %%% of the advance'` — the escaped percent lands before the number. Should
read "caps the PSF at 2.00% of the advance".

### P2-47 [severity: blocker] The deal page and the merchant page crash once a lender row has one of the new statuses (F16, E8)

Right after "Fund and confirm", the deal page died with `Cannot read properties of undefined (reading 'map')` at
src/components/client/SubmissionsCard.tsx:290 — `SUBMISSION_ACTIONS[sub.status].map(...)`. The old card only knows
sent / stips_requested / approved / declined / no_response / withdrawn; 0300 added revised, contracts_out,
contracts_in, funding_call, funded and expired, and `confirm_funding` writes `funded`. Every page that renders the card
(deal page Lenders & offers, merchant page) is unreachable for that merchant from then on. Fix: an action map for every
status (funded/expired: no actions, a chip only), and a unit test that renders the card for each status in the check.

### P2-48 [severity: polish] The Activity tab says each lender event two or three times (F10)

"Kalamata Capital Group funded" appears as a System line, a Lender line ("Kalamata Capital Group: funded · ops") and a
Funded line, all at 1:22 AM; the same for the approval and the decline. Collapse the system activity row and the
lender-row milestone into one line with the richer wording.

### P2-49 [severity: polish] A disabled account can no longer be offboarded (I9)

After "Disable", Sam Rivera's row shows only "Re-enable"; a manager who disabled a rep on the day they left has to
re-enable them to move their book. Keep "Offboard" on a disabled row.

### P2-50 [severity: ux] "Lender link" on a document asks for the lender's name with `window.prompt` (F7)

`DocumentsPanel.tsx:172` — a native prompt for free text, 2-hour expiry hard-coded, no lender select, and it throws in
any browser that blocks prompts (the browser suite included). Use the panel's lender select (already there for "Send
checked") plus an expiry choice in the app's own dialog; stamp the lender's name from the record.

### P2-51 [severity: ux] "Copy a number, logged" is not wired anywhere (I7)

`logAccessAction` (src/app/trust-actions.ts) has no caller in src/components or src/app; phone numbers render as plain
`tel:` links on the deal header and the merchant page, so the trust panel's "copies" column can only ever read 0 and
the offboarding report's `contact_copies` is always 0. Add the one-click copy control next to each phone and email
(copies one value, posts `copy_phone` / `copy_email`), and log `view_contact` when a merchant outside the rep's book is
opened by a manager or ops.

### P2-52 [severity: ux] "Paid on (blank = today)" is refused when left blank (H2)

Record payment with the date empty → "One of those values isn't allowed — check the amounts and dates". The sheet sends
`on: ""`, which fails the action's `^\d{4}-\d{2}-\d{2}$` regex; with a date typed it saves. Send `undefined` for blank
(or make the schema treat "" as today).

### P2-53 [severity: ux] After a payment inside the clawback window the "At risk" tile drops to $0 (H2, H1)

`record_commission_paid` moves `ledger_state` from at_risk to paid; the Funded tiles count only `at_risk`, so a
commission that is paid but still inside the lender's clawback window (until Dec 16 here) reads as not at risk. Count
paid-inside-window in "At risk" (or show it as "paid · at risk until Dec 16").

## Pass 2 — fix status (2026-11-16, ~02:30 ET)

Every one of the 53 is fixed. Unit suite after the fixes: 93 of 94 files green (`tests/language.test.ts` waits on the
owner's lender/payment vocabulary decision). The browser suites were re-run after this table was written (see
`BUILD-NOTES.md`, "Pass 2 — after the fixes").

| #                        | Status | Where it was fixed                                                                                                   |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| P2-1                     | Fixed  | Goal card says "Set a goal" (the tooltip names the book)                                                             |
| P2-2, P2-4, P2-20        | Fixed  | Dashboard: ops get the queue tiles, managers and ops see whose merchant each "Do this now" line is; unique keys      |
| P2-3                     | Fixed  | `requirePage` on every page: a page outside the role's nav redirects to `/?denied=` with a notice                   |
| P2-5                     | Fixed  | Login page carries the Selective brand and tagline                                                                   |
| P2-6, P2-45, P2-46       | Fixed  | Lender card has the money-terms block (caps, PSF, approval days); preview says which cap refused; PSF wording        |
| P2-7                     | Fixed  | Follow Up lead lines wrap, the lender card stacks its buttons below `sm:`, dashboard tables scroll inside their card |
| P2-8, P2-10, P2-17, P2-21| Fixed  | Sheet rows file as leads (looking-for text, cents not re-parsed, timezone stamped); a bad amount is a refusal        |
| P2-9                     | Fixed  | Duplicate notice names the owner and the bucket, and links to the merchant                                           |
| P2-11                    | Fixed  | Browser suites sweep their templates                                                                                 |
| P2-12, P2-22             | Fixed  | Accessible names on the row menu button and every unlabeled control                                                  |
| P2-13                    | Fixed  | Automated mail waits (deferred, `no_postal_address`) until the shop's postal address is set; Follow Up says so       |
| P2-14                    | Fixed  | Blast confirm is a dialog with the template merged for the first checked merchant and the blank fields named          |
| P2-15, P2-16, P2-32      | Fixed  | Sheets connect/update schemas and SQL; a sheet must be visible under RLS before it is synced                          |
| P2-18                    | Fixed  | `requireRole` outside `try` in every action file                                                                      |
| P2-19                    | Fixed  | Activity feed takes the viewer's zone; the deal page passes it                                                        |
| P2-23                    | Fixed  | Strict UUID check on `/board` filters                                                                                |
| P2-24                    | Fixed  | Edit on a shared template only for managers                                                                          |
| P2-25, P2-26             | Fixed  | Disabling or offboarding revokes lead tokens; every digest, reminder, weekly and lead alert skips inactive accounts   |
| P2-27                    | Fixed  | 0480 `guard_confirmed_funding`: a confirmed funding's money is a manager's to change                                  |
| P2-28                    | Fixed  | Inbound mail drives merchant state only when SPF and DKIM pass or it replies to something we sent                    |
| P2-29, P2-35             | Fixed  | Upload page reuses an open session; the route checks token and sizes before reading; "Reset upload link" rotates it  |
| P2-30                    | Fixed  | 0480 `add_team_member` bumps `session_epoch` on a role change                                                         |
| P2-31                    | Fixed  | Blasts obey `template_may_auto_send`                                                                                  |
| P2-33                    | Fixed  | `manager_note` / `ops_note` gated by role                                                                             |
| P2-34, P2-50             | Fixed  | Lender links are minted by lender id from a dialog, listed live, and revocable (no revoke audit row: needs a migration)|
| P2-36, P2-37             | Fixed  | 0480/0490: audit rows need the right viewer; suppressions readable by managers only, written through `app.suppress`   |
| P2-38                    | Fixed  | "Submit to ops" on the merchant page, "Resubmit" on a kicked-back deal                                                 |
| P2-39, P2-40, P2-42      | Fixed  | Board sends through the lender picker; the send marks the deal sent; shotgun warning in the dialog and on the server  |
| P2-41                    | Fixed  | 0480: ops can write timers and offers on ops deals; the ops loop is unit-tested as the ops role                       |
| P2-43                    | Fixed  | Decline picker reads `decline_reasons` (grouped, with the curable-after text)                                          |
| P2-44                    | Fixed  | "Mark funded" opens FUND on the deal page with that lender picked (needs an open deal)                                 |
| P2-47                    | Fixed  | Every submission status has actions and labels; the pages no longer crash on the new ones                              |
| P2-48                    | Fixed  | Activity tab says each lender event once                                                                               |
| P2-49                    | Fixed  | Offboard stays available on a disabled row                                                                             |
| P2-51                    | Fixed  | Copy controls log `copy_phone` / `copy_email`; a manager or ops opening a rep's merchant logs `view_contact`           |
| P2-52                    | Fixed  | Blank "Paid on" means today (`coalesce` in `recordCommissionPaid`)                                                     |
| P2-53                    | Fixed  | "At risk" counts paid commissions still inside the clawback window                                                      |
