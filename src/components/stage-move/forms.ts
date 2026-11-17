import type { ClientCard } from "@/lib/data/types";
import type { ISODate } from "@/lib/mca/dates";
import type { StageKey } from "@/lib/mca/stages";

/** "Phone call scheduled" asks when the call is, unless one is already booked (QA I-8: the column says "time is booked"). */
export function needsInput(
  card: Pick<ClientCard, "scheduled_call_at" | "stage">,
  stage: StageKey,
): boolean {
  return stage === "call_scheduled" && card.stage !== stage && card.scheduled_call_at === null;
}

/** The day and time typed for a booked call: filled in, and not on a day that has already gone. */
export function callTimeProblem(at: string, today: ISODate): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) return "Pick the day and time of the call";
  if (at.slice(0, 10) < today) return "That call day has already passed — pick a time from now on";
  return undefined;
}

/** Undo: yesterday's due date can't be restored (the server rejects the past), so it becomes today. */
export function clampToToday(due: ISODate, today: ISODate): ISODate {
  return due < today ? today : due;
}

export interface UndoInput {
  clientId: string;
  stage: StageKey;
  followUpOn?: ISODate;
}

/** Did this move write something a plain move back would leave behind (a booked call)? */
export const wroteRecord = (extra: Record<string, unknown>): boolean => "callAt" in extra;

/** The move that puts a client back where it was, or null when a plain move back would not be a true undo. */
export function undoInput(
  prev: ClientCard,
  to: StageKey,
  wroteRecord: boolean,
  ctx: { today: ISODate },
): UndoInput | null {
  if (wroteRecord) return null;
  const out: UndoInput = { clientId: prev.id, stage: prev.stage };
  if (prev.next_due_on) out.followUpOn = clampToToday(prev.next_due_on, ctx.today);
  return out;
}
