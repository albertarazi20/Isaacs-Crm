import type { ActivityRow, ClientCard, StipRow } from "@/lib/data/types";
import type { ISODate } from "@/lib/mca/dates";
import { diffDays } from "@/lib/mca/dates";
import {
  STIP_LABELS,
  stipRollup,
  type StipInput,
  type StipKind,
  type StipRollup,
} from "@/lib/mca/stips";
import { formatDate, timeAgo, toLocalInput } from "@/lib/format";

// ---------------------------------------------------------------------------------------------
// timeline

export type TimelineFilter = "all" | "notes" | "contact" | "stage";

export const TIMELINE_FILTERS: readonly { key: TimelineFilter; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Everything on this client" },
  { key: "notes", label: "Notes", hint: "Only notes" },
  { key: "contact", label: "Calls & texts", hint: "Calls, texts and emails" },
  { key: "stage", label: "Stage changes", hint: "Moves between stages" },
];

const CONTACT_KINDS: ReadonlySet<ActivityRow["kind"]> = new Set(["call", "text", "email"]);

export function matchesFilter(kind: ActivityRow["kind"], filter: TimelineFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "notes":
      return kind === "note";
    case "contact":
      return CONTACT_KINDS.has(kind);
    case "stage":
      return kind === "stage_change";
  }
}

export function filterActivities<T extends Pick<ActivityRow, "kind">>(
  rows: readonly T[],
  filter: TimelineFilter,
): T[] {
  return rows.filter((r) => matchesFilter(r.kind, filter));
}

export function countByFilter(
  rows: readonly Pick<ActivityRow, "kind">[],
): Record<TimelineFilter, number> {
  return {
    all: rows.length,
    notes: filterActivities(rows, "notes").length,
    contact: filterActivities(rows, "contact").length,
    stage: filterActivities(rows, "stage").length,
  };
}

/**
 * The database writes some bodies for machines: "Received: bank_statement Jul 2026" and
 * "Follow up set for 2027-01-23". Say them the way the rest of the page does.
 */
export function activityBody(a: Pick<ActivityRow, "kind" | "body">, today?: ISODate): string {
  if (a.kind === "timer") {
    return a.body.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => {
      try {
        return formatDate(d, today);
      } catch {
        return d;
      }
    });
  }
  if (a.kind !== "system") return a.body;
  const m = /^(Received|Marked missing): ([a-z_]+)(?: ([A-Z][a-z]{2} \d{4}))?$/.exec(a.body);
  const kind = m?.[2];
  if (!m || !kind || !(kind in STIP_LABELS)) return a.body;
  const label =
    kind === "bank_statement" && m[3] ? `${m[3]} statement` : STIP_LABELS[kind as StipKind];
  return `${m[1]}: ${label}`;
}

export interface LastTouch {
  kind: "call" | "text" | "email";
  atIso: string;
}

/** Newest call, text or email in the timeline — "the last follow-up". */
export function lastTouchOf(
  rows: readonly Pick<ActivityRow, "kind" | "occurred_at">[],
): LastTouch | null {
  let best: LastTouch | null = null;
  for (const r of rows) {
    if (!CONTACT_KINDS.has(r.kind)) continue;
    if (!best || new Date(r.occurred_at).getTime() > new Date(best.atIso).getTime())
      best = { kind: r.kind as LastTouch["kind"], atIso: r.occurred_at };
  }
  return best;
}

export type LastCall = { never: true } | { never: false; ago: string; note: string; atIso: string };

export function lastCallSummary(
  card: Pick<ClientCard, "last_call_at" | "last_call_note">,
  now: Date,
): LastCall {
  if (!card.last_call_at) return { never: true };
  return {
    never: false,
    ago: timeAgo(card.last_call_at, now),
    note: (card.last_call_note ?? "").trim(),
    atIso: card.last_call_at,
  };
}

// ---------------------------------------------------------------------------------------------
// dates

/** "Fri, Oct 23, 2026, 3:42 PM" — for title attributes, where the exact moment matters. */
export function fullDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The calendar day an instant falls on in Isaac's timezone. */
export function dateInTz(iso: string, timezone: string): ISODate {
  return toLocalInput(iso, timezone).slice(0, 10);
}

export type DueTone = "overdue" | "today" | "later";

export function dueTone(dueOn: ISODate, today: ISODate): DueTone {
  const diff = diffDays(today, dueOn);
  return diff < 0 ? "overdue" : diff === 0 ? "today" : "later";
}

// ---------------------------------------------------------------------------------------------
// money in and out of form fields

/** 5000000 → "50000", 5012345 → "50123.45". Always parses back to the same cents with parseMoney. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}${dollars}` : `${sign}${dollars}.${String(rem).padStart(2, "0")}`;
}

export function intToInput(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}

// ---------------------------------------------------------------------------------------------
// stips

const STIP_ORDER: readonly StipKind[] = [
  "signed_application",
  "bank_statement",
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "tax_return",
  "lease_letter",
  "processing_statement",
  "other",
];

/** Checklist order: application, statements oldest first, then ID and check — not alphabetical. */
export function sortStips(stips: readonly StipRow[]): StipRow[] {
  return [...stips].sort(
    (a, b) =>
      STIP_ORDER.indexOf(a.kind) - STIP_ORDER.indexOf(b.kind) ||
      (a.period ?? "").localeCompare(b.period ?? ""),
  );
}

export function splitStips(stips: readonly StipRow[]): {
  required: StipRow[];
  optional: StipRow[];
} {
  const sorted = sortStips(stips);
  return {
    required: sorted.filter((s) => s.required),
    optional: sorted.filter((s) => !s.required),
  };
}

export function stipInputs(stips: readonly StipRow[]): StipInput[] {
  return stips.map((s) => ({
    kind: s.kind,
    period: s.period,
    required: s.required,
    received: s.received_at !== null,
  }));
}

export function rollupOf(stips: readonly StipRow[]): StipRollup {
  return stipRollup(stipInputs(sortStips(stips)));
}

/** The optimistic copy of the list after one checkbox flips. */
export function setStipReceived(
  stips: readonly StipRow[],
  id: string,
  received: boolean,
  atIso: string,
): StipRow[] {
  return stips.map((s) =>
    s.id === id ? { ...s, received_at: received ? (s.received_at ?? atIso) : null } : s,
  );
}

// ---------------------------------------------------------------------------------------------
// forms: what the dialogs start with, and what they send

export interface ClientForm {
  businessName: string;
  dba: string;
  contactName: string;
  phone: string;
  email: string;
  industry: string;
  state: string;
  source: string;
  monthlyRevenue: string;
  timeInBusinessMonths: string;
  applicationReceivedOn: string;
}

export function clientForm(c: ClientCard): ClientForm {
  return {
    businessName: c.business_name,
    dba: c.dba,
    contactName: c.contact_name,
    phone: c.phone,
    email: c.email,
    industry: c.industry,
    state: c.state,
    source: c.source,
    monthlyRevenue: centsToInput(c.monthly_revenue_cents),
    timeInBusinessMonths: intToInput(c.time_in_business_months),
    applicationReceivedOn: c.application_received_on ?? "",
  };
}

export function clientFieldsPayload(f: ClientForm) {
  return { ...f, applicationReceivedOn: f.applicationReceivedOn || null };
}
