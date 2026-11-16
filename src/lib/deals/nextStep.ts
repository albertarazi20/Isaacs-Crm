/**
 * The deal page's "what now": one suggestion, ranked by what loses money fastest if ignored, and the milestone chips.
 * Pure: a snapshot in, words out. The AI reader's own next_step rides along as a hint when it is fresher.
 */
import type { ISODate } from "../mca/dates";
import { diffDays } from "../mca/dates";
import { KICKBACK_LABELS, type DealStatus, type KickbackReason } from "./types";

export interface LenderLine {
  name: string;
  status: string;
  sent_on: ISODate;
  responded_on: ISODate | null;
  last_chased_on: ISODate | null;
  chase_count: number;
  approval_expires_on: ISODate | null;
  stips: string[];
  decline_reason: string | null;
}

export interface OfferLine {
  funder_name: string;
  amount_cents: number;
  factor_rate: number;
  status: string; // open | presented | accepted | declined | expired
  received_on: ISODate;
  expires_on: ISODate | null;
}

export interface DealSnapshot {
  today: ISODate;
  status: DealStatus;
  contact_name: string;
  business_name: string;
  created_on: ISODate;
  queued_at: string;
  kicked_back_at: string | null;
  kickback_reason: KickbackReason | null;
  kickback_note: string;
  sent_on: ISODate | null;
  blocker: string;
  reply_waiting: boolean;
  reply_subject: string;
  lenders: LenderLine[];
  offers: OfferLine[];
  /** Labels of required stips still missing. */
  stips_missing: string[];
  /** The statement month lenders will ask for that is not on file, if any. */
  statement_wanted: string | null;
  funding: { funded_on: ISODate; renewal_eligible_on: ISODate | null; ledger_state: string } | null;
  /** The reader's latest suggestion, if an email came in since the deal last moved. */
  ai_next_step: string | null;
  /** Shop rule: chase a quiet lender after this many days. */
  chase_after_days: number;
}

export type Urgency = "now" | "today" | "soon" | "none";

export type ActionKind =
  | "answer"
  | "fix_file"
  | "collect_stips"
  | "present"
  | "close"
  | "chase"
  | "contracts"
  | "fund"
  | "reshop"
  | "renewal"
  | "submit"
  | "wait"
  | "none";

export interface Suggestion {
  title: string;
  why: string;
  urgency: Urgency;
  action: ActionKind;
  /** The lenders or items the action is about, for the button label. */
  targets: string[];
}

const money = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const hoursSince = (iso: string, today: ISODate): number =>
  Math.max(
    0,
    Math.round((new Date(`${today}T23:59:59Z`).getTime() - new Date(iso).getTime()) / 36e5),
  );

export function suggestNextStep(s: DealSnapshot): Suggestion {
  const who = s.contact_name || s.business_name;

  if (s.reply_waiting) {
    return {
      title: `Answer ${who}`,
      why: s.reply_subject
        ? `They wrote back: "${s.reply_subject}". Their reminders stopped.`
        : "They wrote back and nobody has answered.",
      urgency: "now",
      action: "answer",
      targets: [],
    };
  }

  switch (s.status) {
    case "kicked_back": {
      const reason = s.kickback_reason
        ? KICKBACK_LABELS[s.kickback_reason]
        : "ops sent the file back";
      return {
        title: `Fix the file: ${reason}`,
        why: s.kickback_note || "Ops cannot send it to lenders until this is fixed.",
        urgency: "now",
        action: "fix_file",
        targets: s.stips_missing,
      };
    }
    case "stips_needed": {
      const asked = [...new Set(s.lenders.flatMap((l) => l.stips))];
      const names = s.lenders.filter((l) => l.status === "stips_requested").map((l) => l.name);
      return {
        title: `Collect ${asked.length ? asked.slice(0, 3).join(", ") : "the stips"}${asked.length > 3 ? ` +${asked.length - 3}` : ""}`,
        why: `${names.join(" and ")} asked for them. Send the upload link; the reminders name exactly what is needed.`,
        urgency: "today",
        action: "collect_stips",
        targets: asked,
      };
    }
    case "needs_pitch": {
      const best = [...s.offers]
        .filter((o) => o.status === "open")
        .sort((a, b) => b.amount_cents - a.amount_cents)[0];
      const exp = best?.expires_on ? diffDays(s.today, best.expires_on) : null;
      return {
        title: best
          ? `Present ${best.funder_name}: ${money(best.amount_cents)} at ${best.factor_rate}`
          : "Present the approval",
        why:
          exp !== null && exp <= 3
            ? `The approval expires in ${plural(exp, "day")}.`
            : "An approval is in and the merchant has not heard it.",
        urgency: "now",
        action: "present",
        targets: best ? [best.funder_name] : [],
      };
    }
    case "pitched": {
      const presented = s.offers
        .filter((o) => o.status === "presented")
        .sort((a, b) => a.received_on.localeCompare(b.received_on));
      const oldest = presented[0];
      const age = oldest ? diffDays(oldest.received_on, s.today) : 0;
      const exp = oldest?.expires_on ? diffDays(s.today, oldest.expires_on) : null;
      if (exp !== null && exp <= 3)
        return {
          title: "Close it before the approval expires",
          why: `${oldest!.funder_name}'s approval expires in ${plural(exp, "day")}.`,
          urgency: "now",
          action: "close",
          targets: [oldest!.funder_name],
        };
      if (age >= 2)
        return {
          title: `Close it: offer presented ${plural(age, "day")} ago`,
          why: "Approvals go cold after a few days; the merchant is shopping it or stalling. Call, handle the objection, get the yes.",
          urgency: "today",
          action: "close",
          targets: oldest ? [oldest.funder_name] : [],
        };
      return {
        title: "Get the yes",
        why: "The offer was presented. Follow up tomorrow if nothing comes back.",
        urgency: "soon",
        action: "close",
        targets: [],
      };
    }
    case "contracts_out":
      return {
        title: "Get the contracts signed",
        why: "Contracts are out. Walk the merchant through them today; unsigned contracts die by the weekend.",
        urgency: "today",
        action: "contracts",
        targets: [],
      };
    case "contracts_in":
      return {
        title: "Line up the funding call",
        why: "Signed contracts are in. Make sure the merchant is reachable for the lender's verification call.",
        urgency: "today",
        action: "contracts",
        targets: [],
      };
    case "funding_call":
      return {
        title: "Press FUND when the wire lands",
        why: "The funding call is done. Confirm the wire with the merchant, then record the terms so the commission posts.",
        urgency: "today",
        action: "fund",
        targets: [],
      };
    case "pending_lenders": {
      const quiet = s.lenders.filter((l) => {
        if (l.status !== "sent") return false;
        const since = l.last_chased_on ?? l.sent_on;
        return diffDays(since, s.today) >= s.chase_after_days;
      });
      const waiting = s.lenders.filter((l) => l.status === "sent");
      const age = s.sent_on ? diffDays(s.sent_on, s.today) : 0;
      if (quiet.length)
        return {
          title: `Chase ${quiet.map((l) => l.name).join(", ")}`,
          why: `No answer in ${plural(s.chase_after_days, "day")}. The auto-chase sends a nudge on the same thread; a call to the rep gets it looked at.`,
          urgency: "today",
          action: "chase",
          targets: quiet.map((l) => l.name),
        };
      return {
        title: `Waiting on ${plural(waiting.length, "lender")}`,
        why: `Sent ${plural(age, "day")} ago. Nothing to do until they answer or ${plural(s.chase_after_days, "day")} pass.`,
        urgency: "soon",
        action: "wait",
        targets: waiting.map((l) => l.name),
      };
    }
    case "working_ops": {
      const h = hoursSince(s.queued_at, s.today);
      if (h >= 24)
        return {
          title: "Ping ops",
          why: `The file has sat in the ops queue for ${plural(Math.round(h / 24), "day")}.`,
          urgency: "today",
          action: "wait",
          targets: [],
        };
      return {
        title: "Ops is working the file",
        why: "Submitted to ops. They send it to lenders or kick it back with what is missing.",
        urgency: "none",
        action: "wait",
        targets: [],
      };
    }
    case "declined_by_all": {
      const reasons = [
        ...new Set(s.lenders.map((l) => l.decline_reason).filter((r): r is string => Boolean(r))),
      ];
      return {
        title: "Reshop it or move to win-back",
        why: reasons.length
          ? `Every lender declined (${reasons.join(", ")}). A curable reason comes back in 30–90 days.`
          : "Every lender declined.",
        urgency: "soon",
        action: "reshop",
        targets: reasons,
      };
    }
    case "funded": {
      if (s.funding?.renewal_eligible_on && s.funding.renewal_eligible_on <= s.today)
        return {
          title: "Offer the renewal",
          why: `Paid down to the lender's renewal line on ${s.funding.renewal_eligible_on}.`,
          urgency: "today",
          action: "renewal",
          targets: [],
        };
      return {
        title: "Funded — nothing to do",
        why:
          s.funding?.ledger_state === "at_risk"
            ? "Inside the clawback window. The renewal clock is running."
            : "Paying as agreed.",
        urgency: "none",
        action: "none",
        targets: [],
      };
    }
    case "declined":
    case "lost":
    case "dead":
      return {
        title: "Closed",
        why: "This deal is over. The merchant may be in a win-back pool.",
        urgency: "none",
        action: "none",
        targets: [],
      };
    case "working":
    default: {
      if (s.stips_missing.length)
        return {
          title: `Collect ${s.stips_missing.slice(0, 3).join(", ")}${s.stips_missing.length > 3 ? ` +${s.stips_missing.length - 3}` : ""}`,
          why: "The file is not complete. The bucket reminders carry the upload link.",
          urgency: "today",
          action: "collect_stips",
          targets: s.stips_missing,
        };
      if (s.statement_wanted)
        return {
          title: `Get the ${s.statement_wanted} statement`,
          why: "Lenders will ask for it before they look at the file.",
          urgency: "today",
          action: "collect_stips",
          targets: [s.statement_wanted],
        };
      if (s.ai_next_step)
        return {
          title: s.ai_next_step,
          why: "From the latest lender email.",
          urgency: "today",
          action: "none",
          targets: [],
        };
      return {
        title: "Submit to ops",
        why: "The file is complete. Ops sends it to lenders.",
        urgency: "today",
        action: "submit",
        targets: [],
      };
    }
  }
}

export type MilestoneKey =
  "file" | "ops" | "lenders" | "answer" | "approved" | "presented" | "contracts" | "funded";

export interface Milestone {
  key: MilestoneKey;
  label: string;
  done: boolean;
  /** ISO date the milestone was reached, when known. */
  on: ISODate | null;
  current: boolean;
}

const ORDER: { key: MilestoneKey; label: string }[] = [
  { key: "file", label: "File in" },
  { key: "ops", label: "To ops" },
  { key: "lenders", label: "Sent to lenders" },
  { key: "answer", label: "First answer" },
  { key: "approved", label: "Approved" },
  { key: "presented", label: "Presented" },
  { key: "contracts", label: "Contracts" },
  { key: "funded", label: "Funded" },
];

export function milestones(s: DealSnapshot): Milestone[] {
  const day = (iso: string | null): ISODate | null => (iso ? iso.slice(0, 10) : null);
  const firstAnswer =
    s.lenders
      .map((l) => l.responded_on)
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null;
  const approvedOn =
    s.lenders
      .filter((l) =>
        ["approved", "revised", "contracts_out", "contracts_in", "funding_call", "funded"].includes(
          l.status,
        ),
      )
      .map((l) => l.responded_on)
      .filter((d): d is string => Boolean(d))
      .sort()[0] ?? null;
  const presentedOn =
    s.offers
      .filter((o) => ["presented", "accepted"].includes(o.status))
      .map((o) => o.received_on)
      .sort()[0] ?? null;
  const contracts =
    s.lenders.some((l) =>
      ["contracts_out", "contracts_in", "funding_call", "funded"].includes(l.status),
    ) ||
    s.status === "contracts_out" ||
    s.status === "contracts_in" ||
    s.status === "funding_call";
  const reached: Record<MilestoneKey, { done: boolean; on: ISODate | null }> = {
    file: { done: true, on: s.created_on },
    ops: { done: s.status !== "working", on: day(s.queued_at) },
    lenders: {
      done: s.sent_on !== null || s.lenders.length > 0,
      on: s.sent_on ?? s.lenders.map((l) => l.sent_on).sort()[0] ?? null,
    },
    answer: { done: firstAnswer !== null, on: firstAnswer },
    approved: {
      done: approvedOn !== null || s.offers.length > 0,
      on: approvedOn ?? s.offers.map((o) => o.received_on).sort()[0] ?? null,
    },
    presented: { done: presentedOn !== null, on: presentedOn },
    contracts: { done: contracts || s.funding !== null, on: null },
    funded: { done: s.funding !== null, on: s.funding?.funded_on ?? null },
  };
  const out = ORDER.map((m) => ({
    key: m.key,
    label: m.label,
    done: reached[m.key].done,
    on: reached[m.key].on,
    current: false,
  }));
  const next = out.find((m) => !m.done);
  if (next && !["declined", "lost", "dead", "declined_by_all"].includes(s.status))
    next.current = true;
  return out;
}
