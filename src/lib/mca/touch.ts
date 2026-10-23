import { addDays, type ISODate } from "./dates";

export type TouchKind = "call" | "text" | "email";
export type TouchOutcome = "reached" | "no_answer" | "left_message" | "bad_number";

export const OUTCOME_LABELS: Record<TouchOutcome, string> = {
  reached: "Reached",
  no_answer: "No answer",
  left_message: "Left message",
  bad_number: "Bad number",
};

/**
 * Where the timer goes after a touch if Isaac doesn't pick a date. Not reaching someone means
 * try again soon; reaching them means he chooses (two weeks is just the starting point).
 */
export function suggestNextFollowUp(outcome: TouchOutcome | null, today: ISODate): ISODate {
  switch (outcome) {
    case "no_answer":
      return addDays(today, 1);
    case "left_message":
      return addDays(today, 2);
    case "bad_number":
      return addDays(today, 7);
    case "reached":
    case null:
      return addDays(today, 14);
  }
}
