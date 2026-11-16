import type { Db } from "../db";

export interface ShopSettingsRow {
  shop_name: string;
  postal_address: string;
  daily_cap: number;
  amber_at: number;
  reserved_for_intake: number;
  sequences_enabled: boolean;
  send_window_start: number;
  send_window_end: number;
  send_on_weekends: boolean;
  per_merchant_daily: number;
  per_merchant_weekly: number;
  automation_from: string;
  automation_reply_to_rep: boolean;
  lender_chase_days: number;
  lender_chase_mode: "send" | "off";
  lender_chase_max: number;
  max_lenders_per_deal: number;
  ai_enabled: boolean;
  ai_model: string;
  ai_daily_cap_cents: number;
  ai_auto_apply_low_stakes: boolean;
}

export async function getShopSettings(q: Db): Promise<ShopSettingsRow> {
  const { rows } = await q.query<ShopSettingsRow>(
    `select shop_name, postal_address, daily_cap, amber_at, reserved_for_intake, sequences_enabled, send_window_start, send_window_end,
            send_on_weekends, per_merchant_daily, per_merchant_weekly, automation_from, automation_reply_to_rep, lender_chase_days,
            lender_chase_mode, lender_chase_max, max_lenders_per_deal, ai_enabled, ai_model, ai_daily_cap_cents, ai_auto_apply_low_stakes
       from shop_settings`,
  );
  const r = rows[0];
  if (!r) throw new Error("shop_settings row missing");
  return r;
}

export interface PlanRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  effective_from: string;
  split_pct: number;
  self_gen_split_pct: number | null;
  psf_share_pct: number;
  renewal_split_pct: number | null;
  tiers: { from_cents: number; split_pct: number }[];
  manager_override_pct: number;
  clawback_borne_by: string;
  note: string;
  /** True for the row app.plan_for() picks today for that person (or the shop). */
  current: boolean;
}

export async function listCommissionPlans(q: Db): Promise<PlanRow[]> {
  const { rows } = await q.query<{ j: PlanRow }>(
    `select to_jsonb(x) as j from (
       select p.id, p.user_id, u.name as user_name, p.effective_from::text as effective_from, p.split_pct::float as split_pct,
              p.self_gen_split_pct::float as self_gen_split_pct, p.psf_share_pct::float as psf_share_pct, p.renewal_split_pct::float as renewal_split_pct,
              p.tiers, p.manager_override_pct::float as manager_override_pct, p.clawback_borne_by, p.note,
              p.id = (select id from commission_plans c where c.user_id is not distinct from p.user_id and c.effective_from <= current_date order by c.effective_from desc limit 1) as current
         from commission_plans p left join app_users u on u.id = p.user_id
        order by p.user_id nulls first, p.effective_from desc
     ) x`,
  );
  return rows.map((r) => r.j);
}

export interface SheetSourceRow {
  id: string;
  name: string;
  spreadsheet_id: string;
  sheet_title: string;
  owner_id: string | null;
  owner_name: string | null;
  target_bucket_id: string | null;
  bucket_name: string | null;
  auto_file: boolean;
  reader_name: string | null;
  active: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  row_count: number;
}

export async function listSheetSources(q: Db): Promise<SheetSourceRow[]> {
  const { rows } = await q.query<SheetSourceRow>(
    `select s.id, s.name, s.spreadsheet_id, s.sheet_title, s.owner_id, o.name as owner_name, s.target_bucket_id, b.name as bucket_name,
            s.auto_file, r.name as reader_name, s.active, s.last_synced_at::text as last_synced_at, s.last_error, s.row_count
       from sheet_sources s
       left join app_users o on o.id = s.owner_id left join app_users r on r.id = s.reader_user_id
       left join buckets b on b.id = s.target_bucket_id
      order by s.active desc, s.owner_id nulls first, s.name`,
  );
  return rows;
}

export interface AiStatus {
  spent_today_cents: number;
  runs_today: number;
  errors_today: number;
  runs: {
    id: string;
    purpose: string;
    model: string;
    cost_cents: number | null;
    error: string | null;
    created_at: string;
    business_name: string | null;
  }[];
}

export async function aiStatus(q: Db): Promise<AiStatus> {
  const head = await q.query<{ spent: string; runs: number; errors: number }>(
    `select coalesce(app.ai_spent_today_cents(), 0)::text as spent,
            (select count(*)::int from ai_runs where created_at > date_trunc('day', now())) as runs,
            (select count(*)::int from ai_runs where created_at > date_trunc('day', now()) and error is not null) as errors`,
  );
  const runs = await q.query<AiStatus["runs"][number]>(
    `select r.id, r.purpose, r.model, r.cost_cents::float as cost_cents, r.error, r.created_at::text as created_at, c.business_name
       from ai_runs r left join deals d on d.id = r.deal_id left join clients c on c.id = d.client_id
      order by r.created_at desc limit 25`,
  );
  return {
    spent_today_cents: Number(head.rows[0]?.spent ?? 0),
    runs_today: head.rows[0]?.runs ?? 0,
    errors_today: head.rows[0]?.errors ?? 0,
    runs: runs.rows,
  };
}

export interface SuppressionRow {
  id: string;
  channel: string;
  display: string | null;
  reason: string;
  note: string;
  created_at: string;
  business_name: string | null;
}

export async function listSuppressions(q: Db): Promise<SuppressionRow[]> {
  const { rows } = await q.query<SuppressionRow>(
    `select s.id, s.channel, s.display, s.reason, s.note, s.created_at::text as created_at, c.business_name
       from suppressions s left join clients c on c.id = s.client_id order by s.created_at desc limit 500`,
  );
  return rows;
}
