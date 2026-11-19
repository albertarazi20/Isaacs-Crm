import { missingDocsPhrase } from "@/lib/mca/stips";
import { minuteLabel } from "@/lib/settings/format";
import type { BucketMember, BucketRow } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";
import {
  leftoverFields,
  mergeValues,
  resolveMergeFields,
  type MergeValues,
} from "@/lib/messaging/merge";

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
    ? "A shared bucket the whole shop can put merchants on."
    : "Your own bucket. Only you see it.";
}

/** What fills a shop bucket on its own, in plain words (the database keeps a key). */
const RULE_LABEL: Record<string, string> = {
  manual: "Fills by hand",
  missing_application: "Fills when no application is signed",
  missing_statements: "Fills when statements are missing",
  missing_newest_statement: "Fills when the newest statement is missing",
  missing_id: "Fills when the ID or voided check is missing",
  ready_for_ops: "Fills when the application and documents are in",
  cold: "Fills when a merchant goes quiet",
};

export function ruleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? `Fills by rule: ${rule.replace(/_/g, " ")}`;
}

export const isReadyBucket = (b: Pick<BucketRow, "key">): boolean => b.key === READY_KEY;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 emails and a call over 14 days", in a few words. */
export function sequenceSummary(steps: readonly SequenceStep[]): string {
  if (steps.length === 0) return "No sequence yet";
  const daily = steps.find((s) => s.daily);
  if (daily)
    return `Daily${daily.daily_minute === null ? "" : ` at ${minuteLabel(daily.daily_minute)}`}, their time, every day but Saturday`;
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

/**
 * One merchant's merge values for a step's subject, filled the way the blast preview fills them. Links are
 * only known at send time, so they read as placeholders.
 */
export function memberMergeValues(
  m: Pick<
    BucketMember,
    "contact_name" | "business_name" | "rep_name" | "wanted_amount_cents" | "missing"
  >,
): MergeValues {
  return mergeValues({
    contactName: m.contact_name,
    businessName: m.business_name,
    senderName: m.rep_name,
    applicationLink: "[application link]",
    wantedAmountCents: m.wanted_amount_cents,
    uploadLink: "[upload link]",
    missingDocs: missingDocsPhrase(m.missing ?? []),
  });
}

/**
 * What one step does, as a short title: the subject the merchant sees, or the task it makes. With a merchant's
 * values the subject is filled in; a subject that would still show a raw {field} reads as the template's name.
 */
export function stepTitle(s: SequenceStep, values?: MergeValues): string {
  if (s.action === "call") return "Call task for the rep";
  if (s.action === "move_to_cold") return "Move to Cold";
  const subject = s.template_subject?.trim() ?? "";
  const filled = subject && values ? resolveMergeFields(subject, values).text : subject;
  if (filled && leftoverFields(filled).length === 0) return filled;
  return s.template_name || filled || "No template picked";
}

/** The small line under a step: which template, and whether it may send. */
export function stepNote(s: SequenceStep): string {
  if (s.action === "call") return "No email goes out";
  if (s.action === "move_to_cold") return "The slow drip takes over";
  if (s.daily && !s.template_name) return "Daily reminder";
  if (!s.template_name) return "Nothing sends until a template is picked";
  return s.template_approved === false ? `${s.template_name} (needs approval)` : s.template_name;
}
