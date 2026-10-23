# Review 3B — adversarial review of today's app-level code (power dial, ranking, bulk, heartbeat, messaging, win-back, ICS, auth surface)

Scope: `src/app/power-actions.ts`, `src/lib/data/{priority,overdue,shell}.ts`, `src/lib/system/heartbeat.ts`, `db/migrations/0003`, the cron route, `src/components/power/**`,
`src/app/(app)/{layout,page,dial,winback,settings}`, `ClientRow`; `db/migrations/0030`, `src/lib/messaging/**`, `src/lib/mca/{notehints,templates}.ts`,
`messaging-actions.ts`, `components/winback/**`, `ContactActions`, `client/{Timeline,FollowUpPanel}`; plus every `"use server"` file and every `route.ts`, the CSV/ICS/email builders,
`next.config.ts` and the manifest. Read at HEAD `4de3dbd`; HEAD moved to `b393d54` during the review (new-lead alert, Monday scorecard, funder package, JIT off) and I re-ran the B-1, B-3 and B-4 repros against it: unchanged.
The new email jobs (`src/lib/system/{leadAlert,weekly}.ts`) and the funder package were not reviewed beyond the two grep results quoted in B-1 and B-2.
Nothing under `src/`, `db/`, `tests/`, `e2e/` was edited.

How things were verified: repro tests against throwaway databases made with `tests/helpers/db.ts` (`createTestDb`; never `isaac_dev`), small `tsx` scripts, and Chromium
(`/opt/pw-browsers/chromium-1194`) on static pages for platform behaviour. The scratch files live outside the repo in
`/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/` (`rep/*.test.ts`, `hints.ts`, `perf.ts`, `ics.ts`, `toast/*`); run the DB repros with
`npx vitest run --config <scratchpad>/vitest.scratch.config.ts <scratchpad>/rep/<file>.test.ts --reporter=verbose`.
Existing suites for this scope pass: `npx vitest run tests/boundaries.test.ts tests/power-*.test.ts tests/priority.test.ts tests/notehints.test.ts tests/winback*.test.ts tests/messaging-*.test.ts tests/reminders-job.test.ts tests/review-fixes.test.ts` → 13 files, 556 tests passed.
Labels: CONFIRMED = I reproduced it; LIKELY = argued from code; QUESTION = needs a decision.

Counts: 0 blocker, 4 bug, 5 risk, 8 nit, 2 question.

Review-2 follow-through (checked in code and by the passing `tests/review-fixes.test.ts`): R-1 (DNC survives trash, `purge_client` refuses), R-2 (`clientDirectory` hides trash), R-3 (purge locks the row),
R-4 (activity export includes trashed merchants with an "In trash" column), R-5 (`SecurityPanel` is on Settings and clears `isaac:*`), R-6 (phones exported as `(305) …`), R-7 (cron answers 502 and skips the heartbeat when a send failed),
R-8 (booking a call writes stage history), R-9 (restore keeps overdue renewal/check-in/chase), R-10 (`timers_live_only` trigger), R-12 (`run(fn, false)` for read-only lookups) all landed.

---

### B-1 [bug] A do-not-contact merchant can still be put in front of Isaac as a call to make (morning email, booked-call email, Today badge)

**Status:** CONFIRMED

**Where:** `src/lib/system/reminders.ts:123-129` (`loadDueTimers`) and `:227-235` (`runCallReminders`) have no `contact_status` filter; `src/lib/data/queries.ts:78-83` (`dueCount`) has none either.
The way in: `set_follow_up` (`db/migrations/0001_init.sql:438`), `move_client`/`app.replace_timers` (`:416`, `:374`) and `schedule_call` (`0090_review_fixes.sql:5`) never look at `contact_status`, and the UI does not gate them
(`src/components/client/FollowUpPanel.tsx:58-66, 84-169` offers "Set follow-up" and "Book the call" on any merchant; the Board drag and the date chips in `Timeline.tsx:167` do the same).
Promise broken: `docs/DECISIONS.md:128-129` ("Today and the morning email skip them") and the dialog text `src/components/client/ContactStatus.tsx:18` ("they never appear on Today or in the morning email").

**Why it matters:** "stop means stop" rests on one invariant, "a do-not-contact merchant's only open timer is 36 months out". Every reminder reader trusts it, and nothing enforces it. The Call/Text/Email buttons stay disabled,
but the 8 AM email says `• Stop Pizza — Mike (555) 123-4567 [Follow up …, today]` and Isaac works from that email. The Today tab title shows "(1)" while Today itself says "You're all caught up".

**Repro/evidence:** `createTestDb`, `insertClient("Stop Pizza")`, `m.setContactStatus(dnc)`, then

1. `m.setFollowUp(q, {dueOn: today})` (what a Board drag / "Set follow-up" does) → `runReminders` sent 1 email whose body lists "Stop Pizza — Mike (555) 123-4567"; `dueCount` = 1; `buildToday(...)` has 0 overdue and 0 due today.
2. `m.moveClient(stage: "not_interested")` on a DNC merchant → the 36-month "Do-not-contact — review this status" timer is closed and replaced by a plain follow-up 12 months out (`[{kind:'follow_up', due_on:'2027-10-23', note:''}]`); after "set back to OK" the card has no trace of the review timer.
3. `m.scheduleCall` at 23:30 on a DNC merchant, `runCallReminders` at 22:30 → `{sent: 1}`, subject "Call at 11:30 PM: Stop Taco".

**Suggested fix:** add `and c.contact_status <> 'dnc'` to `loadDueTimers`, `runCallReminders` and `dueCount` (the new Monday scorecard already does this: `src/lib/system/weekly.ts:76, 82` filter `contact_status = 'ok'`, so the three older readers are now the odd ones out); make `set_follow_up`, `replace_timers` and `schedule_call` refuse a `dnc` merchant (same trigger style as `timers_live_only`) and disable the date/booking controls in the UI. Add the tests listed under "Missing tests" 1.

---

### B-2 [bug] Taking someone off `ALLOWED_EMAILS` ends their login but not their reminder emails

**Status:** CONFIRMED (code + the B-1 repro: it sent a digest with `ALLOWED_EMAILS` unset, which `isAllowedEmail` treats as "nobody allowed")

**Where:** `src/lib/system/reminders.ts:68-76` (`runReminders` selects every `app_users where digest_enabled`), `:223-239` (`runCallReminders`), `src/app/api/cron/reminders/route.ts:20-47` (`handle`; another builder was editing this route while I reviewed, line numbers may have moved). `grep -rn "ALLOWED_EMAILS\|isAllowedEmail" src` finds the allowlist in the session check
(`src/lib/auth/server.ts:16`), the OAuth callback and the lead route (`src/app/api/leads/route.ts:33-35`, whose comment says "Taking someone off ALLOWED_EMAILS must switch their token off too") — never in `src/lib/system/` or the cron route.

**Why it matters:** the allowlist is the only off-switch the owner has for a person (a VA, an ex-partner). After removal they cannot sign in, but every morning they still receive merchant names, contact names, phone numbers, timer notes, and (call reminder) the last call note and the amount wanted, at their own address. `notify_email` is deliberately not user-editable (`0030_snippets.sql:27-29`), so the owner cannot redirect it either.

**Repro/evidence:** `runReminders({db, now, appUrl, send})` never reads `env()`; with `ALLOWED_EMAILS` empty it still sent (see B-1 repro 1).

**Suggested fix:** in the cron route pass an `isAllowed(email)` predicate (the same one `getSession` uses, honouring `devLoginEnabled()`) and skip users who fail it in both loops (count as `skipped`). The Monday scorecard added during this review has the same gap (`src/lib/system/weekly.ts:115` selects every `digest_enabled` user); the new-lead alert is behind the token check, which already honours the allowlist.

---

### B-3 [bug] A booked call is not treated as an appointment when another timer is older or due the same day

**Status:** CONFIRMED

**Where:** `db/migrations/0040_trash.sql:37-42` (`client_cards.next_due_*` = `order by t.due_on, t.created_at limit 1`), `src/lib/data/views.ts:80-82` (`scheduled` only when `next_due_kind === 'scheduled_call'`), `src/app/(app)/dial/page.tsx:253-256` and `src/components/power/DialRunner.tsx:45-53` (booked calls first only by that same test), `src/components/ClientRow.tsx:92-97` (no booked time on the row).
`schedule_call` does not close the follow-up (by design), so the follow-up and the call coexist.

**Why it matters:** "Calls booked today (they are appointments, earliest first)" is the promise of both Today and the dial queue. On a tie the older timer wins, so a 3 PM appointment sits in "Due today" ranked by money, shows no time, and is dialled whenever its turn comes. Only the 90-minute booked-call email protects it. The tie is the normal flow: log a call (next follow-up "tomorrow" for an underwriting stage), then book the call for tomorrow.

**Repro/evidence:** `insertClient(due: today)`, `m.scheduleCall(at: today 23:00)` → `card.next_due_kind = 'follow_up'`, `buildToday`: `scheduled: 0, dueToday: 1`. Same with an overdue follow-up (due 2 days ago) plus a call today: the client is in `overdue`, `scheduled: false`.

**Suggested fix:** classify by the booking, not the earliest timer: in `buildToday` and `arrange()` treat any card whose `scheduled_call_at` falls on `today` (in the user's zone) as scheduled and show "Booked 3:00 PM" on `ClientRow`; or break ties in the view with `(t.kind = 'scheduled_call') desc`.

---

### B-4 [bug] "Reschedule all overdue" overwrites the reason on every follow-up with "Rescheduled in bulk"

**Status:** CONFIRMED

**Where:** `src/lib/data/overdue.ts:54-67` (`applyMoves` passes `BULK_NOTE` as `set_follow_up`'s note), `db/migrations/0001_init.sql:448-453` (`set_follow_up` closes the old follow-up and inserts a new row with only that note), `src/lib/data/priority.ts:336`.
Read back by `followUpReasons` (`overdue.ts:143-155`) for the dial's "Why now" and by `FollowUpPanel.tsx:40`.

**Why it matters:** the note on a follow-up is the reason the call exists ("Wait for tax return, call after the 3rd"; for lost deals "Competitor advance should be ~50% paid down"). After one bulk click, 200 merchants show "Rescheduled in bulk" instead, and the dial's "Why now" row is useless for them. The old text survives only on a closed timer row that no screen shows.

**Repro/evidence:** two overdue follow-ups with those two notes, `bulkReschedule(days 5)` → `followUpReasons` returns `{"kind":"follow_up","note":"Rescheduled in bulk"}` for both.

**Suggested fix:** carry the old note forward (`coalesce(nullif(old.note,''), …) || ' — rescheduled in bulk'`), either in a `set_follow_up(p_keep_note boolean)` variant or in `applyMoves` by reading each client's current follow-up note first; the timeline line already says "Rescheduled in bulk".

---

### B-5 [risk] Setting a merchant back to "OK to contact" leaves them parked for 36 months

**Status:** CONFIRMED

**Where:** `db/migrations/0002_do_not_contact.sql:48-80` (`set_contact_status`: only the `dnc` branch touches timers), `src/components/client/ContactStatus.tsx:42-62` (no date is asked for).

**Why it matters:** marking DNC by mistake, or a merchant who calls back and says "yes, contact me", is undone with one radio button, and the merchant keeps the single timer `2029-10-23 "Do-not-contact — review this status"`. They vanish from Today for three years and the owner sees nothing wrong (the card has a next date).

**Repro/evidence:** `setContactStatus(dnc)` then `setContactStatus(ok)` → open timers `[{follow_up, 2029-10-23, 'Do-not-contact — review this status'}]`.

**Suggested fix:** when leaving `dnc`, replace the 36-month review timer with a follow-up a few days out (or require a date in the dialog), and say so in the dialog.

---

### B-6 [risk] The Text dialog only warns about unfilled `{fields}`; the Email dialog blocks

**Status:** CONFIRMED (code)

**Where:** `src/components/ContactActions.tsx:263-266, 320-324, 332` (Text: `leftover` is a warning; "Open in Messages" and "Open Google Voice" stay live and "I sent it" stays enabled) versus `:424-425, 457-461, 488` (Email: `blocked` disables both send paths).

**Why it matters:** `merge.ts` promises "Hey , here's the link:" can't go out. On a phone the default "Send application" snippet on a merchant when Settings has no application link leaves `{application_link}` in the text, and one tap sends it to the merchant. Texts are the hardest messages to retract.

**Suggested fix:** apply the same `leftoverFields(...).length > 0` rule to the Text dialog's two links and "I sent it" (disabled `aria-disabled` link with the reason), as the Email dialog does.

---

### B-7 [risk] The one-tap outcome prompt opens its keyboard on a phone

**Status:** LIKELY (not testable here: needs iOS/Android)

**Where:** `src/components/ContactActions.tsx:673` (`<Textarea … autoFocus />` inside `PendingTouchPrompt`).

**Why it matters:** the prompt appears right after every call, text and email. On a touch device `autoFocus` raises the on-screen keyboard immediately; the outcome buttons are above the note box and the "Log it" footer is below it, both partly under the keyboard in a `max-h-[85vh]` centred dialog on a short screen. The whole feature is "one tap after a call".

**Suggested fix:** autofocus only when `!window.matchMedia("(pointer: coarse)").matches` (the file already has `isTouchDevice()` at `:101`), or focus the first outcome button instead.

---

### B-8 [risk] Missing reminder configuration is invisible in production, and "configured" is defined three ways

**Status:** CONFIRMED (code)

**Where:** `src/lib/system/heartbeat.ts:77-90` (`configured = RESEND_API_KEY && CRON_SECRET`; unconfigured → `stale: false`, no banner), `src/app/api/cron/reminders/route.ts:12-18, 24-29` (needs `CRON_SECRET`, `RESEND_API_KEY` **and** `RESEND_FROM`), `src/app/(app)/settings/page.tsx:87` (`resendReady = RESEND_API_KEY && RESEND_FROM`), `src/app/(app)/layout.tsx:85`.

**Why it matters:** the banner exists so the owner is never silently without reminders, but the one failure it cannot see is "never configured": no `RESEND_API_KEY` (or a typo'd `CRON_SECRET`) in production looks exactly like local dev, and the only hint is a muted sentence on the Settings page. A missing `RESEND_FROM` alone does trigger the banner (route 503 → no heartbeat), but a missing `CRON_SECRET` does not (route 401, banner off).

**Suggested fix:** in production (`NODE_ENV === 'production'`) treat "not configured" as stale after the account is a day old, with the banner text saying which variable is missing; one `reminderConfig()` helper used by the route, the banner and Settings.

---

### B-9 [risk] The snooze guard is two components wide, and "Snooze" on a booked-call card does nothing visible

**Status:** CONFIRMED

**Where:** `src/lib/data/priority.ts:327-329` and `src/components/power/SnoozeMenu.tsx:36-64` are the only callers of `snoozeNeedsReason`; the same underwriting deal can be pushed with no question through `FollowUpPanel.tsx:100` (`setFollowUpAction`), the Board drag (`moveToBucketAction`, `src/app/actions.ts:54`), the note chips (`Timeline.tsx:167-170`) and the win-back "Not now" (`WinbackList.tsx:61`). `set_follow_up` (`0001_init.sql:438-457`) never touches a `scheduled_call` timer.

**Why it matters:** the guard's goal is that "underwriting deals die when left alone"; a deal in Stips snoozed 90 days via the plain action succeeds silently (`UW snoozed to 2027-01-21 no reason asked`). Separately, a client with a call booked today who is snoozed from the dial or Today row gets a "snoozed until …" toast and stays exactly where it was (`scheduled: 1` before and after), so in the dial queue the same card comes straight back.

**Suggested fix:** call the guard from the Board drop and `SetFollowUp` too (UI only; it never blocks), and when a client has a booked call today have Snooze say "this client has a call booked at 3 PM" instead of a success toast.

---

### B-10 [nit] One permanently failing recipient pins the cron at 502 and the banner red for everyone

**Status:** LIKELY

**Where:** `src/app/api/cron/reminders/route.ts:~40-47` (the `failed > 0` branch; the on-disk version also counts a new `weekly` job that I did not review), `src/lib/system/reminders.ts:103-112`.

**Why it matters:** a bounced or invalid `notify_email` (or a user the allowlist should have removed, B-2) fails every hour; the route never records a heartbeat, the banner stays red for the healthy user too, and the 502 body carries only counts, not which user. For one owner this is fine; it matters the day there is a second user.

**Suggested fix:** include the failing user ids in the 502 body (they are already logged) and consider a per-user heartbeat.

---

### B-11 [nit] Toasts raised while a modal dialog is open render under its backdrop

**Status:** CONFIRMED in Chromium (static page: a `position:fixed; z-index:50` element, then `dialog.showModal()` → `document.elementFromPoint` at the toast returns the `DIALOG`; the toast is dimmed by the `bg-black/50` backdrop and cannot be clicked)

**Where:** `src/components/overlay.tsx:94-100` (toast container, normal stacking) vs `:38` (`<dialog>` modal = top layer).

**Why it matters:** every failure inside a dialog (`BulkDialog.submit`, snippet save "You already have a text snippet called…", email send, the outcome prompt) shows its error toast dimmed and with an unclickable action; any toast action button cannot be pressed until the dialog closes.

**Suggested fix:** render the toast host in the top layer (a `popover="manual"` element, `showPopover()` on first toast), or show action errors inline in the dialog.

---

### B-12 [nit] Accessibility details

**Status:** CONFIRMED for the first, LIKELY for the rest

- The shared `Dialog` (`src/components/overlay.tsx:38-45`) has no accessible name. Chromium's accessibility snapshot of the same markup gives `- dialog:` with no name, while the palette (`aria-label`) gives `- dialog "Find a client"`. Affects Bulk, Text, Email, outcome prompt, snippet editor, contact status. Fix: `aria-labelledby` on the `<h2>`.
- The due-count badges use `aria-label` on a bare `<span>` (`NavLink.tsx:31`, `MobileTabBar.tsx:96`); a label on an element with no role is not reliably announced, so a screen reader reads "12". Use visually hidden text.
- `SnoozeMenu` is a `<details>` dropdown with no Escape/outside-click close (`SnoozeMenu.tsx:118-157`), unlike `SnippetPicker`, which closes on outside tap.
- The dial footer has Skip and Next only (`DialRunner.tsx:220-237`); "Previous" exists only as the `P` key, so on a phone there is no way back.
- Star, Snooze and chip targets are 32 px high (`ClientRow.tsx:126`, `SnoozeMenu.tsx:126`, `HintChips.tsx:229`), below the 44 px touch guideline.

---

### B-13 [nit] The search palette's client list is cached for 30 seconds, so a just-added merchant cannot be found

**Status:** CONFIRMED (code)

**Where:** `src/components/power/GlobalSearch.tsx:22, 71-88` (`FRESH_MS`), the state lives in the layout and survives navigation.

**Why it matters:** the inbound-call lookup is the feature's selling point; add a lead from a call, take a second call from the same number within 30 s and the palette says "No client has that number". A merchant trashed in the last 30 s still opens a 404.

**Suggested fix:** reset `fetchedAt` when the layout re-renders (`useApp().nowMs` changes after every action, because each one calls `revalidatePath("/", "layout")`), or lower `FRESH_MS` to a few seconds.

---

### B-14 [nit] Note-hint edge cases (chips only; nothing is ever applied without a tap)

**Status:** CONFIRMED (ran `noteHints` with today = 2026-10-23 unless noted)

- `"I called him back on the 15th"` → Monday Nov 16: "back" counts as a future cue (`FUTURE_CUE`, `notehints.ts:225`) so the past verb is overridden.
- `"call back Feb 29"` → `2028-02-29`, 16 months out, because `nextYearless` loops to the next leap year (`:284-298`); a 29 Feb in a note almost always means "end of February".
- `"call back on the 31st"` on Nov 30 → today (clamped to the 30th, `:74`), although the next real 31st is a month away.
- `"call back after tax season"` on 2026-04-25 → `2027-04-20` (a year out, `periodMatcher`).
- `"call back in 4 years"` / `"in 200 months"` → the stage's usual pace (2 business days) with the reason "No date I could read": honest, but surprising next to a note that clearly said "years".
- Checked and fine: year rollover (Dec 28 "Jan 5" → 2027-01-05), `after the 15th` on the 15th/16th, month-end clamping (Jan 30 + 1 month → Mar 1 after the weekend roll), explicit dates in the past and beyond 36 months are dropped (`inWindow`), weekend → Monday with the reason shown. 5,000-character pathological notes take at most 41.7 ms (`tsx perf.ts`: 16 inputs, worst `"the 1st " × 600`), so no ReDoS.

**Suggested fix:** cap the past-tense override only when the clause has no verb of intent ("call/text/follow up … back" is a cue, "called him back" is not); drop the leap-day case to Feb 28.

---

### B-15 [nit] Messages card says the built-in snippets are gone when only one kind has been saved

**Status:** CONFIRMED (code)

**Where:** `src/components/winback/MessagesCard.tsx:56, 132-171` (`usingDefaults = snippets.length === 0`, any kind) vs `src/lib/messaging/defaults.ts` (`snippetsFor` falls back per kind).

**Why it matters:** save one text snippet and the Email picker still offers the six built-ins, but Settings no longer lists them or offers "Customize email", so the owner cannot see or edit what the Email dialog is using.

**Suggested fix:** compute `usingDefaults` per kind and show the built-in rows for the kind that has none.

---

### B-16 [nit] The RLS-bypass boundary is a grep for one word

**Status:** CONFIRMED (grep)

**Where:** `tests/boundaries.test.ts:18-27` (only `withSystem`). `getPool`, `makeDb` and `pg.Pool` from `src/lib/db` give the same owner connection and are not covered; today only `scripts/` and `tests/` use them (`grep -rn "getPool\|makeDb\|new pg\." src scripts`).

**Suggested fix:** extend the test to the three names; allowed: `src/lib/db/`, `src/lib/system/`, `src/app/api/`.

---

### B-17 [nit] Email builder: one long encoded-word subject, and a long Gmail compose link

**Status:** LIKELY

**Where:** `src/lib/email/raw.ts:16-19` (the whole subject becomes a single `=?UTF-8?B?…?=` word when it has any non-ASCII character, e.g. the em dash in the built-in subjects "Update on your offers — {business}"), `src/components/ContactActions.tsx:468` (`gmailComposeHref` puts the whole body in the URL).

**Why it matters:** RFC 2047 caps an encoded-word at 75 characters and RFC 5322 a line at 998; a 200-character subject with an em dash breaks both. Gmail is lenient, strict MTAs are not. A 5,000-character body in the compose URL is truncated by browsers/Gmail.

**Suggested fix:** split into several encoded words of at most 45 source bytes (folded with CRLF + space); fall back to a short body with a "paste the rest" toast beyond ~2,000 characters.

---

### B-18 [question] Compliance wording for defaulted merchants in win-back and the dial

**Where:** `src/lib/messaging/winback.ts:12-19` (`written_off` is a win-back stage), `src/lib/mca/templates.ts:71-72, 194-195` (`default` tone for `default_workable`, `default_bad`, `legal_collections`, `written_off`), and Today/Dial include `legal_collections` merchants ("With counsel or a collector", `stages.ts`) with the pre-filled text "I'd like to help get {biz}'s account back on track. Can we talk today about a plan that works for you?".

**Why it matters:** a one-to-one text to a merchant whose account is with counsel or a collector can be unwelcome or worse. DECISIONS.md already says counsel should confirm the TCPA posture for texts. Decide whether those two stages are suppressed from win-back and from the dial's text template.

---

### B-19 [question] Calendar export puts phone and last-call note outside the app; iOS file download unverified

**Where:** `src/lib/messaging/ics.ts:145-153, 189-201`, `src/components/winback/AddToCalendar.tsx:49-62`.

**Why it matters:** the Google Calendar link (a URL, so also browser history) and the `.ics` carry the merchant's phone, what they want and the last call note. It is a user-initiated action, so probably fine, but it is merchant data leaving the RLS boundary. Separately: the blob `.ics` download works under the production CSP (I served the exact `next.config.ts` CSP string from a local server in Chromium and got the `download` event with no violation), but an installed iOS PWA (standalone) is known to be unreliable with `a[download]` on blob URLs and I could not test it.

---

## Missing tests (behaviours that could regress)

1. A do-not-contact merchant that gets a timer after the status was set (`set_follow_up`, `move_client`, `schedule_call`) is absent from `runReminders`, `runCallReminders` and `dueCount` (B-1); moving a DNC merchant keeps a review timer.
2. A user not on `ALLOWED_EMAILS` gets no digest and no call reminder (B-2).
3. `buildToday` and the dial queue: a booked call that ties with, or follows, an older timer is in `scheduled` and shows its time (B-3).
4. Bulk reschedule preserves the follow-up reason (`followUpReasons` after `bulkReschedule`) (B-4); un-DNC leaves a near-term follow-up (B-5).
5. `DialRunner` logic has no unit test at all (only the local e2e, which CI does not run): `arrange()` (booked, then starred, then ranked), skip/next/previous cursor behaviour, and "shortcuts are ignored in input/textarea/select/contentEditable and while any `<dialog>` is open". Extract the pure parts or add a jsdom test.
6. Text dialog with a leftover `{application_link}` must not offer a live send link (B-6).
7. Structural: every exported function in every `"use server"` file reaches `requireSession()`; deleting the call in `run()` (or in `sendEmailAction`) currently fails no unit test (e2e only). Also the `getPool`/`makeDb` boundary (B-16).
8. `reminderStatus` vs the route's required variables: `CRON_SECRET` missing, `RESEND_FROM` missing, `RESEND_API_KEY` missing in production (B-8).
9. Production CSP: a test or build step that asserts the header on `/login`, `/manifest.webmanifest` and one authenticated page (`4de3dbd` verified 15 pages by hand; `tests/zod-csp.test.ts` only checks `jitless`).
10. Palette directory freshness after add/trash (B-13); `noteHints` for B-14's inputs; Messages card per-kind defaults (B-15).
11. Cron with one permanently failing user: the 502 body names the user, the other user's digest is still sent once (B-10).

---

## Looked at and fine

- **Auth on every entry point.** All six `"use server"` files (`actions.ts`, `power-actions.ts`, `messaging-actions.ts`, `earnings-actions.ts`, `funders-actions.ts`, `lead-actions.ts`) call `requireSession()` (epoch-checked through `getSession`/`resolveSession`) before any data access, inside `db.withUser`; `logoutAction` is the only action that needs no session. All seven route handlers authenticate first: exports via `getSession` (401), leads via bearer token with a rate limit, cron via a constant-time bearer compare (length-checked `timingSafeEqual`), OAuth routes via the signed state cookie, dev-login behind `devLoginEnabled()` (false in production, localhost-only otherwise).
- **No client-supplied ids reach the owner connection.** `withSystem` appears only in `src/lib/system/**` (users, heartbeat, reminders, leads, gmail), and every caller passes `session.userId`, never an id from the request; `tests/boundaries.test.ts` passes. `grep security definer db/migrations` → none, so every function runs under RLS. Cross-user calls (`snoozeWithReason`, `bulkReschedule` with a foreign id, `getMessagingContext`, `saveSnippet(id)`, `followUpReasons`, `snoozeCounts`, `clientDirectory`) are covered by passing tests and return "no longer exists"/nothing.
- **Validation.** Every action parses `unknown` with zod inside the `run` callback; errors go through `toActionError` (first Zod message, whitelisted Postgres codes, everything else logged and replaced by a generic string). All SQL is parameterised; the few template-string queries interpolate constants (`COLUMNS`, `offerSql`, the `CLIENT_COLUMNS` map, a fixed function name).
- **Injection.** No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in `src`. The only `href`s built from data are `tel:`/`sms:` from `normalizeUS` (digits only, E.164), `voice.google.com` and `calendar.google.com` links built with `encodeURIComponent`/`URLSearchParams`, and `mail.google.com` with `URLSearchParams`. `application_link` must be `https?://` in zod (`messaging/schemas.ts:81-89`) and in a DB check (`0030_snippets.sql:31-32`); a `javascript:` value is rejected at both. A snippet body is only ever inserted into message text, never into an `href`. No redirect target comes from user input (`redirect()` and `NextResponse.redirect` use constants or `APP_URL`; `?error=` is looked up with `Object.hasOwn`).
- **ICS.** A hostile business name, phone, topic, note, UID and URL containing `\r\nATTENDEE:…\r\nEND:VEVENT\r\nBEGIN:VEVENT` produce 30 lines, 22 of them the expected properties (the rest folded continuations), and no injected line (`ics.ts` probe); control characters are dropped, backslash/semicolon/comma/newline escaped, the URL stripped of whitespace, lines folded at 75 octets without splitting a character, start/end in UTC. (U+2028 and U+0085 pass through raw; RFC 5545 only treats CRLF as a break, so this is cosmetic.)
- **CSV.** Formula guard looks past leading whitespace (`trimStart`), covers `= + - @ TAB CR`; phones export as `(305) …`; `activityRows` carries the trash flag.
- **Emails.** Digest and call-reminder HTML escapes `& < > "` in every interpolated value and href; subjects strip control characters; the Resend call is JSON; the Gmail raw builder rejects CR/LF in any header and requires exactly one address; `to` comes from the merchant row, not from the request; `notify_email` is not writable by the app role.
- **Headers/CSP/PWA.** `script-src 'self' 'unsafe-inline'` is what Next needs; no page loads an external script, font, image or style; there is no `fetch`, WebSocket or beacon to another origin from the browser, and `connect-src 'self'` and `img-src 'self' data: blob:` do stop exfiltration; `frame-ancestors 'none'`, `form-action 'self'`, `Permissions-Policy`, HSTS and `Referrer-Policy: same-origin` are present. The manifest and icons are public on purpose, there is no service worker, and `viewport` has no `viewport-fit=cover`, so the `env(safe-area-inset-*)` paddings are harmless.
- **Bulk reschedule.** All-or-nothing in one `withUser` transaction (a foreign id or a past date rolls back every earlier move: covered by `tests/power-bulk.test.ts` "all or nothing"), 200-client cap with the remainder reported, business-day slots (weekend start → Monday, remainder dealt to the earliest days), do-not-contact, trashed (hidden by `client_cards`), underwriting (switch), booked-call and funder-chase clients are skipped; funded clients keep their `renewal`/`check_in` kinds and only move forward; a later renewal call is never pulled in; a second run moves nothing; the "snoozed N×" count excludes bulk moves. Repro: funded client with a renewal 2 days overdue → renewal and a new follow-up both land today, renewal note intact.
- **Today/dial coverage.** `buildToday` partitions every non-DNC card with a next date into exactly one of scheduled/overdue/due today/upcoming; the dial queue is `scheduled + rank(overdue + dueToday)`, so the same set and each client once; ranking cannot hide anyone (a NaN score sorts as a tie, nothing filters). A logged client leaves the queue because the page re-renders from the server; skipped clients keep their slot at the back; shortcuts are ignored in inputs and while any `<dialog>` is open; the header is `inert` and the palette is portalled to `body`, so Ctrl+K still works full-screen.
- **Win-back eligibility.** `loadWinback` and `buildWinback` both require `contact_status = 'ok'` (a no-text merchant is left out entirely), trashed merchants are hidden by `client_cards`, stages are the explicit six, the window is clamped to 1–365, and "texted today" uses the user's zone.
- **Merge fields and snippets.** One-pass resolution (a value containing `{business}` is not expanded again), braces stripped from values, unknown fields rejected at save, snippets have RLS from creation with a per-user unique title, column grants for `signature`/`application_link` only.
- **Heartbeat.** `job_runs` has RLS on and no grant for the app role (tested); a run with any failed send answers 502 and records nothing; a clock ahead of the database cannot show negative hours; a brand-new account is not alarmed for a day.
- **REVIEW-2 fixes** listed at the top landed and are covered by tests.
