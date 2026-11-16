import { z } from "zod";
import type { Db } from "../db";
import { id, line, money } from "../data/schemas";
import { defaultTimers } from "../mca/stages";
import type { FundingTerms } from "../mca/funding";
import { parseFactor } from "../money";

/**
 * FUND: the rep enters the terms, the database checks the lender's caps, a manager confirms. Commission maths is one
 * place (SQL app.points_of / split_for) so the dialog, the sheet and the dashboard agree.
 */

const factor = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const f = parseFactor(v);
  if (f === null) {
    ctx.addIssue({ code: "custom", message: "Enter a factor rate like 1.35" });
    return z.NEVER;
  }
  return f;
});
const blank = (v: unknown) => v === null || v === undefined || v === "";
const optFactor = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (blank(v) ? null : parseFactor(v as string | number)));
const optMoney = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (blank(v) ? null : money.parse(v)));
const optPoints = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (blank(v) ? null : Number(String(v).replace(/[^0-9.]/g, ""))));

export const fundSchema = z.object({
  clientId: id,
  funderId: id.nullable().default(null),
  funderName: line(200).default(""),
  fundedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  amount: money,
  sellRate: factor,
  buyRate: optFactor,
  points: optPoints,
  psf: optMoney,
  psfCollectedAt: z.enum(["at_closing", "from_proceeds", "none"]).default("at_closing"),
  payment: money,
  frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
  termDays: z.coerce.number().int().positive().nullable().default(null),
  positionNo: z.coerce.number().int().min(1).max(20).default(1),
  note: line(500).default(""),
});
export type FundInput = z.output<typeof fundSchema>;

export interface FundPreview {
  amountCents: number;
  paybackCents: number;
  points: number | null;
  grossCommissionCents: number | null;
  psfCents: number;
  netToMerchantCents: number;
  repCutCents: number | null;
  houseCutCents: number | null;
  splitPct: number;
  warnings: string[];
}

/** The numbers the FUND dialog shows before anyone clicks. Pure except the split lookup. */
export async function previewFund(
  q: Db,
  i: FundInput,
  userId: string,
  today: string,
): Promise<FundPreview> {
  const points =
    i.points ?? (i.buyRate !== null ? Math.round((i.sellRate - i.buyRate) * 10000) / 100 : null);
  const psf = i.psf ?? 0;
  const gross = points !== null ? Math.round((i.amount * points) / 100) + psf : null;
  const { rows } = await q.query<{ split: string; lead: string }>(
    "select app.split_for($1, $2::date, c.lead_source_kind)::text as split, c.lead_source_kind as lead from clients c where c.id = $3",
    [userId, i.fundedOn ?? today, i.clientId],
  );
  const split = Number(rows[0]?.split ?? 50);
  const warnings: string[] = [];
  if (i.funderId) {
    const f = (
      await q.query<{ name: string; max_upsell_points: string | null; psf_cap_pct: string | null }>(
        "select name, max_upsell_points::text, psf_cap_pct::text from funders where id = $1",
        [i.funderId],
      )
    ).rows[0];
    // the same words propose_funding refuses with, so the preview says what the button will say
    if (f?.max_upsell_points && points !== null && points > Number(f.max_upsell_points))
      warnings.push(`${f.name} caps points at ${f.max_upsell_points} — you entered ${points}`);
    if (f?.psf_cap_pct && psf > 0 && (psf * 100) / i.amount > Number(f.psf_cap_pct))
      warnings.push(`${f.name} caps the PSF at ${f.psf_cap_pct}% of the advance`);
  }
  const rep = gross !== null ? Math.round((gross * split) / 100) : null;
  return {
    amountCents: i.amount,
    paybackCents: Math.round(i.amount * i.sellRate),
    points,
    grossCommissionCents: gross,
    psfCents: psf,
    netToMerchantCents: i.amount - psf,
    repCutCents: rep,
    houseCutCents: gross !== null && rep !== null ? gross - rep : null,
    splitPct: split,
    warnings,
  };
}

/** Writes the funding (proposed). Returns the funding id. The manager's confirm is a separate click. */
export async function proposeFunding(q: Db, i: FundInput, today: string): Promise<string> {
  const terms: FundingTerms = {
    fundedOn: i.fundedOn ?? today,
    amountCents: i.amount,
    factorRate: i.sellRate,
    paymentCents: i.payment,
    frequency: i.frequency,
  };
  const timers = defaultTimers("funded", { today, funding: terms }).map((t) => ({
    kind: t.kind,
    due_on: t.dueOn,
    note: t.note,
  }));
  const { rows } = await q.query<{ id: string }>("select id from propose_funding($1, $2::jsonb)", [
    i.clientId,
    JSON.stringify({
      funder_id: i.funderId,
      funder_name: i.funderName,
      funded_on: terms.fundedOn,
      amount_cents: i.amount,
      sell_rate: i.sellRate,
      buy_rate: i.buyRate,
      points: i.points,
      psf_cents: i.psf ?? 0,
      psf_collected_at: i.psfCollectedAt,
      payment_cents: i.payment,
      frequency: i.frequency,
      term_days: i.termDays,
      position_no: i.positionNo,
      note: i.note,
      timers,
    }),
  ]);
  const fid = rows[0]?.id;
  if (!fid) throw new Error("propose_funding returned no row");
  return fid;
}

export async function confirmFunding(q: Db, fundingId: string): Promise<void> {
  await q.query("select confirm_funding($1)", [fundingId]);
}

export async function recordCommissionPaid(
  q: Db,
  i: { fundingId: string; cents: number; on?: string; note?: string },
): Promise<void> {
  // a null date would land in commission_received_on and trip fundings_commission_received_pair; blank means today
  await q.query("select record_commission_paid($1, $2, coalesce($3::date, current_date), $4)", [
    i.fundingId,
    i.cents,
    i.on ?? null,
    i.note ?? "",
  ]);
}

export interface FundedRow {
  id: string;
  client_id: string;
  deal_id: string | null;
  business_name: string;
  rep_name: string;
  funded_on: string;
  funder_name: string;
  amount_cents: number;
  factor_rate: number;
  payback_cents: number;
  payment_cents: number;
  frequency: string;
  term_days: number | null;
  points: number | null;
  psf_cents: number;
  commission_cents: number | null;
  rep_cut_cents: number | null;
  house_cut_cents: number | null;
  commission_received_cents: number | null;
  ledger_state: string;
  clawback_until: string | null;
  renewal_eligible_on: string | null;
  confirmed_at: string | null;
  status: string;
  paid_pct: number;
}

/** The Funded sheet rows. RLS scopes them: a rep sees their own, a manager everyone's. */
export async function listFunded(q: Db, month?: string): Promise<FundedRow[]> {
  const { rows } = await q.query<{ j: FundedRow }>(
    `select to_jsonb(f) || jsonb_build_object(
        'business_name', c.business_name, 'rep_name', u.name, 'points', app.points_of(f),
        'paid_pct', case when f.payback_cents > 0 then least(100, round(100.0 * coalesce(f.paid_back_override_cents,
            greatest(0, least(f.payback_cents, f.payment_cents * app.remittances_elapsed(f.funded_on, current_date, f.frequency)))) / f.payback_cents, 1)) else 0 end
      ) as j
       from fundings f join clients c on c.id = f.client_id join app_users u on u.id = f.user_id
      where ($1::text is null or to_char(f.funded_on, 'YYYY-MM') = $1)
        and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)
      order by f.funded_on desc, f.created_at desc`,
    [month ?? null],
  );
  return rows.map((r) => r.j);
}

export interface MonthTotals {
  month: string;
  funded_count: number;
  funded_cents: number;
  commission_cents: number;
  rep_cut_cents: number;
  paid_cents: number;
  at_risk_cents: number;
  clawed_back_cents: number;
  avg_points: number | null;
  avg_deal_cents: number | null;
}

export async function monthTotals(q: Db, months = 12): Promise<MonthTotals[]> {
  const { rows } = await q.query<MonthTotals>(
    `select to_char(f.funded_on, 'YYYY-MM') as month,
            count(*)::int as funded_count,
            sum(f.amount_cents)::bigint as funded_cents,
            coalesce(sum(f.commission_cents), 0)::bigint as commission_cents,
            coalesce(sum(f.rep_cut_cents), 0)::bigint as rep_cut_cents,
            coalesce(sum(f.commission_received_cents), 0)::bigint as paid_cents,
            coalesce(sum(case when f.ledger_state = 'at_risk' or (f.ledger_state = 'paid' and f.clawback_until >= current_date) then f.commission_cents end), 0)::bigint as at_risk_cents,
            coalesce(sum(case when f.ledger_state = 'clawed_back' then f.commission_cents end), 0)::bigint as clawed_back_cents,
            round(avg(app.points_of(f)), 2) as avg_points,
            round(avg(f.amount_cents))::bigint as avg_deal_cents
       from fundings f
      where f.confirmed_at is not null and f.funded_on > current_date - ($1 || ' months')::interval
        and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)
      group by 1 order by 1 desc`,
    [String(months)],
  );
  return rows;
}
