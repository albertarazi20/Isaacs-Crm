/**
 * The renewal engine's emails (plan §9.5; audit S3-4). SQL roll_funding_clocks turns the paydown dates into the
 * rep's tasks; this job sends the merchant the two emails on the same dates, through the normal outbox path (the
 * cap, the suppression list, opt-out and the send window all apply), stamps the funding so each goes once, and tells
 * the rep when the merchant becomes eligible. start_renewal (SQL) opens the pre-filled deal from the funding.
 */
import type { Db, DbAccess } from "../db";
import { todayIn } from "../mca/dates";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";

export interface RenewalRunSummary {
  warmed: number;
  eligible: number;
  skipped: number;
}

export const WARM_TEMPLATE = "Renewal — warm-up";
export const ELIGIBLE_TEMPLATE = "Renewal — eligible";

interface DueRow {
  id: string;
  user_id: string;
  client_id: string;
  funder_name: string;
  amount_cents: number;
  renewal_warm_on: string | null;
  renewal_eligible_on: string | null;
  renewal_warm_sent_at: Date | null;
  renewal_eligible_sent_at: Date | null;
  timezone: string;
  contact_name: string;
  business_name: string;
  sender_name: string;
  application_link: string;
  signature: string;
  token: string;
  open_deal: boolean;
}

interface TemplateRow {
  subject: string;
  body: string;
}

async function template(q: Db, name: string): Promise<TemplateRow | null> {
  const { rows } = await q.query<TemplateRow>(
    `select t.subject, t.body from templates t
      where t.owner_id is null and not t.archived and lower(t.name) = lower($1) and app.template_may_auto_send(t.id)
      order by t.created_at limit 1`,
    [name],
  );
  return rows[0] ?? null;
}

export async function runRenewals(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
}): Promise<RenewalRunSummary> {
  const now = args.now ?? new Date();
  const s: RenewalRunSummary = { warmed: 0, eligible: 0, skipped: 0 };
  const due = await args.db.withSystem(
    async (q) =>
      (
        await q.query<DueRow>(
          `select f.id, f.user_id, f.client_id, f.funder_name, f.amount_cents, f.renewal_warm_on::text as renewal_warm_on,
                  f.renewal_eligible_on::text as renewal_eligible_on, f.renewal_warm_sent_at, f.renewal_eligible_sent_at,
                  app.client_timezone(c) as timezone, c.contact_name, c.business_name,
                  u.name as sender_name, u.application_link, u.signature, c.upload_token as token,
                  exists (select 1 from deals d where d.client_id = c.id and d.outcome = 'open') as open_deal
             from fundings f join clients c on c.id = f.client_id join app_users u on u.id = f.user_id
            where f.status = 'active' and f.confirmed_at is not null
              and ((f.renewal_warm_on is not null and f.renewal_warm_sent_at is null)
                or (f.renewal_eligible_on is not null and f.renewal_eligible_sent_at is null))
              and least(coalesce(f.renewal_warm_on, f.renewal_eligible_on), coalesce(f.renewal_eligible_on, f.renewal_warm_on))
                  <= (($1::timestamptz at time zone app.client_timezone(c))::date)
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
            order by f.renewal_eligible_on nulls last, f.renewal_warm_on`,
          [now.toISOString()],
        )
      ).rows,
  );
  for (const f of due) {
    await args.db.withSystem(async (q) => {
      const today = todayIn(f.timezone, now);
      const eligibleNow = f.renewal_eligible_on !== null && f.renewal_eligible_on <= today;
      const warmNow = f.renewal_warm_on !== null && f.renewal_warm_on <= today;
      const values = mergeValues({
        contactName: f.contact_name,
        businessName: f.business_name,
        senderName: f.sender_name,
        applicationLink: f.application_link,
        wantedAmountCents: null,
        bestOffer: null,
        uploadLink: `${args.appUrl}/upload/${f.token}`,
      });
      const sendOne = async (name: string, source: string): Promise<boolean> => {
        const t = await template(q, name);
        if (!t) return false;
        const body = resolveMergeFields(t.body, values);
        const subject = resolveMergeFields(t.subject, values);
        if (body.missing.length || subject.missing.length) return false;
        const r = await enqueueEmail(
          q,
          {
            clientId: f.client_id,
            lane: "sequence",
            source,
            subject: subject.text || `About ${f.business_name}`,
            text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(f.signature, f.sender_name)}`,
            when: "window",
            expiresInHours: 72,
          },
          now,
        );
        return r.queued;
      };
      // eligible: the email with the upload link and the rep's alert; stamps both dates (the warm-up is moot now)
      if (eligibleNow && f.renewal_eligible_sent_at === null) {
        const queued = f.open_deal
          ? false
          : await sendOne(ELIGIBLE_TEMPLATE, `renewal:eligible:${f.id}`);
        await q.query(
          "update fundings set renewal_eligible_sent_at = $2, renewal_warm_sent_at = coalesce(renewal_warm_sent_at, $2) where id = $1",
          [f.id, now.toISOString()],
        );
        await q.query("select app.alert($1, 'renewal_eligible', $2, null, $3, $4, $5, $6)", [
          f.user_id,
          f.client_id,
          `${f.business_name} is eligible for more funds`,
          `The ${f.funder_name || "current"} advance has paid down to the lender's renewal line. ${queued ? "The merchant was emailed for the newest statement." : "Start the renewal from the merchant page."}`,
          `/clients/${f.client_id}`,
          `renewal_eligible:${f.id}`,
        ]);
        if (queued) s.eligible += 1;
        else s.skipped += 1;
        return;
      }
      if (warmNow && f.renewal_warm_sent_at === null) {
        const queued = f.open_deal ? false : await sendOne(WARM_TEMPLATE, `renewal:warm:${f.id}`);
        await q.query("update fundings set renewal_warm_sent_at = $2 where id = $1", [
          f.id,
          now.toISOString(),
        ]);
        if (queued) s.warmed += 1;
        else s.skipped += 1;
      }
    });
  }
  return s;
}

export interface RenewalDeal {
  id: string;
  number: number;
  client_id: string;
  kind: string;
  requested_cents: number;
  rep_note: string;
  blocker: string;
}

/** Opens the renewal deal pre-filled from the funding and asks the merchant for the newest statement. */
export async function startRenewal(q: Db, fundingId: string): Promise<RenewalDeal> {
  const { rows } = await q.query<{ j: RenewalDeal }>(
    "select to_jsonb(d) as j from start_renewal($1) d",
    [fundingId],
  );
  const d = rows[0]?.j;
  if (!d) throw new Error("start_renewal returned no row");
  return d;
}
