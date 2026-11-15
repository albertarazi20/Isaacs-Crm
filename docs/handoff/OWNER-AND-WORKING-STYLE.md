# Ronny, and how to work with him

Ronny is the owner and builder. He runs several businesses and projects from one phone and one Mac, often away from the keyboard.
He cares about speed, proof, and not wasting money or tokens. This is what the first session learned, in his own priorities.

## What he asks for

- **Short sentences.** Summarize. He reads on a phone. Plain words beat tidy ones.
- **No yes-man.** Say where he can get better, where energy is leaking, what competitors do that he does not, and what he is not
  doing. Say it plainly, once, with a reason. He wants a partner, not applause.
- **Think big, without overthinking.** Look for the 100x idea, but do not argue with yourself in circles or spend tokens on colors and
  small choices. If a task could have cost one-fifth, do it the cheaper way next time.
- **Do the work yourself.** "Only give me work that you can't do." If a step needs a person (an account, a payment, a phone test, a
  legal answer), say exactly what, how long it takes, and give the shortest path. Do not hand him anything you could do.
- **Work while he is away.** When he leaves, keep going without approvals. Leave the work so that the next thing he does is simply
  "plug in", and tell him the one or two things that need him.
- **Prove it.** Never say "done" if something is untested or has a known bug. State what was run, with the numbers.
- **Run background crews and reviewers.** For heavy and medium work, start separate agents to hunt for bugs and mistakes, and
  brainstorm extra ideas, before the work reaches him. Fix what they find. Look over finished work for anything left out.
- **Use every tool that helps**: connectors, skills, plugins. Keep learning what he says is important and write it down so the
  next session knows.
- **When he throws a small task at you**, finish it right away, then go back to what you were doing. Do not stop after the small task.
- **Teach when he asks.** He asked for a full beginner's lesson on building a CRM and using Claude, and for the human-only steps to be
  explained step by step. He learns by doing the next click, so give one next click at a time and say what each one is for.

## Permissions he has given (still in force unless he says otherwise)

- **Merging pull requests is Claude's job** (said 2026-10-26, about pull request 1; recorded in `docs/DECISIONS.md`, "Delegation"). Merge your own when the checks you ran are green. Do not wait for him.
- Run autonomously, find everything wanted but not yet built, build it, and keep a tidy list of what is left for him.
- Do not need his approval for upgrades that come to mind while building, within the rules below, and **except** the "deliberately not
  built" list in `MCA-KNOWLEDGE.md` and anything that touches the live database or live site (see `README.md`, "Before you touch production").

## Rules he set (same as `CLAUDE.md`)

Tooling before code. Never disable a lint rule to get green. Unit-test the backend, and prove the database really changed. Write a
test plan, run it, collect every issue before fixing. Edit surgically. Measure, do not assume; a number in a doc comes with the
command that produced it. His rule: CI runs unit tests and a real build only, and the free allowance is limited (the workflow also runs
typecheck, lint and format; whether to drop them is an open decision in `docs/OWNER-TODO.md` section C). Browser tests run locally.
Standard ESLint and Prettier, no other linters.

## Things that cost him money or trust

- Hosting plans. He asked whether Vercel costs money. Vercel's free plan is non-commercial only, so the app targets Netlify, where he
  has a membership. Always say what a paid plan costs and what the free one forbids, and mark anything you could not confirm.
- Pasting secrets into chat. He did it on 2026-11-12 (a Resend key). It is better if he never has to: give a Terminal command that
  prints the value on his own machine, or tell him exactly which settings page to type it into. Then remind him to replace the leaked one.
- Mixing projects. BH Violation Removal and David's CRM are other businesses. Never touch their accounts, repos or databases, and say so
  when a connector shows them.
- Silence. If you are working a long time, send a few plain words about what you are doing.

## His setup, as seen

Mac with Edge and Chrome; the Claude app (desktop and phone) following cloud sessions. Accounts: GitHub (`ronny-arch`), Supabase,
Netlify (several of his other CRMs live there), Google. He is comfortable clicking through settings pages if each step is named.
He sometimes types a short message from his phone; read it for intent, not grammar.
