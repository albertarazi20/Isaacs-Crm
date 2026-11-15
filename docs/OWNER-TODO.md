# Owner to-do — only the things Claude cannot do

Never paste secrets (API keys, client secrets) into chat. Put them in the hosting provider's
environment variables; Claude only needs to be told they are set.

## A. You, in this order (about 2 hours of your own time)

**Already done (re-verified 2026-11-15):** the database. A Supabase project holds all 31 migrations, and a fingerprint of
its schema matches a plain local migrate on every check (`docs/DECISIONS.md`, "First real database").

1. **Merge PR #1.** Done: it and every later pull request are merged. CI works again as of 2026-11-15 (the free GitHub Actions minutes had been
   used up by another repository for a while).
2. **Netlify** (30 min). **Done: the site `mca123` exists and builds this repo.** Still to check: its environment variables, sign-in and the scheduler. Add new site → Import from GitHub → `ronny-arch/Isaac`, branch `main`. Netlify detects Next.js; `netlify.toml` pins Node 22. Set these under Site configuration → Environment variables, never in chat:

   | Name                                             | Value                                                                                                                                                                                                                                |
   | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `DATABASE_URL`                                   | Supabase → Connect → **Transaction pooler** (port 6543), your password filled in (URL-encode `@ : / # ?` in it), then add `?sslmode=no-verify` at the very end. Without it you get an unencrypted connection or a certificate error. |
   | `SESSION_SECRET`, `TOKEN_ENC_KEY`, `CRON_SECRET` | Run this in Terminal and paste each line into Netlify: `printf 'SESSION_SECRET=%s\nTOKEN_ENC_KEY=%s\nCRON_SECRET=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)"`                          |
   | `APP_URL`                                        | The public address, `https://…`, **no trailing slash**. Deploy once to learn it, set it, redeploy. Use this exact address everywhere (Google, the scheduler).                                                                        |
   | `ALLOWED_EMAILS`                                 | Isaac's Google address only.                                                                                                                                                                                                         |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`       | From step 3.                                                                                                                                                                                                                         |
   | `RESEND_API_KEY`, `RESEND_FROM`                  | From step 4.                                                                                                                                                                                                                         |
   | `DEV_LOGIN`                                      | Leave unset.                                                                                                                                                                                                                         |

   Netlify's free plan: I could not confirm from its terms that commercial use is allowed; check your own plan. Hosted functions may be
   held to 10–60 seconds (sources disagree), which is why the import now goes up in slices of 100 rows.

3. **Google Cloud** (30 min), a new project just for Isaac. Enable the **Gmail API**. OAuth consent screen: scopes `openid email
profile` and `gmail.send`; set it to **In production** (an "unverified app" warning appears and is fine for one user),
   or leave it in Testing and add Isaac as a test user and expect to reconnect Gmail every 7 days. Create an OAuth client,
   type "Web application", redirect URI exactly `<APP_URL>/api/auth/callback`.
4. **Resend** (10 min). Quickest: sign up **with the same email Isaac signs in with** and set `RESEND_FROM=onboarding@resend.dev`
   (Resend's shared test sender; it only delivers to the account's own email, so reminders reach only Isaac). Later, a verified
   domain of his own replaces it. No BH domain.
5. **Hourly scheduler** (10 min). cron-job.org (free): `GET <APP_URL>/api/cron/reminders` every hour with header
   `Authorization: Bearer <CRON_SECRET>`. Turn on its failure alerts: they are the first warning, because the in-app banner
   stays quiet for the first 24 hours of an account.
6. **Tell Claude the address.** Claude runs `node scripts/smoke-live.mjs <APP_URL>` (public checks, no login) and, with your
   OK, `--run-cron` once. Then Isaac signs in and Claude proves Gmail and the reminder email end to end.

## B. Isaac (one 30–45 minute call with him)

| #   | Ask him                                                                                                                                                                                                                       | Time   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 7   | Read the stage names and default timers (the board now shows seven stages: see `docs/handoff/MCA-KNOWLEDGE.md`). Right names? Right order? Right timers?                                                                      | 15 min |
| 8   | At what % paid down do funders let him renew? (the app assumes **50%**)                                                                                                                                                       | 2 min  |
| 9   | Does he submit to outside funders, fund himself, or both? Which states does he write business in? (state disclosure rules)                                                                                                    | 5 min  |
| 10  | Does he have Google Workspace or a regular Gmail? (changes the Google mode in #4) What time zone and what hour does he want the morning email?                                                                                | 3 min  |
| 11  | His existing clients as a spreadsheet (CSV export from wherever they live now).                                                                                                                                               | 15 min |
| 12  | **Phone test with Isaac holding his phone:** tap Call and Text on a test client and tell Claude what opens (Messages? Google Voice?). Google gives no official Voice link, so this is the one thing only his phone can prove. | 15 min |

## C. Decisions for you (reply yes/no)

- Keep lint/typecheck/format in CI? CLAUDE.md says CI runs "unit tests + a real build. Nothing else." They add about 20 seconds. Say the word and I drop them.
- **Bank statements / documents:** the app stores none (CLAUDE.md: documents live in private object storage, never in a table). If Isaac wants to attach statements to a merchant, pick a storage provider (a private bucket in the same Supabase/Neon account is simplest) and say yes — it's a half-day build. Until then "stips received" is a checkbox.
- **Lead intake:** if Isaac gets leads from a website form or a vendor, make a connection in the app (Clients → Lead intake) and paste the token into Zapier/the vendor — 5 minutes (`docs/LEAD-INTAKE.md`). Optional.
- **Take a backup once it's live and try the restore on a copy** (`docs/BACKUP.md`) — 10 minutes, and you'll know it works before you need it.
- Pull requests are merged by Claude (you said so on 2026-10-26). Anything that changes the live database or the live site needs your OK and a backup first (`docs/handoff/README.md`).
- Already built without waiting on you: do-not-contact flag, per-funder submissions and offers, power-dial, win-back, earnings. Look at them in `docs/BACKLOG.md`.

## D. Ask a lawyer or compliance person (Claude cannot answer these)

- Which states Isaac writes business in, and whether any needs a **broker registration or disclosure** (for example, Texas reportedly has a broker registration deadline at the end of 2026 — unverified, check it).
- **Texting merchants** (TCPA / state rules): do his merchants consent to texts? The app blocks do-not-contact merchants and warns outside 8am–9pm, but consent is a legal fact, not a feature.

## Rough timeline if you start today

You (A): 2–3 hours of effort, longest wait is the Resend DNS. Isaac (B): one call. After A and B are done, Claude needs
about 1–2 hours to wire the real keys, prove login, Gmail and reminders end to end, and fix what breaks.
**Isaac on real clients: about 2–3 days from the day you do A.**
