import type { Db, DbAccess } from "../db";
import { createClient, stampClientTimezone } from "../data/mutations";
import { newClientSchema } from "../data/schemas";
import { findDuplicates, userContext, type DuplicateMatch } from "../data/queries";
import { parseMoney } from "../money";
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

export interface PendingRow {
  id: string;
  source_id: string;
  owner_id: string;
  target_bucket_id: string | null;
  business_name: string;
  contact_name: string;
  email: string;
  email2: string;
  phone: string;
  phone2: string;
  industry: string;
  state: string;
  monthly_revenue_cents: number | null;
  /** The sheet's "amount requested" column as typed: "120k", or free text like "$60k for a second truck". */
  wanted: string;
  notes: string;
  source_name: string;
}

/** The columns `fileOneRow` needs, for any query that joins a sheet row to its source. */
export const PENDING_ROW_COLUMNS = `r.id, r.source_id, s.target_bucket_id, s.name as source_name, r.business_name, r.contact_name,
       r.email, r.email2, r.phone, r.phone2, r.industry, r.state, r.monthly_revenue_cents, r.wanted, r.notes`;

export type FileOutcome =
  | { result: "filed"; clientId: string; welcomeSent: boolean }
  /** Already in the CRM: nothing was made; `match` says whose it is and where it sits. */
  | { result: "duplicate"; clientId: string; match: DuplicateMatch };

/** What the intake form typed over the sheet's row. */
export interface FileExtras {
  /** "Amount they want", in cents; when absent the sheet's `wanted` is used if it is a plain amount. */
  wantedAmountCents?: number | null;
  /** "What are they looking for", in the merchant's words; when absent, a `wanted` that is not a plain amount. */
  lookingFor?: string;
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
          `select coalesce(s.owner_id, s.reader_user_id) as owner_id, ${PENDING_ROW_COLUMNS}
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
    try {
      const r = await args.db.withUser(row.owner_id, (q) =>
        fileOneRow(q, row, args.appUrl, args.now),
      );
      if (r.result === "filed") summary.filed += 1;
      else summary.duplicates += 1;
    } catch (e) {
      // The row stays unfiled (nothing was written — the transaction rolled back), so a corrected sheet row
      // files on a later run instead of being silently marked done with no merchant behind it.
      summary.skipped += 1;
      console.error(`sheet row ${row.id} could not be filed:`, e instanceof Error ? e.message : e);
    }
  }
  return summary;
}

/**
 * File one staged row as a merchant for the signed-in rep (also what the intake form calls after autofill).
 * A phone (or, with no phone, a name) already in the CRM is a duplicate: the row is marked as that merchant's.
 * Anything that stops the merchant being made is thrown, not swallowed — the row stays unfiled and the caller
 * shows the reason.
 */
export async function fileOneRow(
  q: Db,
  row: PendingRow,
  appUrl: string,
  now = new Date(),
  bucketOverride?: string | null,
  extras: FileExtras = {},
): Promise<FileOutcome> {
  const dupes = await findDuplicates(q, { phone: row.phone, businessName: row.business_name });
  const dupe = dupes.find((m) => m.reason === "same phone" || !row.phone || !m.phone);
  if (dupe) {
    await q.query("update sheet_rows set filed_at = now(), client_id = $2 where id = $1", [
      row.id,
      dupe.id,
    ]);
    return { result: "duplicate", clientId: dupe.id, match: dupe };
  }
  const ctx = await userContext(q, now);
  // "120k" is an amount; "$60k for a second truck" is what they are looking for, in their words.
  const sheetAmount = parseMoney(row.wanted);
  const wantedCents = extras.wantedAmountCents ?? sheetAmount;
  const lookingFor = extras.lookingFor || (sheetAmount === null ? row.wanted : "");
  const card = await createClient(
    q,
    {
      ...newClientSchema.parse({
        businessName: row.business_name || row.contact_name,
        contactName: row.contact_name,
        phone: row.phone || row.phone2,
        email: row.email,
        industry: row.industry,
        state: row.state,
        source: row.source_name,
        stage: "name_in",
        followUpOn: ctx.today,
      }),
      // both are already cents; the schema's money fields take dollars, so they go in beside it, not through it
      wantedAmount: wantedCents,
      monthlyRevenue: row.monthly_revenue_cents,
    },
    ctx,
  );
  await q.query(
    "update clients set lead_source_kind = 'sheet', phone2 = $2, email2 = $3, looking_for = $4 where id = $1",
    [card.id, row.phone2, row.email2, lookingFor],
  );
  await stampClientTimezone(q, card.id);
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
  let welcomeSent = false;
  if (bucket) {
    await q.query("select enroll_in_bucket($1, $2, 'moved')", [card.id, bucket]);
    welcomeSent = await sendWelcome(q, card.id, bucket, appUrl, now);
  }
  return { result: "filed", clientId: card.id, welcomeSent };
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
    template_id: string;
    subject: string;
    body: string;
    contact_name: string;
    business_name: string;
    sender_name: string;
    application_link: string;
    signature: string;
    token: string;
  }>(
    `select t.id as template_id, t.subject, t.body, c.contact_name, c.business_name, u.name as sender_name, u.application_link, u.signature, c.unsubscribe_token as token
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
      templateId: r.template_id,
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
