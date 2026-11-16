import type { Db } from "../db";
import { formatMoney } from "../money";

/*
 * The month-end close, as Settings shows it (0521): one row per closed month, one statement per person. A person
 * reads their own statement and a manager reads everyone's — the table's row-level security does that, these queries
 * add nothing to it.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-01" → "October 2026". */
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? ""} ${y}`;
}

export interface StatementSummary {
  id: string;
  user_id: string;
  name: string;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  emailed_at: string | null;
}

export interface ClosedMonth {
  /** YYYY-MM-01 */
  period: string;
  label: string;
  closed_at: string;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  statements: StatementSummary[];
}

/** The newest closed months with their statements (the lines stay out; the printable view loads them). */
export async function listClosedMonths(q: Db, limit = 12): Promise<ClosedMonth[]> {
  const closes = await q.query<Omit<ClosedMonth, "label" | "statements">>(
    `select period::text as period, closed_at::text as closed_at, line_count, gross_cents::float8 as gross_cents,
            rep_cents::float8 as rep_cents, house_cents::float8 as house_cents
       from commission_closes order by period desc limit $1`,
    [limit],
  );
  if (closes.rows.length === 0) return [];
  const periods = closes.rows.map((c) => c.period);
  const sts = await q.query<StatementSummary & { period: string }>(
    `select s.id, s.period::text as period, s.user_id, coalesce(nullif(u.name, ''), u.email) as name, s.line_count,
            s.gross_cents::float8 as gross_cents, s.rep_cents::float8 as rep_cents, s.house_cents::float8 as house_cents,
            s.emailed_at::text as emailed_at
       from commission_statements s join app_users u on u.id = s.user_id
      where s.period = any($1::date[]) order by s.period desc, name`,
    [periods],
  );
  return closes.rows.map((c) => ({
    ...c,
    label: monthLabel(c.period),
    statements: sts.rows.filter((s) => s.period === c.period).map(({ period: _p, ...s }) => s),
  }));
}

export interface StatementLine {
  kind: string;
  business: string;
  funder: string;
  funded_on: string | null;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  note: string;
}

export interface StatementDoc {
  id: string;
  period: string;
  label: string;
  person: string;
  email: string;
  closed_at: string;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  lines: StatementLine[];
}

/** One statement with its lines, or null when it does not exist or the person may not see it. */
export async function getStatementDoc(q: Db, id: string): Promise<StatementDoc | null> {
  const { rows } = await q.query<Omit<StatementDoc, "label">>(
    `select s.id, s.period::text as period, coalesce(nullif(u.name, ''), u.email) as person, u.email,
            coalesce(c.closed_at, s.locked_at)::text as closed_at,
            s.gross_cents::float8 as gross_cents, s.rep_cents::float8 as rep_cents, s.house_cents::float8 as house_cents,
            s.lines
       from commission_statements s join app_users u on u.id = s.user_id
       left join commission_closes c on c.period = s.period
      where s.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { ...r, label: monthLabel(r.period) } : null;
}

const KIND_WORDS: Record<string, string> = {
  expected: "Commission",
  paid: "Paid by lender",
  correction: "Correction",
  clawback: "Clawback",
  clear: "Cleared",
  draw: "Draw",
  draw_repaid: "Draw repaid",
  override: "Manager override",
};

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * The plain printable page: black on white, one table, no app chrome. A whole HTML document so it prints the same
 * from any browser; the Print button is the only script on it.
 */
export function statementHtml(doc: StatementDoc, shopName: string): string {
  const rows = doc.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.business)}${l.funder ? `<br><span class="m">${esc(l.funder)}</span>` : ""}</td>` +
        `<td>${esc(KIND_WORDS[l.kind] ?? l.kind)}${l.note ? `<br><span class="m">${esc(l.note)}</span>` : ""}</td>` +
        `<td class="n">${esc(formatMoney(l.gross_cents, { cents: true }))}</td>` +
        `<td class="n">${esc(formatMoney(l.rep_cents, { cents: true }))}</td>` +
        `<td class="n">${esc(formatMoney(l.house_cents, { cents: true }))}</td></tr>`,
    )
    .join("");
  const title = `Commission statement — ${doc.label}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — ${esc(doc.person)}</title>
<style>
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: black; background: white; margin: 0; padding: 32px; max-width: 880px; }
  h1 { font-size: 20px; margin: 0 0 2px; } p { margin: 2px 0; } .m { color: dimgray; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid lightgray; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: dimgray; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { border-top: 2px solid black; border-bottom: 0; font-weight: 600; }
  button { margin-top: 18px; font: inherit; padding: 8px 14px; border: 1px solid gray; background: white; border-radius: 8px; cursor: pointer; }
  @media print { button { display: none; } body { padding: 0; } }
</style></head><body>
<h1>${esc(title)}</h1>
<p>${esc(shopName)} · ${esc(doc.person)} (${esc(doc.email)})</p>
<p class="m">Month closed ${esc(doc.closed_at.slice(0, 10))}. A correction after the close posts as a new line in the current month.</p>
<table>
<thead><tr><th>Merchant</th><th>Line</th><th class="n">Gross</th><th class="n">Rep</th><th class="n">House</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="m">No lines this month.</td></tr>`}</tbody>
<tfoot><tr><td colspan="2">Total · ${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"}</td>
<td class="n">${esc(formatMoney(doc.gross_cents, { cents: true }))}</td>
<td class="n">${esc(formatMoney(doc.rep_cents, { cents: true }))}</td>
<td class="n">${esc(formatMoney(doc.house_cents, { cents: true }))}</td></tr></tfoot>
</table>
<button type="button" onclick="window.print()">Print</button>
</body></html>`;
}
