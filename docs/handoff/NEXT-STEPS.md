# Next steps, in order

> **MCA-CRM note (2026-11-15):** this file describes Ronny's original Isaac deployment (Supabase `vngxqywqqdmucvcdjfec`, Netlify `mca123`). This repo uses Supabase project `aztoxzcmnvqaypjuuuwj`. Never run anything against the Isaac project or site. See `CLAUDE.md`.

## 0. Before anything else (30 minutes)

- [ ] Read `README.md`, `STATE.md`, `CLAUDE.md`, then `docs/DECISIONS.md` (skim the headings).
- [ ] Run `pnpm check` with `TEST_DATABASE_URL` set. If anything is red, fix it before building. Today it was green.
- [ ] Re-run the browser tests (`pnpm e2e`, see `e2e/run.mjs`) because pull requests 3 to 9 changed the board, Today and
      client page after the last full run. Write down every failure, then fix the list.
- [ ] Run `node scripts/smoke-live.mjs https://mca123.netlify.app` (the live Netlify site) and report the result.
- [ ] Ask the owner two things: Is the 24-client data real? Has the exposed Resend key been replaced?

## 1. Only the owner can do (do not attempt)

Create accounts, accept terms, pay, type secrets into the host, put the app in front of Isaac, and the phone test (tap
Call and Text on Isaac's phone and report what opens). Also: ask a lawyer about state broker rules and texting consent
(TCPA). Details in `docs/OWNER-TODO.md`. Keep that list short and in order, and give him nothing you can do yourself.

## 2. You can do now

1. **Fix the two Supabase advisor warnings** on `app.current_user_id` and `app.touch_updated_at` (mutable `search_path`).
   Write a migration (next number 0290), prove it on a local database, then apply it to the project the way `SUPABASE.md`
   describes and re-run the fingerprint check.
2. **Go-live checklist**: `docs/DEPLOY.md` and the owner's finish list in `artifacts/finish-list.html`.
3. **Backlog** (`docs/BACKLOG.md`): page the Clients list, bank-statement upload (needs the owner's storage decision), consent capture
   (needs counsel), web push, small tap targets on Today. Pinning Supabase's CA for verified TLS and gzipping the backup are written up in
   `docs/DECISIONS.md` (the first real database and the host sections), not in the backlog.
4. **Carry-over from the reviews** (still open in `docs/BACKLOG.md`): one definition of the renewal day to call about (A-11);
   estimates presented as facts, such as the pre-filled "Record received" box (A-14); row-level security keys on a setting the app role
   can change, fine while no SQL is built from input and guarded by `tests/boundaries.test.ts` (A-17); the new-lead email is sent inside the
   request (A-19); foreign keys prove "same user", not "same merchant", and two `app` helpers lack `search_path` (A-20, overlaps item 1);
   a deal that leaves and re-enters the funding pipeline gets no new chase timers (A-22).
5. **Not yet run end to end**: `docs/TEST-PLAN.md` as a whole (`docs/BACKLOG.md` section 3). "Green" in `STATE.md` means the automated
   checks, not that plan.
6. **Passcode sign-in has no rate limit** (only a one-second delay). Add one, and ask the owner whether `ACCESS_PASSCODE` is set on the
   live site and how strong it is.
7. **Open owner decisions** in `docs/OWNER-TODO.md` section C: keep lint, typecheck and format in CI, bank-statement storage, lead intake,
   a backup drill.
8. **Isaac's call** items: stage names and timers (now seven stages), the 50% renewal line, funders and states, Workspace
   or plain Gmail, CSV of his real clients. List in `docs/OWNER-TODO.md` section B.

## 3. How to keep the owner's trust

- Short sentences. Tell him where he is losing energy and what competitors do that he does not.
- When he asks "are we done", give a number with the command that produced it.
- Never say done if something is untested. Say what was not run.
- Do the work yourself. Ask only for what a person must do.
