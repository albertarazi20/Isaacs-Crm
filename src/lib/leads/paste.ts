import type { SplitResult } from "../ai/splitLeadLine";

/**
 * "Paste a lead line" (S1-12): what the splitter found goes into the intake form's fields. Pure and browser-safe —
 * the form calls it with the values on screen and the splitter's answer, and shows the labels it returns so the rep
 * can see exactly which fields the line filled.
 */

/** The intake form's text fields that a pasted line can fill. */
export interface PasteValues {
  firstName: string;
  lastName: string;
  businessName: string;
  phone: string;
  email: string;
  phone2: string;
  email2: string;
  industry: string;
  state: string;
  lookingFor: string;
  wantedAmount: string;
}
export type PasteKey = keyof PasteValues;

const FIELDS: readonly {
  from: Exclude<keyof SplitResult, "notes">;
  to: PasteKey;
  label: string;
}[] = [
  { from: "first_name", to: "firstName", label: "First name" },
  { from: "last_name", to: "lastName", label: "Last name" },
  { from: "business_name", to: "businessName", label: "Business" },
  { from: "phone", to: "phone", label: "Phone" },
  { from: "email", to: "email", label: "Email" },
  { from: "phone2", to: "phone2", label: "Second phone" },
  { from: "email2", to: "email2", label: "Second email" },
  { from: "industry", to: "industry", label: "Industry" },
  { from: "state", to: "state", label: "State" },
  { from: "wanted_amount", to: "wantedAmount", label: "Amount they want" },
  { from: "looking_for", to: "lookingFor", label: "What they are looking for" },
];

export interface PasteOutcome<T extends PasteValues> {
  next: T;
  /** The labels of the fields the line filled, in form order. */
  filled: string[];
  /** Said in words when the line gave no phone — the one field intake cannot do without. */
  warning: string | null;
}

/**
 * Put the splitter's answer into the form. A field the line says nothing about is left exactly as it is; a field it
 * does fill is overwritten (the rep pasted on purpose). The splitter's "notes" line is kept with what they are
 * looking for, since the form has no notes box.
 */
export function applySplit<T extends PasteValues>(current: T, split: SplitResult): PasteOutcome<T> {
  const next: T = { ...current };
  const filled: string[] = [];
  for (const f of FIELDS) {
    let value = split[f.from].trim();
    if (f.to === "lookingFor") value = [value, split.notes.trim()].filter(Boolean).join("\n");
    if (value === "") continue;
    next[f.to] = value as T[PasteKey];
    filled.push(f.label);
  }
  return {
    next,
    filled,
    warning: split.phone.trim() === "" ? "No phone number in that line — add it below." : null,
  };
}
