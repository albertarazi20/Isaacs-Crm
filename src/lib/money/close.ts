/**
 * Month-end close (plan §3, §9.3; audit S3-1). On the first hourly run of a new month the previous month closes:
 * SQL close_month locks that month's commission_ledger lines and builds one statement per person; this job then
 * emails each rep their statement and the managers the summary, claim-then-send so nothing goes twice and a failed
 * send is retried next hour. Corrections after a close are new dated lines in the current period (correct_funding).
 */
import type { Db, DbAccess } from "../db";
import { formatMoney } from "../money";
import { claimed, claimOnce, stampClaim } from "../system/once";
import type { DigestSender } from "../system/reminders";

export interface CloseSummary {
  /** The period this run looked at, YYYY-MM-01. */
  period: string;
  /** True when this run performed the close (false when it was already closed, or nothing to close yet). */
  closed: boolean;
  statements: number;
  sent: number;
  skipped: number;
  failed: number;
  summarySent: number;
}

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

/** "2026-11-01" → "November 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? ""} ${y}`;
}

/**
 * The month to close for a run at `now`: the month before `now − 12 h` in UTC. Twelve hours past UTC midnight on
 * the 1st, the 31st has ended in every US time zone, so a funding confirmed late on the last day lands in its own
 * month before the lock.
 */
export function periodToClose(now: Date): string {
  const t = new Date(now.getTime() - 12 * 3_600_000);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth(); // 0-based: the current month; the previous month is m - 1
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export interface StatementLine {
  id: number;
  funding_id: string;
  kind: string;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  note: string;
  business: string;
  funder: string;
  funded_on: string;
  created_at: string;
}

export interface Statement {
  id: string;
  period: string;
  user_id: string;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  lines: StatementLine[];
  locked_at: string;
  emailed_at: string | null;
}

/** Closes a month by hand (a manager, through RLS) or as the job (the owner connection). Idempotent. */
export async function closeMonth(q: Db, period: string): Promise<void> {
  await q.query("select close_month($1::date)", [period]);
}

/** The statements the signed-in user may see: their own, or everyone's for a manager. Newest first. */
export async function listStatements(q: Db, limit = 24): Promise<(Statement & { name: string })[]> {
  const { rows } = await q.query<{ j: Statement & { name: string } }>(
    `select to_jsonb(s) || jsonb_build_object('period', s.period::text, 'name', u.name) as j
       from commission_statements s join app_users u on u.id = s.user_id
      order by s.period desc, u.name limit $1`,
    [limit],
  );
  return rows.map((r) => r.j);
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
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The rep's statement, as an email: one line per ledger line, then the totals. */
export function buildStatementEmail(
  s: Pick<Statement, "period" | "lines" | "gross_cents" | "rep_cents" | "line_count">,
  name: string,
): { subject: string; text: string; html: string } {
  const label = periodLabel(s.period);
  const rows = s.lines.map((l) => {
    const what = `${l.business}${l.funder ? ` (${l.funder})` : ""}`;
    const kind = KIND_WORDS[l.kind] ?? l.kind;
    return {
      text: `• ${what} — ${kind}: ${formatMoney(l.rep_cents)} to you (${formatMoney(l.gross_cents)} gross)${l.note ? `\n  ${l.note}` : ""}`,
      html: `<tr><td>${esc(what)}</td><td>${esc(kind)}</td><td align="right">${esc(formatMoney(l.gross_cents))}</td><td align="right"><strong>${esc(formatMoney(l.rep_cents))}</strong></td></tr>`,
    };
  });
  const total = `Your commission for ${label}: ${formatMoney(s.rep_cents)} on ${formatMoney(s.gross_cents)} gross across ${s.line_count} line${s.line_count === 1 ? "" : "s"}.`;
  return {
    subject: `Commission statement — ${label}`,
    text: `${name ? `${name}, here` : "Here"} is your commission statement for ${label}.\n\n${rows.map((r) => r.text).join("\n")}\n\n${total}\nThis month is closed; any correction posts as a new line in the current month.\n`,
    html: `<div style="font-family:system-ui,sans-serif"><p>${esc(name ? `${name}, here` : "Here")} is your commission statement for ${esc(label)}.</p><table cellpadding="4"><tr><th align="left">Deal</th><th align="left">Line</th><th align="right">Gross</th><th align="right">Yours</th></tr>${rows.map((r) => r.html).join("")}</table><p><strong>${esc(total)}</strong></p><p><small>This month is closed; any correction posts as a new line in the current month.</small></p></div>`,
  };
}

export interface SummaryRow {
  name: string;
  email: string;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
}

/** The managers' close summary: one line per person and the shop totals. */
export function buildSummaryEmail(
  period: string,
  rows: readonly SummaryRow[],
): { subject: string; text: string; html: string } {
  const label = periodLabel(period);
  const gross = rows.reduce((n, r) => n + r.gross_cents, 0);
  const rep = rows.reduce((n, r) => n + r.rep_cents, 0);
  const house = rows.reduce((n, r) => n + r.house_cents, 0);
  const lines = rows.map((r) => ({
    text: `• ${r.name || r.email}: ${formatMoney(r.rep_cents)} on ${formatMoney(r.gross_cents)} gross (${r.line_count} line${r.line_count === 1 ? "" : "s"})`,
    html: `<tr><td>${esc(r.name || r.email)}</td><td align="right">${esc(formatMoney(r.gross_cents))}</td><td align="right">${esc(formatMoney(r.rep_cents))}</td><td align="right">${esc(formatMoney(r.house_cents))}</td></tr>`,
  }));
  const totals = `Shop: ${formatMoney(gross)} gross, ${formatMoney(rep)} to reps, ${formatMoney(house)} house.`;
  return {
    subject: `${label} closed — ${formatMoney(gross)} gross commission`,
    text: `${label} is closed. The ledger lines are locked and every rep has their statement.\n\n${lines.map((l) => l.text).join("\n")}\n\n${totals}\n`,
    html: `<div style="font-family:system-ui,sans-serif"><p>${esc(label)} is closed. The ledger lines are locked and every rep has their statement.</p><table cellpadding="4"><tr><th align="left">Person</th><th align="right">Gross</th><th align="right">Theirs</th><th align="right">House</th></tr>${lines.map((l) => l.html).join("")}</table><p><strong>${esc(totals)}</strong></p></div>`,
  };
}

interface PendingStatement {
  id: string;
  user_id: string;
  email: string;
  to_email: string;
  name: string;
}

/** Thrown inside a transaction to roll the claim back when there is nothing to send. */
class NothingToSend extends Error {}

/**
 * The job: close the previous month if it is not closed yet, then email what has not been emailed. Safe to run every
 * hour all month: after the first run everything is already stamped.
 */
export async function runMonthEndClose(args: {
  db: DbAccess;
  now: Date;
  send: DigestSender;
  /** Who may still receive email (see runReminders). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<CloseSummary> {
  const period = periodToClose(args.now);
  const summary: CloseSummary = {
    period,
    closed: false,
    statements: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    summarySent: 0,
  };
  const already = await args.db.withSystem(
    async (q) =>
      (await q.query("select 1 from commission_closes where period = $1::date", [period]))
        .rowCount ?? 0,
  );
  if (already === 0) {
    await args.db.withSystem((q) => closeMonth(q, period));
    summary.closed = true;
  }

  // 1. each rep's statement, claim-then-send
  const pending = await args.db.withSystem(
    async (q) =>
      (
        await q.query<PendingStatement>(
          `select s.id, s.user_id, u.email, coalesce(u.notify_email, u.email) as to_email, u.name
             from commission_statements s join app_users u on u.id = s.user_id
            where s.period = $1::date and s.emailed_at is null and u.active and u.digest_enabled
            order by u.created_at`,
          [period],
        )
      ).rows,
  );
  summary.statements = pending.length;
  for (const p of pending) {
    if (args.allowed && !args.allowed(p.email)) {
      summary.skipped += 1;
      continue;
    }
    try {
      await args.db.withSystem(async (q) => {
        const claim = await q.query<{ j: Statement }>(
          `update commission_statements s set emailed_at = $2
            where s.id = $1 and s.emailed_at is null
            returning to_jsonb(s) || jsonb_build_object('period', s.period::text) as j`,
          [p.id, args.now.toISOString()],
        );
        const s = claim.rows[0]?.j;
        if (!s) throw new NothingToSend();
        await args.send(p.to_email, buildStatementEmail(s, p.name));
      });
      summary.sent += 1;
    } catch (e) {
      if (e instanceof NothingToSend) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error(
          `statement email failed for user ${p.user_id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  // 2. the managers' summary, one claim per manager
  const managers = await args.db.withSystem(async (q) => {
    const all = (
      await q.query<{ id: string; email: string; to_email: string }>(
        `select u.id, u.email, coalesce(u.notify_email, u.email) as to_email from app_users u
          where u.role = 'manager' and u.active and u.digest_enabled order by u.created_at`,
      )
    ).rows;
    const out: typeof all = [];
    for (const m of all) {
      if (!(await claimed(q, { userId: m.id, kind: "close", forDate: period, ref: "summary" })))
        out.push(m);
    }
    return out;
  });
  for (const m of managers) {
    if (args.allowed && !args.allowed(m.email)) {
      summary.skipped += 1;
      continue;
    }
    const claim = { userId: m.id, kind: "close" as const, forDate: period, ref: "summary" };
    try {
      await args.db.withSystem(async (q) => {
        if (!(await claimOnce(q, claim))) throw new NothingToSend();
        const { rows } = await q.query<SummaryRow>(
          `select u.name, u.email, s.line_count, s.gross_cents::bigint as gross_cents, s.rep_cents::bigint as rep_cents, s.house_cents::bigint as house_cents
             from commission_statements s join app_users u on u.id = s.user_id
            where s.period = $1::date order by s.rep_cents desc, u.name`,
          [period],
        );
        const providerId = await args.send(
          m.to_email,
          buildSummaryEmail(
            period,
            rows.map((r) => ({
              ...r,
              gross_cents: Number(r.gross_cents),
              rep_cents: Number(r.rep_cents),
              house_cents: Number(r.house_cents),
            })),
          ),
        );
        await stampClaim(q, claim, providerId);
      });
      summary.summarySent += 1;
    } catch (e) {
      if (e instanceof NothingToSend) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error(
          `close summary failed for manager ${m.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  // the close is "summarised" once every manager has had theirs
  if (summary.summarySent > 0) {
    await args.db.withSystem(async (q) => {
      const all = (
        await q.query<{ id: string }>(
          "select id from app_users where role = 'manager' and active and digest_enabled",
        )
      ).rows;
      for (const m of all) {
        if (!(await claimed(q, { userId: m.id, kind: "close", forDate: period, ref: "summary" })))
          return;
      }
      await q.query(
        "update commission_closes set summary_emailed_at = coalesce(summary_emailed_at, $2) where period = $1::date",
        [period, args.now.toISOString()],
      );
    });
  }
  return summary;
}
