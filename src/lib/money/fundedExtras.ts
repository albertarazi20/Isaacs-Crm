import type { Db } from "../db";

/**
 * Read side for the Funded page's newer controls (audit S3-1, S3-5, S3-6): which lenders are late paying, which
 * advances are eligible for more funds, the dated correction lines on a funding, and the commission statements per
 * month. Reads run as the signed-in person, so RLS keeps a rep to their own rows and shows a manager the shop.
 */

export interface CorrectionLine {
  id: string;
  funding_id: string;
  corrected_by_name: string | null;
  reason: string;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  /** The dated ledger line the correction posted (null once the line is gone). */
  line_on: string | null;
  line_period: string | null;
  gross_cents: number | null;
  rep_cents: number | null;
  created_at: string;
}

export interface FundingExtra {
  expected_on: string | null;
  owed_cents: number;
  /** Positive = days past the lender's own pay-after date with commission still owed; null = not tracked. */
  late_days: number | null;
  /** Active advance paid down past the lender's renewal line. */
  eligible_more: boolean;
  /** The merchant's open deal, when there is one (a renewal start would be refused). */
  open_deal_id: string | null;
  open_deal_number: number | null;
  corrections: CorrectionLine[];
}

interface ExtraRow {
  id: string;
  expected_on: string | null;
  owed_cents: string;
  late_days: number | null;
  eligible_more: boolean;
  open_deal_id: string | null;
  open_deal_number: number | null;
}

/** One entry per funding id passed in. `today` is the person's own date. */
export async function fundedExtras(
  q: Db,
  today: string,
  fundingIds: string[],
): Promise<Record<string, FundingExtra>> {
  if (fundingIds.length === 0) return {};
  const { rows } = await q.query<ExtraRow>(
    `select f.id, f.commission_expected_on::text as expected_on,
            greatest(0, coalesce(f.commission_cents, 0) - coalesce(f.commission_received_cents, 0))::text as owed_cents,
            case when f.confirmed_at is not null and f.commission_expected_on is not null
                      and f.ledger_state in ('expected', 'at_risk')
                      and coalesce(f.commission_received_cents, 0) < coalesce(f.commission_cents, 0)
                 then ($2::date - f.commission_expected_on) end as late_days,
            (f.status = 'active' and f.renewal_eligible_on is not null and f.renewal_eligible_on <= $2::date) as eligible_more,
            od.id as open_deal_id, od.number as open_deal_number
       from fundings f
       left join lateral (select d.id, d.number from deals d where d.client_id = f.client_id and d.outcome = 'open'
                           order by d.created_at desc limit 1) od on true
      where f.id = any($1::uuid[])`,
    [fundingIds, today],
  );
  const corrections = await correctionsFor(q, fundingIds);
  const byFunding = new Map<string, CorrectionLine[]>();
  for (const c of corrections)
    byFunding.set(c.funding_id, [...(byFunding.get(c.funding_id) ?? []), c]);
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        expected_on: r.expected_on,
        owed_cents: Number(r.owed_cents),
        late_days: r.late_days,
        eligible_more: r.eligible_more,
        open_deal_id: r.open_deal_id,
        open_deal_number: r.open_deal_number,
        corrections: byFunding.get(r.id) ?? [],
      } satisfies FundingExtra,
    ]),
  );
}

/** Every correction on these fundings, oldest first, each with the dated ledger line it posted. */
export async function correctionsFor(q: Db, fundingIds: string[]): Promise<CorrectionLine[]> {
  if (fundingIds.length === 0) return [];
  const { rows } = await q.query<
    Omit<CorrectionLine, "gross_cents" | "rep_cents"> & {
      gross_cents: string | null;
      rep_cents: string | null;
    }
  >(
    `select x.id, x.funding_id, u.name as corrected_by_name, x.reason, x.old_values, x.new_values,
            l.created_at::date::text as line_on, l.period::text as line_period, l.gross_cents::text as gross_cents,
            l.rep_cents::text as rep_cents, x.created_at::text as created_at
       from fundings_corrections x
       left join app_users u on u.id = x.corrected_by
       left join commission_ledger l on l.id = x.ledger_line_id
      where x.funding_id = any($1::uuid[])
      order by x.created_at, x.id`,
    [fundingIds],
  );
  return rows.map((r) => ({
    ...r,
    gross_cents: r.gross_cents === null ? null : Number(r.gross_cents),
    rep_cents: r.rep_cents === null ? null : Number(r.rep_cents),
  }));
}

// ---------- statements ----------

export interface StatementMonth {
  period: string;
  closed_at: string | null;
  statements: number;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
}

/** The months with statements the person may see, newest first. */
export async function statementMonths(q: Db, limit = 24): Promise<StatementMonth[]> {
  const { rows } = await q.query<
    Omit<StatementMonth, "gross_cents" | "rep_cents" | "house_cents"> & {
      gross_cents: string;
      rep_cents: string;
      house_cents: string;
    }
  >(
    `select s.period::text as period, c.closed_at::text as closed_at, count(*)::int as statements,
            coalesce(sum(s.line_count), 0)::int as line_count, coalesce(sum(s.gross_cents), 0)::text as gross_cents,
            coalesce(sum(s.rep_cents), 0)::text as rep_cents, coalesce(sum(s.house_cents), 0)::text as house_cents
       from commission_statements s left join commission_closes c on c.period = s.period
      group by s.period, c.closed_at
      order by s.period desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    ...r,
    gross_cents: Number(r.gross_cents),
    rep_cents: Number(r.rep_cents),
    house_cents: Number(r.house_cents),
  }));
}

/** Past months whose commission lines are still open: a manager can close them. Newest first, first-of-month dates. */
export async function monthsToClose(q: Db): Promise<string[]> {
  const { rows } = await q.query<{ period: string }>(
    `select distinct l.period::text as period from commission_ledger l
      where l.locked_at is null and l.period < date_trunc('month', current_date)::date
      order by 1 desc`,
  );
  return rows.map((r) => r.period);
}

export interface StatementLineView {
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

export interface StatementView {
  id: string;
  user_id: string;
  name: string;
  line_count: number;
  gross_cents: number;
  rep_cents: number;
  house_cents: number;
  lines: StatementLineView[];
  emailed_at: string | null;
}

export interface PeriodStatements {
  period: string;
  closed_at: string | null;
  statements: StatementView[];
}

/** One month's statements as the person may see them (their own, or everyone's for a manager); null when none. */
export async function statementsForPeriod(q: Db, period: string): Promise<PeriodStatements | null> {
  const { rows } = await q.query<{ j: StatementView & { closed_at: string | null } }>(
    `select to_jsonb(s) - 'period' - 'locked_at' - 'created_at'
              || jsonb_build_object('name', coalesce(nullif(u.name, ''), u.email), 'closed_at', c.closed_at::text,
                                    'gross_cents', s.gross_cents::bigint, 'rep_cents', s.rep_cents::bigint,
                                    'house_cents', s.house_cents::bigint) as j
       from commission_statements s join app_users u on u.id = s.user_id
       left join commission_closes c on c.period = s.period
      where s.period = $1::date
      order by u.name, u.email`,
    [`${period}-01`],
  );
  if (rows.length === 0) return null;
  return {
    period,
    closed_at: rows[0]!.j.closed_at,
    statements: rows.map(({ j }) => ({
      id: j.id,
      user_id: j.user_id,
      name: j.name,
      line_count: j.line_count,
      gross_cents: Number(j.gross_cents),
      rep_cents: Number(j.rep_cents),
      house_cents: Number(j.house_cents),
      lines: j.lines,
      emailed_at: j.emailed_at,
    })),
  };
}
