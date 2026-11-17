import type { ActivityRow, ClientCard } from "../data/types";
import { formatUS } from "../mca/phone";
import { stageDef, TIMER_LABELS } from "../mca/stages";

/**
 * A spreadsheet runs any cell that starts with = + - @ (or tab/CR) as a formula.
 * A merchant named "=HYPERLINK(...)" must come out as plain text, so those cells get a leading apostrophe.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Some spreadsheets skip leading spaces before deciding a cell is a formula, so look past them.
  if (/^[\t\r]/.test(s) || /^[=+\-@]/.test(s.trimStart())) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  // BOM so Excel reads UTF-8; CRLF per RFC 4180.
  return `﻿${lines.join("\r\n")}\r\n`;
}

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export const CLIENT_HEADER = [
  "Business",
  "DBA",
  "Contact",
  "Phone",
  "Email",
  "Industry",
  "State",
  "Source",
  "Stage",
  "Next follow-up",
  "Next follow-up type",
  "Last call",
  "Last call note",
  "Wanted ($)",
  "Application in",
  "Contact status",
  "Added",
] as const;

export function clientRows(cards: readonly ClientCard[]): unknown[][] {
  return cards.map((c) => [
    c.business_name,
    c.dba,
    c.contact_name,
    // Stored as +1305…; shown as (305) …, which a spreadsheet can never read as a formula.
    formatUS(c.phone),
    c.email,
    c.industry,
    c.state,
    c.source,
    stageDef(c.stage).label,
    c.next_due_on,
    c.next_due_kind ? TIMER_LABELS[c.next_due_kind] : "",
    c.last_call_at?.slice(0, 10),
    c.last_call_note,
    dollars(c.wanted_amount_cents),
    c.application_received_on,
    c.contact_status,
    c.created_at.slice(0, 10),
  ]);
}

export const ACTIVITY_HEADER = ["When", "Business", "In trash", "Type", "Result", "Note"] as const;

export interface MerchantName {
  name: string;
  trashed: boolean;
}

export function activityRows(
  activities: readonly ActivityRow[],
  merchants: ReadonlyMap<string, MerchantName>,
): unknown[][] {
  return activities.map((a) => {
    const m = merchants.get(a.client_id);
    return [a.occurred_at, m?.name ?? "", m?.trashed ? "yes" : "", a.kind, a.outcome, a.body];
  });
}
