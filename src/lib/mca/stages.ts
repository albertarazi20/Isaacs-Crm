import { addBusinessDays, addDays, addMonths, type ISODate } from "./dates";
import { renewalDate, renewalDateFromTerm, type FundingTerms } from "./funding";

export const STAGE_KEYS = [
  "name_in",
  "spoke_with_owner",
  "interested",
  "call_scheduled",
  "application_sent",
  "application_in",
  "stips",
  "submitted",
  "offers_in",
  "offer_presented",
  "contract_out",
  "funded",
  "paying_off_soon",
  "paid_in_full",
  "default_workable",
  "default_bad",
  "legal_collections",
  "written_off",
  "declined",
  "lost",
  "killed",
  "dead",
  "not_interested",
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export type StageGroup = "prospecting" | "underwriting" | "funded" | "trouble" | "exit";

export type FollowUpRule =
  | { kind: "bdays"; days: number }
  | { kind: "days"; days: number }
  | { kind: "months"; months: number }
  | { kind: "funded" }
  | { kind: "lost" };

export interface StageDef {
  key: StageKey;
  label: string;
  group: StageGroup;
  hint: string;
  followUp: FollowUpRule;
}

/** 1–3 days means business days (a Friday "tomorrow" is Monday, not a Saturday nobody works); longer spans are calendar days. */
const d = (days: number): FollowUpRule =>
  days <= 3 ? { kind: "bdays", days } : { kind: "days", days };
const m = (months: number): FollowUpRule => ({ kind: "months", months });

/** Order here is board order. Every stage has a timer — no client ever goes dark. */
export const STAGES: readonly StageDef[] = [
  {
    key: "name_in",
    label: "Name in",
    group: "prospecting",
    hint: "Just a name and number",
    followUp: d(1),
  },
  {
    key: "spoke_with_owner",
    label: "Spoke with owner",
    group: "prospecting",
    hint: "Real conversation happened",
    followUp: d(2),
  },
  {
    key: "interested",
    label: "Interested",
    group: "prospecting",
    hint: "Wants funding — log positions and the ask",
    followUp: d(2),
  },
  {
    key: "call_scheduled",
    label: "Phone call scheduled",
    group: "prospecting",
    hint: "Time is booked",
    followUp: d(1),
  },
  {
    key: "application_sent",
    label: "Application sent",
    group: "prospecting",
    hint: "Waiting on the merchant",
    followUp: d(3),
  },
  {
    key: "application_in",
    label: "Application in",
    group: "underwriting",
    hint: "Signed app is back",
    followUp: d(1),
  },
  {
    key: "stips",
    label: "Collecting stips",
    group: "underwriting",
    hint: "Statements, ID, void check",
    followUp: d(2),
  },
  {
    key: "submitted",
    label: "Submitted to funders",
    group: "underwriting",
    hint: "Out to funders",
    followUp: d(1),
  },
  {
    key: "offers_in",
    label: "Offers in",
    group: "underwriting",
    hint: "Approvals back from funders",
    followUp: d(1),
  },
  {
    key: "offer_presented",
    label: "Offer presented",
    group: "underwriting",
    hint: "Merchant is deciding",
    followUp: d(2),
  },
  {
    key: "contract_out",
    label: "Contract out",
    group: "underwriting",
    hint: "Waiting on signatures",
    followUp: d(1),
  },
  {
    key: "funded",
    label: "Funded",
    group: "funded",
    hint: "Money is out",
    followUp: { kind: "funded" },
  },
  {
    key: "paying_off_soon",
    label: "Pays off soon",
    group: "funded",
    hint: "Good client, near payoff — renewal call",
    followUp: d(14),
  },
  {
    key: "paid_in_full",
    label: "Paid in full",
    group: "funded",
    hint: "Hottest lead you own",
    followUp: d(14),
  },
  {
    key: "default_workable",
    label: "Workable default",
    group: "trouble",
    hint: "Missed remittances but will make it right",
    followUp: d(3),
  },
  {
    key: "default_bad",
    label: "Default",
    group: "trouble",
    hint: "Not paying, not answering",
    followUp: d(7),
  },
  {
    key: "legal_collections",
    label: "Legal / collections",
    group: "trouble",
    hint: "With counsel or a collector",
    followUp: d(14),
  },
  {
    key: "written_off",
    label: "Written off",
    group: "trouble",
    hint: "Gone — but businesses recover",
    followUp: m(12),
  },
  { key: "declined", label: "Declined", group: "exit", hint: "Funders said no", followUp: m(3) },
  {
    key: "lost",
    label: "Lost / dead",
    group: "exit",
    hint: "Funded somewhere else",
    followUp: { kind: "lost" },
  },
  {
    key: "killed",
    label: "Killed deal",
    group: "exit",
    hint: "Pulled before funding",
    followUp: m(6),
  },
  { key: "dead", label: "Dead deal", group: "exit", hint: "Went silent", followUp: m(9) },
  {
    key: "not_interested",
    label: "Not interested",
    group: "exit",
    hint: "Said no",
    followUp: m(12),
  },
];

export const STAGE_GROUPS: readonly { key: StageGroup; label: string }[] = [
  { key: "prospecting", label: "Prospecting" },
  { key: "underwriting", label: "Underwriting" },
  { key: "funded", label: "Funded" },
  { key: "trouble", label: "Default & collections" },
  { key: "exit", label: "Exits — still alive" },
];

/**
 * The short list Isaac works from. A stage listed here is retired: no picker offers it and a merchant already in it
 * shows under the stage it folds into. The old keys stay valid in the database, so no history is rewritten.
 */
const FOLDS_INTO: Partial<Record<StageKey, StageKey>> = {
  spoke_with_owner: "interested",
  call_scheduled: "interested",
  offer_presented: "offers_in",
  paying_off_soon: "funded",
  default_workable: "default_bad",
  legal_collections: "default_bad",
  written_off: "default_bad",
  declined: "lost",
  killed: "lost",
  dead: "lost",
  not_interested: "lost",
};

export const foldStage = (key: StageKey): StageKey => FOLDS_INTO[key] ?? key;

/** What every dropdown offers. */
export const CORE_STAGES: readonly StageDef[] = STAGES.filter((s) => !(s.key in FOLDS_INTO));

const BY_KEY = new Map<StageKey, StageDef>(STAGES.map((s) => [s.key, s]));

export function stageDef(key: StageKey): StageDef {
  const s = BY_KEY.get(key);
  if (!s) throw new Error(`unknown stage: ${key}`);
  return s;
}

export function isStageKey(v: string): v is StageKey {
  return BY_KEY.has(v as StageKey);
}

export type TimerKind = "follow_up" | "check_in" | "renewal" | "scheduled_call" | "chase";

export const TIMER_LABELS: Record<TimerKind, string> = {
  follow_up: "Follow up",
  check_in: "Funded check-in",
  renewal: "Renewal call",
  scheduled_call: "Scheduled call",
  chase: "Chase funder",
};

export interface PlannedTimer {
  kind: TimerKind;
  dueOn: ISODate;
  note: string;
}

export interface TimerContext {
  today: ISODate;
  /** Required when moving to `funded` so the renewal date can be calculated. */
  funding?: FundingTerms;
  /** The competitor's term in days, when moving to `lost`. */
  competitorTermDays?: number;
}

export const FUNDED_CHECK_IN_DAYS = 30;
export const LOST_FALLBACK_MONTHS = 6;

/** The timers a client gets the instant it lands in `stage`. Isaac can override any of them. */
export function defaultTimers(stage: StageKey, ctx: TimerContext): PlannedTimer[] {
  const rule = stageDef(stage).followUp;
  switch (rule.kind) {
    case "bdays":
      return [{ kind: "follow_up", dueOn: addBusinessDays(ctx.today, rule.days), note: "" }];
    case "days":
      return [{ kind: "follow_up", dueOn: addDays(ctx.today, rule.days), note: "" }];
    case "months":
      return [{ kind: "follow_up", dueOn: addMonths(ctx.today, rule.months), note: "" }];
    case "funded": {
      const timers: PlannedTimer[] = [
        {
          kind: "check_in",
          dueOn: addDays(ctx.today, FUNDED_CHECK_IN_DAYS),
          note: "Remittances clearing? Any NSFs?",
        },
      ];
      const renewal = ctx.funding ? renewalDate(ctx.funding, ctx.today) : null;
      if (renewal)
        timers.push({ kind: "renewal", dueOn: renewal, note: "50% paid down — renewal call" });
      return timers;
    }
    case "lost": {
      const dueOn = ctx.competitorTermDays
        ? renewalDateFromTerm(ctx.today, ctx.competitorTermDays)
        : addMonths(ctx.today, LOST_FALLBACK_MONTHS);
      return [{ kind: "follow_up", dueOn, note: "Competitor advance should be ~50% paid down" }];
    }
  }
}
