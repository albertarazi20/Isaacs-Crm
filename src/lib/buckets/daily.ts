import { UserError } from "../data/mutations";
import type { Db } from "../db";

/**
 * Pick (or clear) a bucket's daily reminder (0593): one template sent to every live member once a day, every day but
 * Saturday, at the shop's reminder time in the merchant's own zone. Managers only, checked here against the
 * database's own idea of the role so a rep's own bucket cannot be switched over by a crafted request. Only an email
 * template the engine may send on its own is accepted (not archived, approved or shared). When the template changes,
 * every live member is made due at once (the engine then books today's slot, or the next day's if it has passed) and
 * the queued emails of the old step list are taken back, so a member never gets both. Clearing just empties the
 * column: the step list is used again and the engine drops any daily email still queued. Run it under db.withUser.
 */
export async function setBucketDailyTemplate(
  q: Db,
  args: { bucketId: string; templateId: string | null },
): Promise<{ changed: boolean; reset: number }> {
  const manager = (await q.query<{ ok: boolean }>("select app.can_see_all() as ok")).rows[0]?.ok;
  if (!manager) throw new UserError("Only a manager picks a bucket's daily reminder");
  const bucket = (
    await q.query<{ daily_template_id: string | null }>(
      "select daily_template_id from buckets where id = $1 for update",
      [args.bucketId],
    )
  ).rows[0];
  if (!bucket) throw new UserError("Bucket not found");
  if (args.templateId !== null) {
    const t = (
      await q.query<{ channel: string; ok: boolean }>(
        "select t.channel, app.template_may_auto_send(t.id) as ok from templates t where t.id = $1",
        [args.templateId],
      )
    ).rows[0];
    if (!t) throw new UserError("Template not found");
    if (t.channel !== "email") throw new UserError("A daily reminder has to be an email template");
    if (!t.ok)
      throw new UserError(
        "That template can't be sent on its own yet: it is archived or waiting for a manager's approval.",
      );
  }
  const changed = bucket.daily_template_id !== args.templateId;
  if (!changed) return { changed: false, reset: 0 };
  await q.query("update buckets set daily_template_id = $2 where id = $1", [
    args.bucketId,
    args.templateId,
  ]);
  if (args.templateId === null) return { changed: true, reset: 0 };
  await q.query(
    `update outbox set status = 'cancelled', skip_reason = 'stopped'
      where status = 'queued' and lane = 'sequence' and source like $1`,
    [`bucket:${args.bucketId}:step:%`],
  );
  const r = await q.query(
    `update enrollments set next_step = 1, next_due_on = current_date - 1
      where bucket_id = $1 and stopped_at is null`,
    [args.bucketId],
  );
  return { changed: true, reset: r.rowCount ?? 0 };
}
