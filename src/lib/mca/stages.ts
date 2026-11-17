import { addBusinessDays, addDays, addMonths, type ISODate } from "./dates";

/**
 * Every stage the database knows (a check constraint on clients.stage). The app works only three of them; a merchant
 * left in any other stage shows under the stage it folds into (`foldStage`).
 */
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

export type StageGroup = "prospecting" | "application" | "exit";

export type FollowUpRule =
  | { kind: "bdays"; days: number }
  | { kind: "days"; days: number }
  | { kind: "months"; months: number };

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

/** The stages the app works. Every one has a timer — no merchant ever goes dark. */
export const STAGES: readonly StageDef[] = [
  {
    key: "interested",
    label: "Interested",
    group: "prospecting",
    hint: "Wants funding — we are bringing them in",
    followUp: d(2),
  },
  {
    key: "application_in",
    label: "Application in",
    group: "application",
    hint: "Signed app is back — statements and stips",
    followUp: d(1),
  },
  {
    key: "dead",
    label: "Trash",
    group: "exit",
    hint: "Dead, killed, declined or not interested",
    followUp: m(9),
  },
];

export const STAGE_GROUPS: readonly { key: StageGroup; label: string }[] = [
  { key: "prospecting", label: "Following up" },
  { key: "application", label: "Application in" },
  { key: "exit", label: "Trash" },
];

/**
 * The database's other stages, and the stage each one shows under. The old keys stay valid in the database, so no
 * history is rewritten; no picker offers them.
 */
const FOLDS_INTO: Partial<Record<StageKey, StageKey>> = {
  name_in: "interested",
  spoke_with_owner: "interested",
  call_scheduled: "interested",
  application_sent: "interested",
  stips: "application_in",
  submitted: "application_in",
  offers_in: "application_in",
  offer_presented: "application_in",
  contract_out: "application_in",
  funded: "application_in",
  paying_off_soon: "application_in",
  paid_in_full: "application_in",
  default_workable: "application_in",
  default_bad: "application_in",
  legal_collections: "application_in",
  written_off: "application_in",
  declined: "dead",
  killed: "dead",
  not_interested: "dead",
  lost: "dead",
};

export const foldStage = (key: StageKey): StageKey => FOLDS_INTO[key] ?? key;

/** What every dropdown offers. */
export const CORE_STAGES: readonly StageDef[] = STAGES;

const BY_KEY = new Map<StageKey, StageDef>(STAGES.map((s) => [s.key, s]));

/** The definition a merchant in `key` is shown under (a retired stage shows as the stage it folds into). */
export function stageDef(key: StageKey): StageDef {
  const s = BY_KEY.get(foldStage(key));
  if (!s) throw new Error(`unknown stage: ${key}`);
  return s;
}

export function isStageKey(v: string): v is StageKey {
  return (STAGE_KEYS as readonly string[]).includes(v);
}

export type TimerKind = "follow_up" | "scheduled_call";

export const TIMER_LABELS: Record<TimerKind, string> = {
  follow_up: "Follow up",
  scheduled_call: "Scheduled call",
};

export interface PlannedTimer {
  kind: TimerKind;
  dueOn: ISODate;
  note: string;
}

export interface TimerContext {
  today: ISODate;
}

/** The timer a merchant gets the instant it lands in `stage`. The rep can override it. */
export function defaultTimers(stage: StageKey, ctx: TimerContext): PlannedTimer[] {
  const rule = stageDef(stage).followUp;
  switch (rule.kind) {
    case "bdays":
      return [{ kind: "follow_up", dueOn: addBusinessDays(ctx.today, rule.days), note: "" }];
    case "days":
      return [{ kind: "follow_up", dueOn: addDays(ctx.today, rule.days), note: "" }];
    case "months":
      return [{ kind: "follow_up", dueOn: addMonths(ctx.today, rule.months), note: "" }];
  }
}
