import type { Db, DbAccess } from "../db";
import { createClient } from "../data/mutations";
import { newClientSchema } from "../data/schemas";
import { findDuplicates, userContext } from "../data/queries";
import { enqueueEmail } from "../send/enqueue";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";

/**
 * The daily loop: every sheet row the sync saw for the first time and nobody has filed yet becomes a merchant in
 * the sheet's target bucket, for sheets with auto_file on. The same row twice (a vendor re-sending) is caught by
 * the shop-wide duplicate check, so one merchant never becomes two. The welcome email goes out through the
 * intake lane (never blocked by the cap).
 */

export interface FileSummary {
  sources: number;
  filed: number;
  duplicates: number;
  skipped: number;
}

interface PendingRow {
  id: string;
  source_id: string;
  owner_id: string;
  target_bucket_id: string | null;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  phone2: string;
  industry: string;
  state: string;
  monthly_revenue_cents: number | null;
  wanted: string;
  notes: string;
  source_name: string;
}

export async function fileNewSheetRows(args: {
  db: DbAccess;
  appUrl: string;
  now?: Date;
  max?: number;
}): Promise<FileSummary> {
  const summary: FileSummary = { sources: 0, filed: 0, duplicates: 0, skipped: 0 };
  const pending = await args.db.withSystem(
    async (q) =>
      (
        await q.query<PendingRow>(
          `select r.id, r.source_id, coalesce(s.owner_id, s.reader_user_id) as owner_id, s.target_bucket_id, s.name as source_name,
                  r.business_name, r.contact_name, r.email, r.phone, r.phone2, r.industry, r.state, r.monthly_revenue_cents, r.wanted, r.notes
             from sheet_rows r join sheet_sources s on s.id = r.source_id
            where s.active and s.auto_file and r.filed_at is null and r.client_id is null
            order by r.first_seen_at limit $1`,
          [args.max ?? 500],
        )
      ).rows,
  );
  summary.sources = new Set(pending.map((p) => p.source_id)).size;
  for (const row of pending) {
    if (!row.owner_id) {
      summary.skipped += 1;
      continue;
    }
    await args.db.withUser(row.owner_id, async (q) => {
      const r = await fileOneRow(q, row, args.appUrl, args.now);
      if (r === "filed") summary.filed += 1;
      else if (r === "duplicate") summary.duplicates += 1;
      else summary.skipped += 1;
    });
  }
  return summary;
}

/** File one staged row as a merchant for the signed-in rep (also what the intake form calls after autofill). */
export async function fileOneRow(
  q: Db,
  row: PendingRow,
  appUrl: string,
  now = new Date(),
  bucketOverride?: string | null,
): Promise<"filed" | "duplicate" | "skipped"> {
  const dupes = await findDuplicates(q, { phone: row.phone, businessName: row.business_name });
  const dupe = dupes.find((m) => m.reason === "same phone" || !row.phone || !m.phone);
  if (dupe) {
    await q.query("update sheet_rows set filed_at = now(), client_id = $2 where id = $1", [
      row.id,
      dupe.id,
    ]);
    return "duplicate";
  }
  const ctx = await userContext(q, now);
  let card;
  try {
    card = await createClient(
      q,
      newClientSchema.parse({
        businessName: row.business_name || row.contact_name,
        contactName: row.contact_name,
        phone: row.phone || row.phone2,
        email: row.email,
        industry: row.industry,
        state: row.state,
        source: row.source_name,
        wantedAmount: row.wanted || undefined,
        monthlyRevenue: row.monthly_revenue_cents ?? undefined,
        stage: "name_in",
        followUpOn: ctx.today,
      }),
      ctx,
    );
  } catch {
    await q.query("update sheet_rows set filed_at = now() where id = $1", [row.id]);
    return "skipped";
  }
  await q.query("update clients set lead_source_kind = 'sheet' where id = $1", [card.id]);
  if (row.notes)
    await q.query(
      "insert into activities (user_id, client_id, kind, body) select user_id, id, 'note', $2 from clients where id = $1",
      [card.id, `From the sheet: ${row.notes}`],
    );
  await q.query("update sheet_rows set filed_at = now(), client_id = $2 where id = $1", [
    row.id,
    card.id,
  ]);
  const bucket = bucketOverride === undefined ? row.target_bucket_id : bucketOverride;
  if (bucket) {
    await q.query("select enroll_in_bucket($1, $2, 'moved')", [card.id, bucket]);
    await sendWelcome(q, card.id, bucket, appUrl, now);
  }
  return "filed";
}

/** The bucket's step-1 template, sent at once through the intake lane. */
export async function sendWelcome(
  q: Db,
  clientId: string,
  bucketId: string,
  appUrl: string,
  now = new Date(),
): Promise<boolean> {
  const { rows } = await q.query<{
    subject: string;
    body: string;
    contact_name: string;
    business_name: string;
    sender_name: string;
    application_link: string;
    signature: string;
    token: string;
  }>(
    `select t.subject, t.body, c.contact_name, c.business_name, u.name as sender_name, u.application_link, u.signature, c.unsubscribe_token as token
       from bucket_steps s join templates t on t.id = s.template_id
       join clients c on c.id = $1 join app_users u on u.id = c.user_id
      where s.bucket_id = $2 and s.action = 'email' and app.template_may_auto_send(t.id)
      order by s.step_no limit 1`,
    [clientId, bucketId],
  );
  const r = rows[0];
  if (!r) return false;
  const values = mergeValues({
    contactName: r.contact_name,
    businessName: r.business_name,
    senderName: r.sender_name,
    applicationLink: r.application_link,
    wantedAmountCents: null,
    bestOffer: null,
    uploadLink: `${appUrl}/upload/${r.token}`,
  });
  const body = resolveMergeFields(r.body, values);
  const subject = resolveMergeFields(r.subject, values);
  if (body.missing.length || subject.missing.length) return false;
  const sent = await enqueueEmail(
    q,
    {
      clientId,
      lane: "intake",
      source: `bucket:${bucketId}:step:1`,
      subject: subject.text || `About ${r.business_name}`,
      text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(r.signature, r.sender_name)}`,
      when: "now",
      expiresInHours: 24,
    },
    now,
  );
  if (sent.queued) {
    // step 1 is done by the welcome; the sequence continues from step 2
    await q.query(
      `update enrollments e set next_step = 2, steps_sent = 1, last_outbox_id = $3,
              next_due_on = coalesce((select (e.entered_at at time zone app.client_timezone(c))::date + s.day_offset
                                        from bucket_steps s, clients c where s.bucket_id = e.bucket_id and s.step_no = 2 and c.id = e.client_id), e.next_due_on)
        where e.client_id = $1 and e.bucket_id = $2 and e.stopped_at is null`,
      [clientId, bucketId, sent.outboxId],
    );
  }
  return sent.queued;
}
