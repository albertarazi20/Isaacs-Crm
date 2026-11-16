/**
 * The alert feed by email (plan §3 "Alerts", §13.2, §14; audit S3-2, S3-6, S3-7, S3-9). Two halves:
 *   * generators — each looks at the database and writes `user_alerts` rows through app.alert(), whose dedupe key
 *     makes a thing alert once (a stale deal once per status, a late lender once, a trust pattern once per window);
 *   * the drain — every person with unsent rows gets one email bundling all of them, at most once an hour, claimed
 *     inside the transaction that sends so two overlapping runs cannot both send and a failed send is retried.
 * Pages read the same rows; the email is the copy that reaches a phone.
 */
import type { Db, DbAccess } from "../db";
import { pace } from "../dashboard/metrics";
import { formatMoney } from "../money";
import { todayIn, type ISODate } from "../mca/dates";
import type { DigestSender } from "./reminders";

export interface AlertRunSummary {
  generated: Record<string, number>;
  users: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** How many contact copies in one hour read as a pattern, not a busy day. */
export const COPY_BURST_PER_HOUR = 20;
/** Registration renewals are flagged this far ahead. */
export const REGISTRATION_WARNING_DAYS = 30;

// ---------- generators ----------

/** A deal sitting in pending_lenders / needs_pitch longer than the shop's stale_deal_days: the rep hears once per status. */
export async function generateStaleDeals(q: Db): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `with s as (select stale_deal_days as days from shop_settings),
     cand as (
       select d.id, d.user_id, d.client_id, d.number, c.business_name, app.deal_status(d) as status,
              case app.deal_status(d)
                when 'pending_lenders' then d.sent_at
                else (select min(coalesce(x.responded_at, x.status_changed_at)) from submissions x
                       where x.deal_id = d.id and x.status in ('approved', 'revised')) end as since
         from deals d join clients c on c.id = d.client_id
        where d.outcome = 'open' and not exists (select 1 from trashed_clients tc where tc.client_id = d.client_id)
     )
     select count(*)::int as n from (
       select app.alert(cand.user_id, 'stale_deal', cand.client_id, cand.id,
                cand.business_name || ' has sat ' || replace(cand.status, '_', ' ') || ' for ' || extract(day from now() - cand.since)::int || ' days',
                case cand.status when 'pending_lenders' then 'No lender has answered on D-' || cand.number || '. Chase them or add another lender.'
                                 else 'An offer is in on D-' || cand.number || ' and the merchant has not heard it. Pitch it today.' end,
                '/deals/' || cand.id, 'stale_deal:' || cand.id || ':' || cand.status) as w
         from cand, s
        where cand.status in ('pending_lenders', 'needs_pitch') and cand.since is not null
          and cand.since < now() - make_interval(days => s.days)
     ) x where x.w`,
  );
  return rows[0]?.n ?? 0;
}

interface GoalRow {
  user_id: string | null;
  funded_cents: string;
  timezone: string;
  name: string | null;
}

/**
 * Behind pace, once a day: the month's straight-line projection is under the goal (metrics.pace says "behind").
 * The shop's goal alerts the managers; a rep's own goal alerts that rep. Each goal is read on its owner's clock.
 */
export async function generateBehindPace(q: Db, now: Date): Promise<number> {
  const { rows: goals } = await q.query<GoalRow>(
    `select g.user_id, g.funded_cents::text as funded_cents,
            coalesce(u.timezone, (select timezone from app_users where role = 'manager' and active order by created_at limit 1), 'UTC') as timezone,
            u.name
       from goals g left join app_users u on u.id = g.user_id
      where g.funded_cents > 0 and (u.id is null or u.active)`,
  );
  let n = 0;
  for (const g of goals) {
    const today: ISODate = todayIn(g.timezone, now);
    const month = today.slice(0, 7);
    const { rows: f } = await q.query<{ cents: string }>(
      `select coalesce(sum(f.amount_cents), 0)::text as cents from fundings f
        where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1 and ($2::uuid is null or f.user_id = $2)
          and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)`,
      [month, g.user_id],
    );
    const p = pace(Number(f[0]?.cents ?? 0), Number(g.funded_cents), today);
    if (p.status !== "behind") continue;
    const title = `${g.user_id ? "You are" : "The shop is"} behind pace: ${formatMoney(p.fundedCents)} funded of ${formatMoney(p.goalCents)}`;
    const body = `Expected ${formatMoney(p.expectedByNowCents)} by now. ${formatMoney(p.neededPerDayCents)} a day has to fund on the ${p.weekdaysLeft} weekdays left.`;
    const key = `behind_pace:${month}:${today}`;
    if (g.user_id) {
      const { rows } = await q.query<{ w: boolean }>(
        "select app.alert($1, 'behind_pace', null, null, $2, $3, '/', $4) as w",
        [g.user_id, title, body, key],
      );
      if (rows[0]?.w) n += 1;
    } else {
      const { rows } = await q.query<{ n: number }>(
        "select app.alert_managers('behind_pace', null, null, $1, $2, '/', $3) as n",
        [title, body, key],
      );
      n += rows[0]?.n ?? 0;
    }
  }
  return n;
}

/** A state registration renewing within 30 days, or already lapsed: the managers hear once per renewal date. */
export async function generateRegistrationRenewals(q: Db): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select coalesce(sum(x.n), 0)::int as n from (
       select app.alert_managers('registration', null, null,
                case when r.renews_on < current_date
                     then r.state || ' broker registration lapsed on ' || to_char(r.renews_on, 'Mon DD')
                     else r.state || ' broker registration renews on ' || to_char(r.renews_on, 'Mon DD') || ' (' || (r.renews_on - current_date) || ' days)' end,
                case when r.registration_no <> '' then 'Registration ' || r.registration_no || '. ' else '' end ||
                  'Deals in ' || r.state || ' cannot go to lenders without it.',
                '/settings', 'registration:' || r.state || ':' || r.renews_on) as n
         from shop_registrations r
        where r.renews_on is not null and r.status in ('registered', 'filed')
          and r.renews_on <= current_date + $1::int
     ) x`,
    [REGISTRATION_WARNING_DAYS],
  );
  return rows[0]?.n ?? 0;
}

/** A lender past its own pay-after days with commission still unpaid: the rep and the managers hear once per funding. */
export async function generateLatePayouts(q: Db): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select coalesce(sum(x.n), 0)::int as n from (
       select (app.alert(f.user_id, 'late_payout', f.client_id, f.deal_id, t.title, t.body, '/funded', 'late_payout:' || f.id))::int
              + app.alert_managers('late_payout', f.client_id, f.deal_id, t.title, t.body, '/funded', 'late_payout:' || f.id) as n
         from fundings f join clients c on c.id = f.client_id
         cross join lateral (select
            coalesce(nullif(f.funder_name, ''), 'The lender') || ' is late paying commission on ' || c.business_name as title,
            app.fmt_money(coalesce(f.commission_cents, 0) - coalesce(f.commission_received_cents, 0)) || ' was expected by ' ||
              to_char(f.commission_expected_on, 'Mon DD') || ' (' || (current_date - f.commission_expected_on) || ' days ago). Chase the lender.' as body) t
        where f.confirmed_at is not null and f.ledger_state in ('expected', 'at_risk')
          and f.commission_expected_on is not null and f.commission_expected_on < current_date
          and coalesce(f.commission_received_cents, 0) < coalesce(f.commission_cents, 0)
          and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)
     ) x`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Trust patterns from the access log (plan §14.1, §14.3), to the managers: many copies in an hour, copies after
 * hours, copies on another rep's lead, a canary touched. Each window or pair alerts once.
 */
export async function generateTrustAlerts(q: Db, now: Date): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `with burst as (
       select a.user_id, u.name, count(*)::int as copies
         from access_log a join app_users u on u.id = a.user_id
        where a.action in ('copy_contact', 'copy_phone', 'copy_email') and a.at > $1::timestamptz - interval '1 hour' and a.at <= $1::timestamptz
        group by a.user_id, u.name having count(*) >= $2::int
     ),
     after_hours as (
       select a.user_id, u.name, count(*)::int as copies, (a.at at time zone coalesce(u.timezone, 'UTC'))::date as day
         from access_log a join app_users u on u.id = a.user_id
        where a.action in ('copy_contact', 'copy_phone', 'copy_email') and a.at > $1::timestamptz - interval '24 hours' and a.at <= $1::timestamptz
          and extract(hour from a.at at time zone coalesce(u.timezone, 'UTC')) not between 7 and 20
        group by a.user_id, u.name, (a.at at time zone coalesce(u.timezone, 'UTC'))::date
     ),
     others as (
       select distinct a.user_id, u.name, c.id as client_id, c.business_name, o.name as owner_name
         from access_log a join app_users u on u.id = a.user_id join clients c on c.id = a.client_id join app_users o on o.id = c.user_id
        where a.action in ('copy_contact', 'copy_phone', 'copy_email', 'view_contact') and a.at > $1::timestamptz - interval '24 hours'
          and c.user_id <> a.user_id and u.role <> 'manager' and not c.is_canary
     ),
     canary as (
       select distinct a.user_id, u.name, c.id as client_id, c.business_name
         from access_log a join app_users u on u.id = a.user_id join clients c on c.id = a.client_id
        where c.is_canary and a.at > $1::timestamptz - interval '7 days' and a.action <> 'canary_created'
     )
     select coalesce(sum(n), 0)::int as n from (
       select app.alert_managers('trust', null, null, name || ' copied contact details ' || copies || ' times in the last hour',
                'That is a burst, not a busy day. Open the trust panel and look at what was copied.', '/settings/team',
                'trust:copies:' || user_id || ':' || to_char($1::timestamptz, 'YYYY-MM-DD-HH24')) as n from burst
       union all
       select app.alert_managers('trust', null, null, name || ' copied contact details after hours (' || copies || ' since yesterday)',
                'Copies outside 7am–8pm in their own time zone. Open the trust panel to see which merchants.', '/settings/team',
                'trust:after_hours:' || user_id || ':' || day) from after_hours
       union all
       select app.alert_managers('trust', client_id, null, name || ' opened ' || business_name || ', which is ' || coalesce(nullif(owner_name, ''), 'another rep') || '''s lead',
                'A rep reading another rep''s merchant is how a file walks. Ask why.', '/clients/' || client_id,
                'trust:others:' || user_id || ':' || client_id) from others
       union all
       select app.alert_managers('trust', client_id, null, 'Canary touched: ' || name || ' opened ' || business_name,
                'The fake merchant in their book was looked at. Any call to its number says whose book leaked.', '/clients/' || client_id,
                'trust:canary:' || client_id || ':' || user_id) from canary
     ) x`,
    [now.toISOString(), COPY_BURST_PER_HOUR],
  );
  return rows[0]?.n ?? 0;
}

/** Every generator, as the system. Each count is the rows written this run. */
export async function generateAlerts(db: DbAccess, now: Date): Promise<Record<string, number>> {
  return db.withSystem(async (q) => ({
    stale_deal: await generateStaleDeals(q),
    behind_pace: await generateBehindPace(q, now),
    registration: await generateRegistrationRenewals(q),
    late_payout: await generateLatePayouts(q),
    trust: await generateTrustAlerts(q, now),
  }));
}

// ---------- the email ----------

export interface AlertRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  created_at: Date;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One email for everything unsent: the first title is the subject when there is one thing, a count otherwise. */
export function buildAlertEmail(
  rows: readonly AlertRow[],
  appUrl: string,
): { subject: string; text: string; html: string } {
  const first = rows[0];
  const subject =
    rows.length === 1 && first
      ? first.title
      : `${rows.length} things need you — ${first?.title ?? ""}`.slice(0, 150);
  const lines = rows.map((r) => {
    const href = r.href ? `${appUrl}${r.href.startsWith("/") ? "" : "/"}${r.href}` : `${appUrl}/`;
    return {
      text: `• ${r.title}${r.body ? `\n  ${r.body}` : ""}\n  ${href}`,
      html: `<li><a href="${esc(href)}"><strong>${esc(r.title)}</strong></a>${r.body ? `<br><small>${esc(r.body)}</small>` : ""}</li>`,
    };
  });
  return {
    subject,
    text: `${lines.map((l) => l.text).join("\n")}\n\nOpen the CRM: ${appUrl}/\n`,
    html: `<div style="font-family:system-ui,sans-serif"><ul>${lines.map((l) => l.html).join("")}</ul><p><a href="${esc(appUrl)}/">Open the CRM</a></p></div>`,
  };
}

interface UserRow {
  id: string;
  email: string;
  to_email: string;
}

/** Thrown inside the transaction when nothing needs sending, so the claim rolls back cleanly. */
class NothingToSend extends Error {}

/**
 * Generate, then drain: one email per person with unsent alerts, bundling every kind, never more than one an hour.
 * Rows are locked (`for update skip locked`) and stamped in the same transaction as the send: a failed send rolls
 * the stamp back for the next run, and an overlapping run finds the rows locked and sends nothing.
 */
export async function runUserAlerts(args: {
  db: DbAccess;
  now: Date;
  appUrl: string;
  send: DigestSender;
  /** Who may still receive email (see runReminders). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<AlertRunSummary> {
  const generated = await generateAlerts(args.db, args.now);
  const users = await args.db.withSystem(
    async (q) =>
      (
        await q.query<UserRow>(
          `select u.id, u.email, coalesce(u.notify_email, u.email) as to_email
             from app_users u
            where u.active and u.digest_enabled
              and exists (select 1 from user_alerts a where a.user_id = u.id and a.emailed_at is null)
            order by u.created_at`,
        )
      ).rows,
  );
  const summary: AlertRunSummary = {
    generated,
    users: users.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  for (const u of users) {
    if (args.allowed && !args.allowed(u.email)) {
      summary.skipped += 1;
      continue;
    }
    try {
      await args.db.withSystem(async (q) => {
        const recent = await q.query(
          "select 1 from user_alerts where user_id = $1 and emailed_at > $2::timestamptz - interval '1 hour' limit 1",
          [u.id, args.now.toISOString()],
        );
        if ((recent.rowCount ?? 0) > 0) throw new NothingToSend();
        const { rows } = await q.query<AlertRow>(
          `select id::text as id, kind, title, body, href, created_at from user_alerts
            where user_id = $1 and emailed_at is null order by created_at, id for update skip locked`,
          [u.id],
        );
        if (rows.length === 0) throw new NothingToSend();
        await args.send(u.to_email, buildAlertEmail(rows, args.appUrl));
        await q.query("update user_alerts set emailed_at = $2 where id = any($1::bigint[])", [
          rows.map((r) => r.id),
          args.now.toISOString(),
        ]);
      });
      summary.sent += 1;
    } catch (e) {
      if (e instanceof NothingToSend) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error(`alert email failed for user ${u.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return summary;
}
