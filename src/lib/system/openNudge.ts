import type { DbAccess } from "../db";
import { applyLink } from "../docs/applyLink";
import { missingDocsFor } from "../docs/missing";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";
import type { LinkKind } from "./linkSignals";

/**
 * The "opened but did not finish" nudge (db/migrations/0548_open_nudge.sql). Hourly, when a manager has switched it
 * on: a merchant whose latest open of their upload link or application was 20 to 72 hours ago, and who has not
 * finished since, gets that link again in one short email at their next sending window. Never twice in a week, and
 * not at all when anything since the open says a person or the merchant already moved: a document or signature, a
 * reply, a call, an email that went out, one already waiting to go, a "not now" pause, a hand-off or the trash.
 * Opt-outs, bounces and do-not-contact are refused by enqueueEmail; caps and the postal-address gate by the worker.
 */

export const NUDGE_AFTER_HOURS = 20;
export const NUDGE_WITHIN_HOURS = 72;

export interface NudgeSummary {
  queued: number;
  skipped: number;
}

interface Candidate {
  client_id: string;
  user_id: string;
  kind: LinkKind;
  opened_at: string;
  contact_name: string;
  business_name: string;
  upload_token: string;
  application_token: string | null;
  sender_name: string;
  application_link: string;
  signature: string;
}

export async function runOpenNudges(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
}): Promise<NudgeSummary> {
  const now = args.now ?? new Date();
  const out: NudgeSummary = { queued: 0, skipped: 0 };
  const setup = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{ on: boolean; upload: string | null; apply: string | null }>(
          `select open_nudge as on, open_nudge_upload_template as upload, open_nudge_apply_template as apply
             from shop_settings`,
        )
      ).rows[0],
  );
  if (!setup?.on) return out;

  const due = await args.db.withSystem(
    async (q) =>
      (
        await q.query<Candidate>(
          `with latest as (
             select distinct on (lo.client_id) lo.client_id, lo.kind, lo.opened_at
               from link_opens lo
              where lo.opened_at > $1::timestamptz - make_interval(hours => $3)
              order by lo.client_id, lo.opened_at desc)
           select l.client_id, c.user_id, l.kind, l.opened_at::text as opened_at, c.contact_name, c.business_name,
                  c.upload_token, c.application_token, u.name as sender_name, u.application_link, u.signature
             from latest l
             join clients c on c.id = l.client_id
             join app_users u on u.id = c.user_id
            where l.opened_at <= $1::timestamptz - make_interval(hours => $2)
              and c.brought_in_at is null
              and not exists (select 1 from trashed_clients t where t.client_id = c.id)
              and not exists (select 1 from enrollments e where e.client_id = c.id and e.stopped_at is null and e.paused)
              and not (l.kind = 'apply' and exists (select 1 from applications a
                                                     where a.client_id = c.id and a.signed_at >= l.opened_at))
              and not (l.kind = 'upload' and exists (select 1 from documents d
                                                      where d.client_id = c.id and d.created_at >= l.opened_at))
              and not exists (select 1 from inbound_emails ie where ie.client_id = c.id and ie.received_at >= l.opened_at)
              and not exists (select 1 from activities a where a.client_id = c.id and a.kind = 'call'
                                 and a.occurred_at >= l.opened_at)
              and not exists (select 1 from outbox o where o.client_id = c.id
                                 and (o.status in ('queued', 'sending')
                                      or (o.status = 'sent' and o.sent_at >= l.opened_at)
                                      or (o.source like 'nudge:%' and o.created_at > $1::timestamptz - interval '7 days')))
            order by l.opened_at
            limit 200`,
          [now.toISOString(), NUDGE_AFTER_HOURS, NUDGE_WITHIN_HOURS],
        )
      ).rows,
  );

  for (const c of due) {
    const templateId = c.kind === "apply" ? setup.apply : setup.upload;
    const queued = templateId
      ? await args.db.withSystem(async (q) => {
          const tpl = (
            await q.query<{ subject: string; body: string }>(
              "select subject, body from templates where id = $1 and app.template_may_auto_send(id)",
              [templateId],
            )
          ).rows[0];
          if (!tpl) return false;
          const values = mergeValues({
            contactName: c.contact_name,
            businessName: c.business_name,
            senderName: c.sender_name,
            applicationLink:
              c.application_link ||
              (c.application_token ? applyLink(args.appUrl, c.application_token) : ""),
            wantedAmountCents: null,
            uploadLink: `${args.appUrl}/upload/${c.upload_token}`,
            missingDocs: await missingDocsFor(q, c.client_id),
          });
          const body = resolveMergeFields(tpl.body, values);
          const subject = resolveMergeFields(tpl.subject, values);
          if (body.missing.length || subject.missing.length) return false;
          const r = await enqueueEmail(
            q,
            {
              clientId: c.client_id,
              lane: "sequence",
              source: `nudge:${c.kind}:${c.opened_at.slice(0, 10)}`,
              subject: subject.text || `About ${c.business_name}`,
              text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(c.signature, c.sender_name)}`,
              when: "window",
              expiresInHours: 24,
              templateId,
            },
            now,
          );
          if (!r.queued) return false;
          await q.query(
            "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
            [
              c.user_id,
              c.client_id,
              c.kind === "apply"
                ? "Opened the application and did not finish: a nudge email is queued"
                : "Opened the upload link and sent nothing: a nudge email is queued",
            ],
          );
          return true;
        })
      : false;
    if (queued) out.queued += 1;
    else out.skipped += 1;
  }
  return out;
}
