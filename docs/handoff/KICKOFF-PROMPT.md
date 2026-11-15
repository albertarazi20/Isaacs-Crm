# Paste this into the new Claude

Use this as the first message in a new Claude session (Claude Code, or a Claude project) that has the repository
`ronny-arch/Isaac` connected. Do not add secrets to it.

---

You are taking over the build of Isaac's MCA follow-up CRM from another Claude. The repository is `ronny-arch/Isaac` (default branch
`main`). Before you do anything else:

1. Read `CLAUDE.md`, then `docs/handoff/README.md`, `STATE.md`, `NEXT-STEPS.md`, `MCA-KNOWLEDGE.md`, `OWNER-AND-WORKING-STYLE.md`, `SUPABASE.md` and `LESSONS.md`.
2. Run `pnpm install`, then `pnpm check` with `TEST_DATABASE_URL` pointing at a local Postgres. Tell me the real result.
3. Re-run the browser tests (`pnpm e2e`) because several features landed after the last full run, and list every failure before fixing any.
4. Do step 0 and step 2 of `NEXT-STEPS.md` yourself. Only come to me for what a person must do, and tell me exactly what and how long.

Merging to `main` deploys the live Netlify site `mca123`, and the live database may hold Isaac's real merchants, so follow "Before you touch
production" in the handoff README (owner's OK, backup, migration first, then merge).

Rules that never bend: this is not BH Violation Removal and not David's CRM, so never touch their accounts, repos or databases. Tooling
before code, never disable a lint rule, prove the database changed, never call something done without running it, and never put a
secret in chat or in git. Merge your own pull requests once the checks you ran are green. Short sentences, no yes-man, and tell me
what you did not verify.
