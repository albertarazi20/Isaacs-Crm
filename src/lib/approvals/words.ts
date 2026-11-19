import { diffDays, type ISODate } from "../mca/dates";
import { formatDate } from "../format";
import { formatMoney } from "../money";
import type { ApprovalRow } from "./queries";

/** What the approval screens say, as pure functions (the page, the merchant card and the tests share them). */

export type WordsTone = "neutral" | "good" | "warn" | "bad" | "accent" | "info";

export interface CadenceStep {
  step: number;
  delay_hours: number;
  ready: boolean;
  uses_expiry?: boolean;
  uses_phone?: boolean;
}

export const stepName = (step: number) => (step <= 1 ? "Approval email" : `Follow-up ${step - 1}`);

/** 24 → "1 day", 36 → "36 hours", 1 → "1 hour". */
export function delayWords(hours: number): string {
  if (hours > 0 && hours % 24 === 0) {
    const d = hours / 24;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** "The approval email right away, then 3 follow-ups: 1 day, 2 days and 3 days apart." */
export function cadenceSummary(steps: readonly CadenceStep[]): string {
  const follow = steps.filter((s) => s.step > 1);
  if (steps.length === 0) return "No approval emails are set up.";
  if (follow.length === 0) return "Your approval email, with no follow-ups.";
  const gaps = follow.map((s) => delayWords(s.delay_hours));
  const list = gaps.length === 1 ? gaps[0] : `${gaps.slice(0, -1).join(", ")} and ${gaps.at(-1)}`;
  return `Your approval email, then ${follow.length} follow-up${follow.length === 1 ? "" : "s"}, ${list} apart.`;
}

export interface Status {
  tone: WordsTone;
  label: string;
  detail: string;
  /** A reply: the row goes to the top and glows. */
  hot?: boolean;
}

const FIELD_WORDS: Record<string, string> = {
  rep_phone: "the rep's phone number (My account)",
  rep_name: "the rep's name",
  rep_email: "the rep's email",
  first_name: "the merchant's name",
  business_name: "the business name",
  offer_amount: "the approved amount",
  offer_expiry: "the hold date",
  unsubscribe_link: "an unsubscribe link",
};

/** Where an approval's emails stand, in a label and one line. `fmt` writes a time in the rep's zone. */
export function emailsStatus(
  row: Pick<
    ApprovalRow,
    | "status"
    | "emails"
    | "emails_note"
    | "halt"
    | "next_step"
    | "next_email_at"
    | "steps"
    | "needs_call"
  >,
  fmt: (iso: string) => string,
): Status {
  if (row.status === "pitched")
    return { tone: "good", label: "Pitched", detail: "Emails stopped." };
  if (row.status === "closed")
    return { tone: "neutral", label: "Closed", detail: "Emails stopped." };
  // a merchant who answered and has not been called is the first thing, whatever the emails are doing
  if (row.needs_call)
    return {
      tone: "accent",
      label: "Replied",
      detail:
        row.emails === "running" && !row.halt ? "Call them now." : "Emails stopped. Call them now.",
      hot: true,
    };
  // a stop the engine has not written yet (it runs every few minutes) still shows at once
  const note =
    row.emails === "running" && row.halt && row.halt !== "paused" ? row.halt : row.emails_note;
  const sent = row.steps.filter((s) => s.status === "sent");
  const lastSent = sent.at(-1);
  switch (note) {
    case "replied":
      return {
        tone: "accent",
        label: "Replied",
        detail: "Emails stopped. Call them now.",
        hot: true,
      };
    case "offer_accepted":
      return {
        tone: "good",
        label: "Offer accepted",
        detail: "Emails stopped. Press Pitched once it's moving.",
      };
    case "next_run":
      return {
        tone: "info",
        label: "Saved",
        detail: "The emails start within a few minutes.",
      };
    case "expired":
      return { tone: "warn", label: "Hold date passed", detail: "Emails stopped." };
    case "opted_out":
      return { tone: "bad", label: "Unsubscribed", detail: "No more approval emails." };
    case "bounced":
      return { tone: "bad", label: "Email bounced", detail: "Fix the address, then resume." };
    case "dnc":
      return { tone: "bad", label: "Do not contact", detail: "Emails stopped." };
    case "no_email":
      return { tone: "warn", label: "No email address", detail: "Add one, then resume." };
    case "suppressed":
      return { tone: "bad", label: "Do-not-email list", detail: "Emails stopped." };
    case "trashed":
      return { tone: "bad", label: "In the trash", detail: "Emails stopped." };
    case "send_failed":
      return { tone: "bad", label: "Email didn't send", detail: "Resume to try again." };
    case "turned_off":
      return {
        tone: "warn",
        label: "Emails off",
        detail: "Approval emails are switched off in Settings.",
      };
    case "no_design":
      return {
        tone: "warn",
        label: "Waiting on a design",
        detail: `${stepName(row.next_step ?? 1)} has no design yet (Settings, Approval emails).`,
      };
    case "claim_check":
      return {
        tone: "warn",
        label: "Held",
        detail:
          "A wording rule holds this email for this merchant (a rate quoted to a California merchant, say).",
      };
    case "held":
      return {
        tone: "neutral",
        label: "Waiting for your first email",
        detail: 'Send the approval email from your own mail, then tap "I sent the first email".',
      };
    case "first_by_rep":
      return {
        tone: "neutral",
        label: "Waiting for your first email",
        detail: 'Send the approval email from your own mail, then tap "I sent the first email".',
      };
    case "paused":
      return { tone: "neutral", label: "Paused", detail: "Resume to pick up where it left off." };
    case "manual_stop":
      return {
        tone: "bad",
        label: "Emails stopped for good",
        detail: "A manager can turn them back on in Settings.",
      };
    case "reopened":
      return { tone: "neutral", label: "Emails stopped", detail: "Resume to start them again." };
    default:
      break;
  }
  if (note.startsWith("bad_field:"))
    return {
      tone: "warn",
      label: "Held",
      detail: `The design has a broken field (${note.slice(10)}). A manager fixes it in Settings.`,
    };
  if (note.startsWith("missing:")) {
    const fields = note.slice(8).split(",").filter(Boolean);
    // the hold date is the one a rep can add right on the card; a phone number is added under My account
    const fix = fields.includes("offer_expiry")
      ? fields.length === 1
        ? " Add it with Change."
        : " Add the date with Change."
      : "";
    return {
      tone: "warn",
      label: "Waiting",
      // which email is held and how to unstick it: an email with a {{field}} nobody filled never goes out as typed
      detail: `${stepName(row.next_step ?? 1)} needs ${fields.map((f) => FIELD_WORDS[f] ?? f).join(" and ")}.${fix}`,
    };
  }
  if (row.emails === "finished")
    return {
      tone: "neutral",
      label: "All emails sent",
      detail: lastSent ? `Last one ${fmt(lastSent.at)}.` : "",
    };
  if (row.emails === "paused") return { tone: "neutral", label: "Paused", detail: "" };
  if (row.emails === "stopped") return { tone: "neutral", label: "Emails stopped", detail: "" };
  const queued = row.steps.find((s) => s.status === "queued" || s.status === "sending");
  if (queued)
    return {
      tone: "accent",
      label: "Sending",
      detail: `${stepName(queued.step)} goes out ${fmt(queued.at)}.`,
    };
  if (row.next_step && row.next_email_at)
    return {
      tone: "good",
      label: "Emailing",
      detail: `${stepName(row.next_step)} ${fmt(row.next_email_at)}.`,
    };
  return { tone: "good", label: "Emailing", detail: "" };
}

export interface Hold {
  label: string;
  left: string;
  tone: WordsTone;
}

/** "Until Nov 21" and how long is left of the funder's hold. */
export function holdWords(holdUntil: string | null, today: ISODate): Hold | null {
  if (!holdUntil) return null;
  const days = diffDays(today, holdUntil);
  const label = `Until ${formatDate(holdUntil, today)}`;
  if (days < 0)
    return { label, left: `Ended ${-days} day${days === -1 ? "" : "s"} ago`, tone: "bad" };
  if (days === 0) return { label, left: "Ends today", tone: "bad" };
  if (days === 1) return { label, left: "1 day left", tone: "warn" };
  return { label, left: `${days} days left`, tone: days <= 3 ? "warn" : "neutral" };
}

const dayKey = (d: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/**
 * A moment as a rep says it: "today at 2:14 PM", "tomorrow at 9:00 AM", "Thu at 9:00 AM" within the week, "Nov 21" past
 * that. In the rep's own zone.
 */
export function whenWords(iso: string, timezone: string, nowMs: number): string {
  const at = new Date(iso);
  const now = new Date(nowMs);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  const day = dayKey(at, timezone);
  const today = dayKey(now, timezone);
  const days = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 0)
    return at.getTime() <= nowMs + 60_000 && at.getTime() >= nowMs - 5 * 60_000
      ? "now"
      : `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7)
    return `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(at)} at ${time}`;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  }).format(at);
}

/** Stops no Resume can undo: the merchant or the law ended it. A bounce or a missing address can be fixed. */
const PERMANENT = new Set([
  "opted_out",
  "dnc",
  "suppressed",
  "trashed",
  "offer_accepted",
  "manual_stop",
]);

/** Can the rep restart these emails? Not when the merchant unsubscribed or is do-not-contact. */
export function canResume(
  row: Pick<ApprovalRow, "status" | "emails" | "emails_note" | "halt">,
): boolean {
  if (row.status !== "open" || row.emails === "finished" || row.emails === "running") return false;
  return !(PERMANENT.has(row.emails_note) || (row.halt !== null && PERMANENT.has(row.halt)));
}

/** The approved amount as the emails and the screens say it: whole dollars, and cents when it has them. */
export const offerMoney = (cents: number | null | undefined) =>
  formatMoney(cents, { cents: cents != null && cents % 100 !== 0 });

/** What the setup box over the approvals list says is missing. The box shows only when something in it does. */
export function setupNotices(i: {
  unready: number;
  emailsOn: boolean;
  postalAddress: string;
  myPhone: string | null | undefined;
  cadence: readonly CadenceStep[];
}) {
  // only when a design actually asks the merchant to call the rep does a missing phone number hold anything
  const needsPhone = !i.myPhone && i.cadence.some((s) => s.uses_phone);
  const noAddress = i.postalAddress.trim() === "";
  return {
    needsPhone,
    noAddress,
    any: i.unready > 0 || !i.emailsOn || noAddress || needsPhone,
  };
}

/** What an engine pass did, in a line for a toast ("The approval email goes out tomorrow at 9:00 AM."). */
export function advanceWords(
  r: {
    kind: "queued" | "waiting" | "stopped" | "finished" | "idle";
    note?: string;
    step?: number | null;
    notBefore?: string;
    at?: string | null;
  } | null,
  fmt: (iso: string) => string,
): string {
  if (!r) return "The emails wait until you start them.";
  if (r.kind === "queued" && r.notBefore && r.step)
    return `${stepName(r.step)} goes out ${fmt(r.notBefore)}.`;
  if (r.kind === "stopped" || r.kind === "waiting") {
    const s = emailsStatus(
      {
        status: "open",
        emails: r.kind === "stopped" ? "stopped" : "running",
        emails_note: r.note ?? "",
        halt: null,
        next_step: r.kind === "waiting" ? (r.step ?? null) : null,
        next_email_at: r.kind === "waiting" ? (r.at ?? null) : null,
        steps: [],
        needs_call: false,
      },
      fmt,
    );
    return `${s.label}. ${s.detail}`.trim();
  }
  if (r.kind === "finished") return "Every approval email has already gone.";
  return "";
}
