import { UserError } from "../data/mutations";
import type { Db } from "../db";
import { expiryWords, stopApprovalEmails } from "./engine";
import { checkDesign, subjectFromHtml } from "./html";
import { offerMoney } from "./words";
import type {
  ApprovalEditInput,
  ApprovalInput,
  ApprovalSettingsInput,
  DesignInput,
} from "./schemas";

/** Remember what the emails were doing, then stop them: an Undo puts them back as they were. */
async function stopRemembering(q: Db, a: { id: string; emails: string }, note: string) {
  await q.query(
    `update approvals set emails_before = emails, emails_note_before = emails_note where id = $1 and status = 'open'`,
    [a.id],
  );
  await stopApprovalEmails(q, a.id, a.emails === "finished" ? "finished" : "stopped", note);
}

interface Ctx {
  userId: string;
  now: Date;
  appUrl: string;
}

/** A line on the merchant's timeline. It belongs to the merchant's rep; a manager acting on it is named. */
async function activity(q: Db, userId: string, clientId: string, body: string): Promise<void> {
  await q.query(
    `insert into activities (user_id, client_id, kind, body)
     select c.user_id, c.id, 'system',
            $3 || case when c.user_id <> $1 then coalesce(' (' || nullif(u.name, '') || ')', '') else '' end
       from clients c left join app_users u on u.id = $1
      where c.id = $2`,
    [userId, clientId, body],
  );
}

async function openApproval(q: Db, approvalId: string) {
  const { rows } = await q.query<{
    id: string;
    client_id: string;
    status: string;
    emails: string;
    emails_note: string;
    business_name: string;
  }>(
    `select a.id, a.client_id, a.status, a.emails, a.emails_note, c.business_name
       from approvals a join clients c on c.id = a.client_id where a.id = $1 for update of a`,
    [approvalId],
  );
  const a = rows[0];
  if (!a) throw new UserError("That approval no longer exists");
  return a;
}

async function offerAccepted(q: Db, approvalId: string): Promise<boolean> {
  const { rows } = await q.query(
    "select 1 from merchant_offers where approval_id = $1 and status = 'accepted' limit 1",
    [approvalId],
  );
  return rows.length > 0;
}

const offerWords = (cents: number, holdUntil: string | null) =>
  `${offerMoney(cents)}${holdUntil ? `, held until ${expiryWords(holdUntil)}` : ""}`;

/**
 * "Got an approval": the merchant goes on the Open approvals page. The action then moves it along on the owner
 * connection (src/lib/system/approvals.ts), which puts the first email on the outbox unless the rep held the emails.
 * The emails come from the merchant's rep.
 */
export async function createApproval(
  q: Db,
  input: ApprovalInput,
  ctx: Ctx,
): Promise<{ approvalId: string; started: boolean }> {
  const { rows } = await q.query<{ user_id: string; business_name: string }>(
    "select user_id, business_name from clients where id = $1",
    [input.clientId],
  );
  const client = rows[0];
  if (!client) throw new UserError("That merchant no longer exists");
  const trashed = await q.query("select 1 from trashed_clients where client_id = $1", [
    input.clientId,
  ]);
  if ((trashed.rowCount ?? 0) > 0) throw new UserError("That merchant is in the trash");
  let approvalId: string;
  try {
    const ins = await q.query<{ id: string }>(
      `insert into approvals (client_id, user_id, amount_cents, hold_until, funder, note, created_by, emails, emails_note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        input.clientId,
        client.user_id,
        input.amount,
        input.holdUntil,
        input.funder,
        input.note,
        ctx.userId,
        input.startEmails ? "running" : "paused",
        input.startEmails ? "" : "held",
      ],
    );
    approvalId = ins.rows[0]?.id ?? "";
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new UserError(`${client.business_name} already has an open approval`);
    throw e;
  }
  await activity(
    q,
    ctx.userId,
    input.clientId,
    `Approved: ${offerWords(input.amount, input.holdUntil)}${input.funder ? ` (${input.funder})` : ""}`,
  );
  return { approvalId, started: input.startEmails };
}

/**
 * Change the offer (amount, hold date, funder, note). An email already queued with the old numbers is taken back; the
 * action fills it again. Returns the approval's id.
 */
export async function editApproval(q: Db, input: ApprovalEditInput, ctx: Ctx): Promise<string> {
  const a = await openApproval(q, input.approvalId);
  if (a.status !== "open") throw new UserError("That approval is not open any more");
  await q.query(
    "update approvals set amount_cents = $2, hold_until = $3, funder = $4, note = $5 where id = $1 and status = 'open'",
    [a.id, input.amount, input.holdUntil, input.funder, input.note],
  );
  await activity(
    q,
    ctx.userId,
    a.client_id,
    `Approval changed: ${offerWords(input.amount, input.holdUntil)}`,
  );
  // a queued email still says the old numbers: take it back to be filled again
  await q.query(
    `update outbox set status = 'cancelled', skip_reason = 'edited'
      where lane = 'approval' and status = 'queued' and source like $1`,
    [`approval:${a.id}:step:%`],
  );
  return a.id;
}

/** The rep pitched the offer: it leaves the page and the emails stop. */
export async function markPitched(
  q: Db,
  approvalId: string,
  ctx: Ctx,
): Promise<{ business: string }> {
  const a = await openApproval(q, approvalId);
  if (a.status !== "open") throw new UserError("That approval is not open any more");
  await stopRemembering(q, a, "pitched");
  await q.query(
    "update approvals set status = 'pitched', pitched_at = $2, pitched_by = $3 where id = $1",
    [a.id, ctx.now.toISOString(), ctx.userId],
  );
  await activity(q, ctx.userId, a.client_id, "Approval pitched");
  return { business: a.business_name };
}

/** Not going ahead (declined, went elsewhere, offer pulled): it leaves the page and the emails stop. */
export async function closeApproval(
  q: Db,
  approvalId: string,
  reason: string,
  ctx: Ctx,
): Promise<{ business: string }> {
  const a = await openApproval(q, approvalId);
  if (a.status !== "open") throw new UserError("That approval is not open any more");
  await stopRemembering(q, a, "closed");
  await q.query(
    "update approvals set status = 'closed', closed_at = $2, closed_by = $3, closed_reason = $4 where id = $1",
    [a.id, ctx.now.toISOString(), ctx.userId, reason],
  );
  await activity(q, ctx.userId, a.client_id, `Approval closed${reason ? `: ${reason}` : ""}`);
  return { business: a.business_name };
}

/**
 * Back on the page after a pitch or a close. `restore` (the Undo in the toast, seconds later) puts the emails back as
 * they were: running, paused, held or finished. Without it (Reopen from the Pitched tab, days later) they stay
 * stopped until a rep presses Resume, so a pile of overdue emails never goes out by surprise. Returns whether the
 * emails are running again, so the action can move them along.
 */
export async function reopenApproval(
  q: Db,
  approvalId: string,
  ctx: Ctx,
  restore = false,
): Promise<{ running: boolean }> {
  const a = await openApproval(q, approvalId);
  if (a.status === "open") return { running: false };
  try {
    await q.query(
      `update approvals set status = 'open', pitched_at = null, pitched_by = null, closed_at = null, closed_by = null,
              closed_reason = '',
              emails = case when emails = 'finished' then 'finished'
                            when $2 and emails_before is not null then emails_before else 'stopped' end,
              emails_note = case when emails = 'finished' then ''
                                 when $2 and emails_before is not null then coalesce(emails_note_before, '')
                                 else 'reopened' end,
              emails_before = null, emails_note_before = null
        where id = $1`,
      [a.id, restore],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new UserError(`${a.business_name} already has another open approval`);
    throw e;
  }
  await activity(q, ctx.userId, a.client_id, "Approval reopened");
  const now = await q.query<{ emails: string }>("select emails from approvals where id = $1", [
    a.id,
  ]);
  return { running: now.rows[0]?.emails === "running" };
}

export async function pauseApprovalEmails(q: Db, approvalId: string): Promise<void> {
  const a = await openApproval(q, approvalId);
  if (a.status !== "open") throw new UserError("That approval is not open any more");
  if (a.emails !== "running") return;
  await stopApprovalEmails(q, a.id, "paused", "paused");
}

/**
 * Start, resume or restart the emails. Whatever stopped them before (a reply, a failed send) no longer counts: the
 * clock restarts at the database's now, the same clock the outbox and the inbox stamp rows with. The action then moves
 * it along: the next step goes when it is due (at once if it is overdue).
 */
export async function resumeApprovalEmails(q: Db, approvalId: string): Promise<void> {
  const a = await openApproval(q, approvalId);
  if (a.status !== "open") throw new UserError("That approval is not open any more");
  if (a.emails === "finished") throw new UserError("Every approval email has already gone");
  // already going (another rep resumed it, or a double click): restarting the clock would hide a reply
  if (a.emails === "running") return;
  if (a.emails_note === "offer_accepted" || (await offerAccepted(q, a.id)))
    throw new UserError("The merchant accepted the offer: the emails are done");
  await q.query(
    "update approvals set emails = 'running', emails_note = '', emails_since = now() where id = $1",
    [a.id],
  );
}

// ── Settings (managers) ───────────────────────────────────────────────────────────────────────────

/** An email already queued was filled from the old design: take it back, and the engine fills it again. */
async function refreshQueued(q: Db, step: number): Promise<void> {
  await q.query(
    `update outbox set status = 'cancelled', skip_reason = 'design_changed'
      where lane = 'approval' and status = 'queued' and split_part(source, ':', 4) = $1::text`,
    [step],
  );
}

/** Save one email's design. Refused with the reasons if it would not go out right. */
export async function saveApprovalDesign(
  q: Db,
  input: DesignInput,
  userId: string,
): Promise<{ warnings: string[]; subject: string }> {
  const subject = input.subject || subjectFromHtml(input.html);
  const check = checkDesign(input.html, subject);
  if (check.errors.length > 0) throw new UserError(check.errors.join(" "));
  const res = await q.query(
    `update approval_emails set subject = $2, html = $3, file_name = $4, updated_by = $5 where step = $1`,
    [input.step, subject, check.html, input.fileName, userId],
  );
  if ((res.rowCount ?? 0) === 0) throw new UserError("That email is not in the sequence any more");
  await refreshQueued(q, input.step);
  return { warnings: check.warnings, subject };
}

export async function clearApprovalDesign(q: Db, step: number, userId: string): Promise<void> {
  await q.query(
    "update approval_emails set subject = '', html = '', file_name = '', updated_by = $2 where step = $1",
    [step, userId],
  );
  await refreshQueued(q, step);
}

export async function setApprovalDelay(
  q: Db,
  step: number,
  hours: number,
  userId: string,
): Promise<void> {
  const res = await q.query(
    "update approval_emails set delay_hours = $2, updated_by = $3 where step = $1",
    [step, hours, userId],
  );
  if ((res.rowCount ?? 0) === 0) throw new UserError("That email is not in the sequence any more");
}

/** Another follow-up at the end (six emails at most). */
export async function addApprovalStep(q: Db, userId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "select coalesce(max(step), 0)::int as n from approval_emails",
  );
  const n = (rows[0]?.n ?? 0) + 1;
  if (n > 6) throw new UserError("Six emails is the most an approval gets");
  await q.query("insert into approval_emails (step, delay_hours, updated_by) values ($1, $2, $3)", [
    n,
    n === 1 ? 0 : 48,
    userId,
  ]);
  return n;
}

/** Take the last follow-up off. The first email always stays. */
export async function removeLastApprovalStep(q: Db): Promise<void> {
  const { rows } = await q.query<{ n: number }>(
    "select coalesce(max(step), 0)::int as n from approval_emails",
  );
  const n = rows[0]?.n ?? 0;
  if (n <= 1) throw new UserError("The first email always stays");
  await q.query("delete from approval_emails where step = $1", [n]);
  await refreshQueued(q, n);
}

export async function setApprovalSettings(q: Db, input: ApprovalSettingsInput): Promise<void> {
  await q.query(
    `update shop_settings set approval_emails_on = $1, approval_window_start = $2, approval_window_end = $3,
            approval_weekends = $4`,
    [input.on, input.windowStart, input.windowEnd, input.weekends],
  );
}

export async function setMyPhone(q: Db, userId: string, phone: string): Promise<void> {
  await q.query("update app_users set phone = $2 where id = $1", [userId, phone]);
}
