/** What the background preparation asks the assistant, and how it labels the result. Browser-safe (no server imports). */
import { PLAN_MY_DAY, queueBrief } from "../assistant/prompts";

/** The "Do this now" reasons worth preparing. A bounced address needs a person, so it is not on the list. */
export const PREPARABLE = ["reply", "opened", "call_now", "ready", "upload", "overdue"] as const;
export type PreparableKind = (typeof PREPARABLE)[number];
export type PrepKind = PreparableKind | "plan";

export const isPreparable = (kind: string): kind is PreparableKind =>
  (PREPARABLE as readonly string[]).includes(kind);

/** What the person sees on the chip and in the list. */
export const PREP_LABEL: Record<PrepKind, string> = {
  reply: "Reply drafted",
  opened: "Nudge ready",
  call_now: "Call brief ready",
  ready: "File checked",
  upload: "Documents reviewed",
  overdue: "Catch-up ready",
  plan: "Plan for today",
};

/** One preparation per rep per trigger: the same reason, the same merchant, the same moment that put it on the list. */
export const triggerKey = (kind: PrepKind, clientId: string | null, at: string): string =>
  kind === "plan" ? `plan:${at}` : `${kind}:${clientId}:${at}`;

const BACKGROUND =
  "\n\nThis is a background preparation: I will read it later, so do not ask me anything. Read what you need, then set up the finished work with propose_actions: when an email is the right move, write the whole email as a send_email action (it goes out only after I review it), plus a set_follow_up date or a note when they help. Keep the written answer to two or three plain sentences that say what you found and why you chose it.";

/** The message the assistant is given. The merchant is named by id only; it reads the name through its tools. */
export function prepBrief(kind: PrepKind, clientId: string | null): string {
  if (kind === "plan") return `${PLAN_MY_DAY}${BACKGROUND}`;
  if (!clientId) throw new Error("a merchant preparation needs a merchant");
  return `${queueBrief(kind, "", clientId).prompt}${BACKGROUND}`;
}

/** The first lines of what the assistant concluded, without markdown, for the list. */
export function summaryOf(text: string, max = 260): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`>#]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-\d.)]+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}
