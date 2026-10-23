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
