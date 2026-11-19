import { STOCK_HTML } from "./stock/generated";

/**
 * The Selective Capital approval designs: the owner's own ready-made HTML emails, loaded into the four email slots
 * from Settings → Approval emails. The .html files in ./stock are the owner's work, copied byte for byte and embedded
 * as strings in ./stock/generated.ts (scripts/generate-stock-designs.mjs) so the production build carries them. Pure:
 * the settings screen draws with it and the loader and the tests run from it.
 */

export interface StockDesign {
  /** The slot: 1 is the approval email, 2 to 4 the follow-ups. */
  step: number;
  /** How the screens name it. */
  name: string;
  /** The design's file name, as stored beside the design. */
  fileName: string;
  subject: string;
  /** Hours after the email before it was SENT (the first email goes right away, so its wait is 0). */
  delayHours: number;
  html: string;
}

export const STOCK_DESIGNS: readonly StockDesign[] = [
  {
    step: 1,
    name: "Approval email",
    fileName: "initial.html",
    subject: "{{business_name}}: Approved for Funding",
    delayHours: 0,
    html: STOCK_HTML.initial,
  },
  {
    step: 2,
    name: "Follow-up 1",
    fileName: "follow-up-1.html",
    subject: "Did you see your approval, {{first_name}}?",
    delayHours: 24,
    html: STOCK_HTML.followUp1,
  },
  {
    step: 3,
    name: "Follow-up 2",
    fileName: "follow-up-2.html",
    subject: "Your offer is time-sensitive",
    delayHours: 48,
    html: STOCK_HTML.followUp2,
  },
  {
    step: 4,
    name: "Follow-up 3",
    fileName: "follow-up-3.html",
    subject: "Should I keep your offer open, {{first_name}}?",
    delayHours: 48,
    html: STOCK_HTML.followUp3,
  },
];

/** How many slots the designs fill. */
export const STOCK_SLOTS = STOCK_DESIGNS.length;

/** "24 hours after the approval email", "48 hours after Follow-up 1": the wait before a slot, in words. */
export function stockTiming(step: number): string {
  const d = STOCK_DESIGNS.find((s) => s.step === step);
  const before = STOCK_DESIGNS.find((s) => s.step === step - 1);
  if (!d || !before) return "You send it from your own mail";
  return `${d.delayHours} hours after ${before.step === 1 ? "the approval email" : before.name}`;
}

/** The slots the designs would fill, against what the slots hold now. */
export interface StockSlotState {
  step: number;
  html: string;
  subject: string;
  delayHours: number;
}

/** Is every one of the four slots empty (no design)? Then the button says "Load"; otherwise "Replace with". */
export function slotsAreEmpty(slots: readonly StockSlotState[]): boolean {
  return STOCK_DESIGNS.every(
    (d) => (slots.find((s) => s.step === d.step)?.html ?? "").trim() === "",
  );
}

/** The slots among the four that already hold a design (what loading replaces). */
export function slotsInUse(slots: readonly StockSlotState[]): number[] {
  return STOCK_DESIGNS.filter(
    (d) => (slots.find((s) => s.step === d.step)?.html ?? "").trim() !== "",
  ).map((d) => d.step);
}

/** Do the four slots already hold exactly these designs, subjects and waits? */
export function stockIsLoaded(slots: readonly StockSlotState[]): boolean {
  return STOCK_DESIGNS.every((d) => {
    const s = slots.find((x) => x.step === d.step);
    return (
      s !== undefined &&
      s.html === d.html &&
      s.subject === d.subject &&
      (d.step === 1 || s.delayHours === d.delayHours)
    );
  });
}

/** The button's words. */
export const loadButtonLabel = (slots: readonly StockSlotState[]) =>
  slotsAreEmpty(slots)
    ? "Load the Selective Capital designs"
    : "Replace with the Selective Capital designs";
