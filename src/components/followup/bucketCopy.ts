import type { BucketRow } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";

/** The system bucket a finished file lands in ("Ready to hand off"). */
export const READY_KEY = "ready_for_ops";

const PURPOSE: Record<string, string> = {
  interested: "Said yes to hearing more. Get the application started.",
  missing_app: "No signed application yet. Keep asking until it is in.",
  missing_statements: "The application is in. Bank statements are still missing.",
  missing_newest: "Statements are in, but the newest month is not.",
  missing_id: "Waiting on a photo ID or a voided check.",
  ready_for_ops: "The file is complete. Hand the merchant off and the chase stops.",
  cold: "Went quiet. A slow drip keeps the door open.",
};

/** One line on what a bucket is for. */
export function bucketPurpose(b: Pick<BucketRow, "key" | "owner_id">): string {
  if (b.key && PURPOSE[b.key]) return PURPOSE[b.key] ?? "";
  return b.owner_id === null
    ? "A shared track the whole shop can put merchants on."
    : "Your own track. Only you see it.";
}

export const isReadyBucket = (b: Pick<BucketRow, "key">): boolean => b.key === READY_KEY;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 emails and a call over 14 days", in a few words. */
export function sequenceSummary(steps: readonly SequenceStep[]): string {
  if (steps.length === 0) return "No sequence yet";
  const emails = steps.filter((s) => s.action === "email").length;
  const calls = steps.filter((s) => s.action === "call").length;
  const toCold = steps.some((s) => s.action === "move_to_cold");
  const parts: string[] = [];
  if (emails) parts.push(plural(emails, "email"));
  if (calls) parts.push(calls === 1 ? "a call" : plural(calls, "call"));
  const first = Math.min(...steps.map((s) => s.day_offset));
  const last = Math.max(...steps.map((s) => s.day_offset));
  const span = last === first ? (last === 0 ? "on day 0" : `on day ${last}`) : `over ${last} days`;
  const head = parts.length ? `${parts.join(" and ")} ${span}` : span;
  return toCold ? `${head}, then Cold` : head;
}

/** What one step does, as a short title: the subject the merchant sees, or the task it makes. */
export function stepTitle(s: SequenceStep): string {
  if (s.action === "call") return "Call task for the rep";
  if (s.action === "move_to_cold") return "Move to Cold";
  return s.template_subject?.trim() || s.template_name || "No template picked";
}

/** The small line under a step: which template, and whether it may send. */
export function stepNote(s: SequenceStep): string {
  if (s.action === "call") return "No email goes out";
  if (s.action === "move_to_cold") return "The slow drip takes over";
  if (!s.template_name) return "Nothing sends until a template is picked";
  return s.template_approved === false ? `${s.template_name} (needs approval)` : s.template_name;
}
