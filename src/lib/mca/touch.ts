import { addBusinessDays, addDays, type ISODate } from "./dates";
import { defaultTimers, type StageKey } from "./stages";

export type TouchKind = "call" | "text" | "email";
export type TouchOutcome = "reached" | "no_answer" | "left_message" | "bad_number";

export const OUTCOME_LABELS: Record<TouchOutcome, string> = {
  reached: "Reached",
  no_answer: "No answer",
  left_message: "Left message",
  bad_number: "Bad number",
};

const TEXT_LABELS: Record<TouchOutcome, string> = {
  reached: "They replied",
  no_answer: "No reply",
  left_message: "Sent, no reply yet",
  bad_number: "Bad number",
};

/** A text has no "no answer" and "left message" means nothing — say what actually happened. */
export const OUTCOMES_BY_KIND: Record<TouchKind, readonly TouchOutcome[]> = {
  call: ["reached", "no_answer", "left_message", "bad_number"],
  text: ["reached", "left_message", "bad_number"],
  email: [],
};

export function outcomeLabel(kind: string, outcome: TouchOutcome): string {
  return kind === "text" ? TEXT_LABELS[outcome] : OUTCOME_LABELS[outcome];
}

/** The stage's own timer, unless it is further out than `capDays` — a merchant whose application is in must not drift to two weeks on one tap. */
function sooner(today: ISODate, cap: ISODate, stage: StageKey | undefined): ISODate {
  if (!stage) return cap;
  const own = defaultTimers(stage, { today })[0]?.dueOn;
  return own !== undefined && own < cap ? own : cap;
}

/**
 * Where the timer goes after a touch if Isaac doesn't pick a date. Not reaching someone means try
 * again soon; reaching them means he chooses — two weeks is only the ceiling, and a stage that
 * normally gets a call every day (Application in) keeps its own pace.
 */
export function suggestNextFollowUp(
  outcome: TouchOutcome | null,
  today: ISODate,
  stage?: StageKey,
): ISODate {
  switch (outcome) {
    case "no_answer":
      return addBusinessDays(today, 1);
    case "left_message":
      return addBusinessDays(today, 2);
    case "bad_number":
      return addDays(today, 7);
    case "reached":
    case null:
      return sooner(today, addDays(today, 14), stage);
  }
}

/** After an email: three business days, or the stage's own pace if that is sooner. */
export function suggestAfterEmail(today: ISODate, stage?: StageKey): ISODate {
  return sooner(today, addBusinessDays(today, 3), stage);
}
