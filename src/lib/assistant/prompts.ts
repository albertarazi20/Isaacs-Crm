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

/** Why a merchant is on the "Do this now" list (mirrors QueueKind in src/lib/followup/overview.ts). */
export type QueueReason =
  "reply" | "opened" | "call_now" | "ready" | "upload" | "bounced" | "overdue";

const QUEUE_ASK: Record<QueueReason, { label: string; task: string }> = {
  reply: {
    label: "Draft my reply",
    task: "replied. Read their latest email and the file, then draft my answer: short, plain, and aimed at getting the next document or the signed application. Set it up as an email I can review and send.",
  },
  opened: {
    label: "Nudge them",
    task: "opened their link but has not finished. Say what they still owe, then write a short nudge email that makes the next step easy, and a one-line call opener. Set up the actions.",
  },
  call_now: {
    label: "Prep the call",
    task: "is on my call list. Give me a 20-second brief for the call: who they are, what they said last, what is missing, and the one ask to make. Set up the follow-up for after the call.",
  },
  ready: {
    label: "Check the file",
    task: "looks complete. Check the file: is every required document in and readable? If yes, say so and set up the hand-off; if not, say exactly what is missing and write the email asking for it.",
  },
  upload: {
    label: "What came in?",
    task: "just sent documents. Say what came in, what is still missing, and write the short thank-you email asking for the rest. Set up the actions.",
  },
  bounced: {
    label: "Fix the email",
    task: "has an email address that bounced. Look for another way to reach them in the file, tell me what to check, and set up a follow-up so this does not get lost.",
  },
  overdue: {
    label: "Catch up",
    task: "has a follow-up that is past due. Read the file and tell me the best move right now, then set up the actions.",
  },
};

/** The brief behind the sparkles button on a "Do this now" row. */
export function queueBrief(
  reason: QueueReason,
  business: string,
  id: string,
): { prompt: string; label: string } {
  const name = business.trim() || "This merchant";
  const ask = QUEUE_ASK[reason];
  return {
    // the name is shown to the person, never put in the brief: a merchant writes their own business name (a lead
    // form can say anything), and the person's own words are what the model trusts most. It reads the name through
    // the tools, where merchant text is marked as data.
    prompt: `The merchant with merchant_id ${id} ${ask.task}`,
    label: `${ask.label}: ${name}`,
  };
}

/** The brief behind "Next step" on a merchant (the merchant page and the bucket drawer). */
export const merchantBrief = (id: string) =>
  `Look at the merchant with merchant_id ${id}: read the file and tell me where it stands, what is still missing, and the next best step today. Write the message I should send next (a short email and a text), and set up the actions.`;

export const bucketBrief = (name: string, id: string) =>
  `Look at the "${name}" bucket (bucket_id ${id}): its email sequence and its merchants. Who is closest to done, who has gone quiet, and what should I do with this bucket today? Set up the actions.`;

export const ALL_BUCKETS_BRIEF =
  "Look at all my follow-up buckets. Which one needs attention most today and why, and which emails are not landing? Give me a short plan and set up the actions.";
