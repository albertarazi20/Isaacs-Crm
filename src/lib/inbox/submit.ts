import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import { buildSubmissionPackage } from "../funders/package";
import { getCard } from "../data/queries";
import type { PositionRow, StipRow } from "../data/types";
import type { OutgoingMessage } from "../email/gmail";

/**
 * Send a deal to lenders FROM the CRM: one lender row per funder (the existing create_submissions), then one email
 * per funder from the sender's Gmail with [D-1042] in the subject and our own Message-ID, both kept on the row so
 * the lender's reply is matched exactly. The package body is the existing plain-text summary.
 */

export interface SubmitInput {
  clientId: string;
  funderIds: string[];
  note?: string;
  senderName: string;
  senderEmail: string;
  /** Extra lines the manager typed into the email. */
  extraLines?: string;
}

export interface SubmitResult {
  submissions: { submissionId: string; funderId: string; funderName: string; to: string | null }[];
  dealNumber: number;
}

export type Sender = (m: OutgoingMessage) => Promise<{ id: string; threadId: string }>;

function makeMessageId(domain: string): string {
  return `<${randomBytes(12).toString("hex")}.${Date.now()}@${domain || "crm.local"}>`;
}

export async function submitToLenders(
  q: Db,
  input: SubmitInput,
  send: Sender,
): Promise<SubmitResult> {
  const card = await getCard(q, input.clientId);
  if (!card) throw new Error("client not found");
  const deal = (
    await q.query<{ id: string; number: number }>(
      "select id, number from deals where client_id = $1 and outcome = 'open' order by created_at desc limit 1",
      [input.clientId],
    )
  ).rows[0];
  if (!deal) throw new Error("This merchant has no open deal — submit it to ops first");
  const created = await q.query<{ id: string; funder_id: string }>(
    "select id, funder_id from create_submissions($1, $2::uuid[], null, $3)",
    [input.clientId, input.funderIds, input.note ?? ""],
  );
  const positions = (
    await q.query<{ j: PositionRow }>(
      "select to_jsonb(p) as j from positions p where p.client_id = $1 order by p.position_no",
      [input.clientId],
    )
  ).rows.map((r) => r.j);
  const stips = (
    await q.query<{ j: StipRow }>("select to_jsonb(s) as j from stips s where s.client_id = $1", [
      input.clientId,
    ])
  ).rows.map((r) => r.j);
  const out: SubmitResult = { submissions: [], dealNumber: deal.number };
  for (const row of created.rows) {
    const f = (
      await q.query<{ name: string; submission_email: string; contact_name: string }>(
        "select name, submission_email, contact_name from funders where id = $1",
        [row.funder_id],
      )
    ).rows[0];
    const to = f?.submission_email.trim() || null;
    await q.query(
      "update submissions set sent_via = $2, deal_id = coalesce(deal_id, $3) where id = $1",
      [row.id, to ? "crm" : "manual", deal.id],
    );
    if (f && to) {
      const pkg = buildSubmissionPackage({
        card,
        positions,
        stips,
        senderName: input.senderName,
        funderContact: f.contact_name,
      });
      const messageId = makeMessageId(input.senderEmail.split("@")[1] ?? "");
      const body = input.extraLines?.trim()
        ? `${input.extraLines.trim()}\n\n${pkg.body}`
        : pkg.body;
      const sent = await send({
        to,
        subject: `[D-${deal.number}] ${pkg.subject}`,
        text: body,
        messageId,
      });
      await q.query(
        "update submissions set gmail_thread_id = $2, gmail_message_id = $3 where id = $1",
        [row.id, sent.threadId, messageId],
      );
    }
    out.submissions.push({
      submissionId: row.id,
      funderId: row.funder_id,
      funderName: f?.name ?? "",
      to,
    });
  }
  await q.query("select mark_deal_sent($1)", [deal.id]);
  return out;
}

/** A chase on the same thread: "any update on [D-1042] Mike's Pizza?" Keeps the thread so the reply matches. */
export async function chaseLender(
  q: Db,
  submissionId: string,
  senderName: string,
  send: Sender,
): Promise<boolean> {
  const row = (
    await q.query<{
      to: string;
      thread: string | null;
      msg: string | null;
      number: number;
      business: string;
      fname: string;
      subject: string | null;
    }>(
      `select f.submission_email as to, s.gmail_thread_id as thread, s.gmail_message_id as msg, d.number, c.business_name as business, f.name as fname,
              (select e.subject from inbound_emails e where e.submission_id = s.id order by e.received_at desc limit 1) as subject
         from submissions s join funders f on f.id = s.funder_id join deals d on d.id = s.deal_id join clients c on c.id = s.client_id
        where s.id = $1`,
      [submissionId],
    )
  ).rows[0];
  if (!row || !row.to) return false;
  const subject = `Re: [D-${row.number}] ${row.business}`;
  await send({
    to: row.to,
    subject,
    text: `Hi ${row.fname} team,\n\nAny update on ${row.business} (D-${row.number})? Happy to send anything else you need.\n\nThanks,\n${senderName}`,
    threadId: row.thread ?? undefined,
    inReplyTo: row.msg ?? undefined,
    references: row.msg ? [row.msg] : undefined,
  });
  await q.query(
    "update submissions set last_chased_at = now(), chase_count = chase_count + 1 where id = $1",
    [submissionId],
  );
  await q.query(
    "insert into activities (user_id, client_id, kind, body) select user_id, client_id, 'system', $2 from submissions where id = $1",
    [submissionId, `Chased ${row.fname} for an answer`],
  );
  return true;
}

/**
 * Lenders quiet past the shop's chase window get a nudge on the same thread, from the deal's own rep's Gmail.
 * Settings decide the window and the cap; 'off' sends nothing. Returns how many went out.
 */
export async function autoChase(
  q: Db,
  args: { sendFor: (userId: string) => Sender; now?: Date },
): Promise<{ chased: number; skipped: number }> {
  const settings = (
    await q.query<{ days: number; mode: string; max: number }>(
      "select lender_chase_days as days, lender_chase_mode as mode, lender_chase_max as max from shop_settings",
    )
  ).rows[0];
  if (!settings || settings.mode === "off") return { chased: 0, skipped: 0 };
  const { rows } = await q.query<{ id: string; user_id: string; rep_name: string }>(
    `select s.id, d.user_id, coalesce(nullif(u.name, ''), 'the team') as rep_name
       from submissions s join deals d on d.id = s.deal_id join app_users u on u.id = d.user_id
      where s.status = 'sent' and d.outcome = 'open' and s.sent_via = 'crm' and s.chase_count < $2
        and coalesce(s.last_chased_at, s.created_at) < $3::timestamptz - ($1 || ' days')::interval
        and not exists (select 1 from trashed_clients tc where tc.client_id = s.client_id)
      order by coalesce(s.last_chased_at, s.created_at)`,
    [String(settings.days), settings.max, (args.now ?? new Date()).toISOString()],
  );
  let chased = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      if (await chaseLender(q, r.id, r.rep_name, args.sendFor(r.user_id))) chased += 1;
      else skipped += 1;
    } catch {
      skipped += 1; // a disconnected Gmail is the rep's problem to fix in Settings, not a reason to stop the loop
    }
  }
  return { chased, skipped };
}
