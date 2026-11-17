import type { Db } from "../db";
import type { DnsCheck } from "../send/dns";

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
  ai_enabled: boolean;
  ai_model: string;
  ai_daily_cap_cents: number;
  /** US federal holidays are send days (0507). */
  send_on_holidays: boolean;
  /** The DNS gate (0503): the last stored check of the automation domain. */
  dns_ok: boolean;
  dns_checked_at: string | null;
  dns_result: Partial<DnsCheck>;
}

export async function getShopSettings(q: Db): Promise<ShopSettingsRow> {
  const { rows } = await q.query<ShopSettingsRow>(
    `select shop_name, postal_address, daily_cap, amber_at, reserved_for_intake, sequences_enabled, send_window_start, send_window_end,
            send_on_weekends, per_merchant_daily, per_merchant_weekly, automation_from, automation_reply_to_rep,
            ai_enabled, ai_model, ai_daily_cap_cents, send_on_holidays, dns_ok, dns_checked_at::text as dns_checked_at,
            dns_result
       from shop_settings`,
  );
  const r = rows[0];
  if (!r) throw new Error("shop_settings row missing");
  return r;
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
  }[];
}

export async function aiStatus(q: Db): Promise<AiStatus> {
  const head = await q.query<{ spent: string; runs: number; errors: number }>(
    `select coalesce(app.ai_spent_today_cents(), 0)::text as spent,
            (select count(*)::int from ai_runs where created_at > date_trunc('day', now())) as runs,
            (select count(*)::int from ai_runs where created_at > date_trunc('day', now()) and error is not null) as errors`,
  );
  const runs = await q.query<AiStatus["runs"][number]>(
    `select r.id, r.purpose, r.model, r.cost_cents::float as cost_cents, r.error, r.created_at::text as created_at
       from ai_runs r order by r.created_at desc limit 25`,
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
