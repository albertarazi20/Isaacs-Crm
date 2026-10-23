import type { DirectoryRow } from "@/lib/data/overdue";
import { timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { stageDef } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";

/** Pure matching behind the command palette: no React, no network. */

export interface SearchResult {
  /** A full phone number was typed: these are the people it belongs to ("Calling you: ..."). */
  calling: DirectoryRow[];
  matches: DirectoryRow[];
  kind: "empty" | "phone" | "number" | "text";
}

const digitsOf = (s: string) => s.replace(/\D/g, "");
/** A US number with its country code dropped. */
const national = (digits: string) =>
  digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
const phoneKey = (phone: string) => national(digitsOf(phone)).slice(-10);

const wordStart = (hay: string, needle: string) =>
  hay.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(needle));

function fieldScore(hay: string, token: string, weight: number): number {
  if (!hay) return 0;
  if (hay.startsWith(token)) return weight + 2;
  if (wordStart(hay, token)) return weight + 1;
  return hay.includes(token) ? weight : 0;
}

/** Every token must hit something (name, DBA, merchant, email or phone digits). Null = not a match. */
function textScore(row: DirectoryRow, tokens: string[]): number | null {
  const name = row.business_name.toLowerCase();
  const dba = row.dba.toLowerCase();
  const who = row.contact_name.toLowerCase();
  const email = row.email.toLowerCase();
  const phone = digitsOf(row.phone);
  let total = 0;
  for (const t of tokens) {
    const best = Math.max(
      fieldScore(name, t, 3),
      fieldScore(dba, t, 2),
      fieldScore(who, t, 2),
      fieldScore(email, t, 1),
      /^\d{3,}$/.test(t) && phone.includes(t) ? 1 : 0,
    );
    if (best === 0) return null;
    total += best;
  }
  return total;
}

const byName = (a: DirectoryRow, b: DirectoryRow) =>
  a.business_name.localeCompare(b.business_name) || a.id.localeCompare(b.id);

export function searchDirectory(
  rows: readonly DirectoryRow[],
  query: string,
  limit = 8,
): SearchResult {
  const q = query.trim();
  if (!q) return { calling: [], matches: [], kind: "empty" };

  const phoneLike = /^[\d\s().+-]+$/.test(q);
  const digits = national(digitsOf(q));
  if (phoneLike && digits.length >= 3) {
    // Ten digits (or 1 + ten) is a whole number: who is calling?
    if (digits.length === 10) {
      return {
        calling: rows.filter((r) => phoneKey(r.phone) === digits).sort(byName),
        matches: [],
        kind: "number",
      };
    }
    return {
      calling: [],
      matches: rows
        .filter((r) => digitsOf(r.phone).includes(digits))
        .sort(byName)
        .slice(0, limit),
      kind: "phone",
    };
  }

  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { row: DirectoryRow; score: number }[] = [];
  for (const row of rows) {
    const score = textScore(row, tokens);
    if (score !== null) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.row, b.row));
  return { calling: [], matches: scored.slice(0, limit).map((s) => s.row), kind: "text" };
}

/** "Calling you: Mike Ross — Mike's Pizza · Interested · last call 3 days ago · wants $50k" */
export function callingYouLine(row: DirectoryRow, nowMs: number): string {
  const who = row.contact_name.trim();
  const bits = [
    stageDef(row.stage).label,
    row.last_call_at ? `last call ${timeAgo(row.last_call_at, new Date(nowMs))}` : "never called",
    row.wanted_amount_cents ? `wants ${formatMoneyCompact(row.wanted_amount_cents)}` : null,
  ].filter(Boolean);
  return `Calling you: ${who ? `${who} — ` : ""}${row.business_name} · ${bits.join(" · ")}`;
}

/** The second line of an ordinary result: merchant, phone, stage. */
export function detailLine(row: DirectoryRow): string {
  return [
    row.contact_name,
    row.dba && row.dba !== row.business_name ? `dba ${row.dba}` : "",
    row.phone ? formatUS(row.phone) : "",
    stageDef(row.stage).label,
  ]
    .filter(Boolean)
    .join(" · ");
}
