/** Briefs the assistant panel offers before anything is typed. Browser-safe (no server imports). */

/** "Plan my day", always on offer. */
export const PLAN_MY_DAY =
  "Plan my day. Read the overview, my call list and the merchants waiting on me, then give me a short ordered plan for today: what to do first, second and third and why, with the merchants named. End with the actions you can set up for me.";

/** Starters under the composer when a conversation is empty. */
export const STARTERS: readonly { label: string; prompt: string }[] = [
  {
    label: "Who is closest to done?",
    prompt:
      "Which merchants are closest to being brought in? For each, say exactly what is still missing and the fastest way to get it. Set up the actions.",
  },
  {
    label: "Who went quiet?",
    prompt:
      "Which merchants went quiet after showing interest? Pick the five most worth saving, say why, and write a short follow-up I can send each.",
  },
  {
    label: "Write a follow-up",
    prompt:
      "Write me a short, friendly follow-up email for a merchant who said they were interested but has not sent the application. Give me a subject line and a version for a text message too.",
  },
  {
    label: "How am I doing this month?",
    prompt:
      "How am I doing this month compared with last month? Tell me what is going well, what is slipping, and the one change that would bring in the most merchants.",
  },
];
