import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import { UserError } from "../data/mutations";
import { mintDownloadLink, openDocument } from "../docs/upload";
import { buildSubmissionPackage } from "../funders/package";
import { getCard } from "../data/queries";
import type { PositionRow, StipRow } from "../data/types";
import type { OutgoingMessage } from "../email/gmail";
import { chaseText, inBusinessHours, quietSince } from "./chase";

/**
 * Send a deal to lenders FROM the CRM: one lender row per funder (the existing create_submissions), then one email
 * per funder from the sender's Gmail with [D-1042] in the subject and our own Message-ID, both kept on the row so
 * the lender's reply is matched exactly. The package body is the plain-text summary plus, per lender, an expiring
 * watermarked link to each clean document on the file (S2-7). When the shop has a deals inbox (S2-5) the email
 * carries it as Reply-To, so the lender's answer lands there whichever desk sent the file.
 */

export interface SubmitInput {
  clientId: string;
  funderIds: string[];
  note?: string;
  senderName: string;
  senderEmail: string;
  /** Who is sending (the links are minted in their name); defaults to the session user of the connection. */
  senderUserId?: string;
  /** Where the document links point (APP_URL). */
  appUrl: string;
  /** Extra lines the manager typed into the email. */
  extraLines?: string;
  /** Send past the shop's lender limit on purpose (logged). */
  force?: boolean;
}

/** Lender links on a submission: a week, ten downloads, the lender's name on every page. */
const LINK_MINUTES = 7 * 24 * 60;
const LINK_DOWNLOADS = 10;
const LINK_KINDS = [
  "signed_application",
  "bank_statement",
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "tax_return",
  "lease_letter",
  "processing_statement",
];

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
  // the shotgun check: how many lenders will have seen this file once these go out
  const limit =
    (await q.query<{ n: number }>("select max_lenders_per_deal as n from shop_settings")).rows[0]
      ?.n ?? 6;
  const already =
    (
      await q.query<{ ids: string[] }>(
        "select coalesce(array_agg(distinct funder_id), '{}') as ids from submissions where deal_id = $1",
        [deal.id],
      )
    ).rows[0]?.ids ?? [];
  const total = new Set([...already, ...input.funderIds]).size;
  if (total > limit && !input.force) {
    throw new UserError(
      `This file would be with ${total} lenders; the shop limit is ${limit}. Every lender who sees it is a backdoor risk — pick fewer, or send anyway on purpose.`,
    );
  }
  if (total > limit) {
    await q.query(
      "insert into activities (user_id, client_id, kind, body) select user_id, id, 'system', $2 from clients where id = $1",
      [
        input.clientId,
        `Shotgun override by ${input.senderName}: ${total} lenders (shop limit ${limit})`,
      ],
    );
  }
  const created = await q.query<{ id: string; funder_id: string }>(
    "select id, funder_id from create_submissions($1, $2::uuid[], null, $3, $4)",
    [input.clientId, input.funderIds, input.note ?? "", input.force ?? false],
  );
  const shop = (
    await q.query<{ reply_to: string }>("select deals_inbox_address as reply_to from shop_settings")
  ).rows[0];
  const replyTo = shop?.reply_to.trim() ?? "";
  const senderUserId =
    input.senderUserId ??
    (await q.query<{ id: string | null }>("select app.current_user_id() as id")).rows[0]?.id ??
    null;
  const appUrl = input.appUrl.replace(/\/+$/, "");
  // the clean documents on the file, each one a link per lender below
  const documents = (
    await q.query<{ id: string; label: string }>(
      `select d.id, app.document_label(d.kind, d.period) as label
         from documents d
        where d.client_id = $1 and d.deleted_at is null and d.scan_status = 'clean' and d.kind = any($2::text[])
        order by d.kind, d.period, d.created_at`,
      [input.clientId, LINK_KINDS],
    )
  ).rows;
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
      const links: { label: string; url: string }[] = [];
      if (senderUserId) {
        for (const doc of documents) {
          const link = await mintDownloadLink(q, {
            documentId: doc.id,
            createdBy: senderUserId,
            lenderId: row.funder_id,
            watermark: `Prepared for ${f.name}`,
            minutes: LINK_MINUTES,
            maxDownloads: LINK_DOWNLOADS,
          });
          links.push({ label: doc.label, url: `${appUrl}/d/${link.token}` });
        }
      }
      const pkg = buildSubmissionPackage({
        card,
        positions,
        stips,
        senderName: input.senderName,
        funderContact: f.contact_name,
        documents: links,
        linksGoodFor: "7 days",
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
        ...(replyTo ? { headers: { "Reply-To": replyTo } } : {}),
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
    text: chaseText({
      funderName: row.fname,
      businessName: row.business,
      dealNumber: row.number,
      senderName,
    }),
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
 * Ops sends documents to a lender in one click: an expiring, watermarked link per file, in one email on the lender's
 * own submission thread, from the sender's Gmail. A lender waiting on stips goes back to "sent" — the ball is theirs.
 */
export async function forwardToLender(
  q: Db,
  args: {
    submissionId: string;
    documentIds: string[];
    appUrl: string;
    senderName: string;
    note?: string;
    createdBy: string;
    send: Sender;
  },
): Promise<{ sent: boolean; links: number }> {
  if (args.documentIds.length === 0) throw new UserError("Pick at least one document");
  const row = (
    await q.query<{
      to: string;
      fname: string;
      funder_id: string;
      thread: string | null;
      msg: string | null;
      number: number;
      business: string;
      client_id: string;
      status: string;
    }>(
      `select f.submission_email as to, f.name as fname, f.id as funder_id, s.gmail_thread_id as thread, s.gmail_message_id as msg,
              d.number, c.business_name as business, s.client_id, s.status
         from submissions s join funders f on f.id = s.funder_id join deals d on d.id = s.deal_id join clients c on c.id = s.client_id
        where s.id = $1`,
      [args.submissionId],
    )
  ).rows[0];
  if (!row) throw new UserError("Submission not found");
  if (!row.to) throw new UserError("This lender has no submission email on file");
  const lines: string[] = [];
  for (const documentId of args.documentIds) {
    const doc = await openDocument(q, documentId); // visible, and clean — nothing unscanned leaves the shop
    const link = await mintDownloadLink(q, {
      documentId,
      createdBy: args.createdBy,
      lenderId: row.funder_id,
      watermark: `Prepared for ${row.fname}`,
      minutes: 7 * 24 * 60,
      maxDownloads: 10,
    });
    const label =
      (
        await q.query<{ l: string }>(
          "select app.document_label(kind, period) as l from documents where id = $1",
          [documentId],
        )
      ).rows[0]?.l ?? doc.filename;
    lines.push(`${label}: ${args.appUrl}/d/${link.token}`);
  }
  const text = [
    `Hi ${row.fname} team,`,
    "",
    `The documents you asked for on ${row.business} (D-${row.number}):`,
    "",
    ...lines,
    "",
    "Each link is good for 7 days and the copies carry your name.",
    ...(args.note?.trim() ? ["", args.note.trim()] : []),
    "",
    "Thanks,",
    args.senderName,
  ].join("\n");
  await args.send({
    to: row.to,
    subject: `Re: [D-${row.number}] ${row.business} — documents`,
    text,
    threadId: row.thread ?? undefined,
    inReplyTo: row.msg ?? undefined,
    references: row.msg ? [row.msg] : undefined,
  });
  if (row.status === "stips_requested") {
    await q.query("select set_submission_status($1, 'sent', null, 'stips sent')", [
      args.submissionId,
    ]);
  }
  await q.query(
    "insert into activities (user_id, client_id, kind, body) select user_id, client_id, 'system', $2 from submissions where id = $1",
    [
      args.submissionId,
      `Sent ${lines.length} document${lines.length === 1 ? "" : "s"} to ${row.fname}`,
    ],
  );
  return { sent: true, links: lines.length };
}

export interface ChaseSummary {
  /** Nudges sent from the rep's mailbox. */
  chased: number;
  /** Nudges drafted into an ops alert (mode 'draft'). */
  drafted: number;
  /** Lender rows that were due but got nothing (no address, a disconnected mailbox, outside business hours). */
  skipped: number;
  /** Rows that went to no_response after the final chase had its window. */
  flipped: number;
}

/**
 * Lenders quiet past the shop's chase window get a nudge on the same thread, from the deal's own rep's Gmail
 * (S2-6). The window counts business days (Mon–Fri, or every day when the shop sends on weekends) and a nudge only
 * goes out in business hours in the rep's zone. Settings decide the mode: 'send' emails it; 'draft' writes the nudge
 * into an ops alert (kind 'chase_draft') for a person to send; 'off' does nothing. Once the last chase has had a
 * full window with no answer, the lender row flips to no_response with a timeline line.
 */
export async function autoChase(
  q: Db,
  args: { sendFor: (userId: string) => Sender; now?: Date },
): Promise<ChaseSummary> {
  const out: ChaseSummary = { chased: 0, drafted: 0, skipped: 0, flipped: 0 };
  const settings = (
    await q.query<{ days: number; mode: string; max: number; weekends: boolean }>(
      "select lender_chase_days as days, lender_chase_mode as mode, lender_chase_max as max, send_on_weekends as weekends from shop_settings",
    )
  ).rows[0];
  if (!settings || settings.mode === "off") return out;
  const now = args.now ?? new Date();
  const rules = { days: settings.days, weekends: settings.weekends };
  const { rows } = await q.query<{
    id: string;
    user_id: string;
    rep_name: string;
    timezone: string;
    chase_count: number;
    quiet_since: string;
    fname: string;
    business: string;
    number: number;
    deal_id: string;
    client_id: string;
    ops_owner: string | null;
    to: string;
  }>(
    `select s.id, d.user_id, coalesce(nullif(u.name, ''), 'the team') as rep_name, u.timezone, s.chase_count,
            coalesce(s.last_chased_at, s.created_at)::text as quiet_since, f.name as fname, c.business_name as business,
            d.number, d.id as deal_id, s.client_id, d.ops_owner, f.submission_email as to
       from submissions s
       join deals d on d.id = s.deal_id
       join app_users u on u.id = d.user_id
       join funders f on f.id = s.funder_id
       join clients c on c.id = s.client_id
      where s.status = 'sent' and d.outcome = 'open' and s.sent_via = 'crm'
        and not exists (select 1 from trashed_clients tc where tc.client_id = s.client_id)
      order by coalesce(s.last_chased_at, s.created_at)`,
  );
  for (const r of rows) {
    const cutoff = quietSince(now, rules, r.timezone);
    if (new Date(r.quiet_since) >= cutoff) continue; // not quiet for a whole window yet
    if (r.chase_count >= settings.max) {
      // the last chase had its window: the lender is not answering
      await q.query("select set_submission_status($1, 'no_response', null, $2)", [
        r.id,
        `no answer after ${r.chase_count} ${r.chase_count === 1 ? "chase" : "chases"}`,
      ]);
      out.flipped += 1;
      continue;
    }
    if (!inBusinessHours(now, r.timezone, settings.weekends)) {
      out.skipped += 1;
      continue;
    }
    if (settings.mode === "draft") {
      const text = chaseText({
        funderName: r.fname,
        businessName: r.business,
        dealNumber: r.number,
        senderName: r.rep_name,
      });
      // ops carry the nudge: the deal's ops owner, else every ops user, else the managers
      await q.query(
        `insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
         select x.id, 'chase_draft', $1, $2, $3, $4, $5, $6 from (
           select id from app_users where id = $7::uuid and active
           union all
           select id from app_users where $7::uuid is null and active and role = 'ops'
           union all
           select id from app_users where $7::uuid is null and active and role = 'manager'
              and not exists (select 1 from app_users o where o.active and o.role = 'ops')
         ) x on conflict do nothing`,
        [
          r.client_id,
          r.deal_id,
          `Chase ${r.fname} on D-${r.number} ${r.business}`,
          `${r.fname} has been quiet for ${settings.days} business days. Send this from the thread:\n\nTo: ${r.to}\nSubject: Re: [D-${r.number}] ${r.business}\n\n${text}`,
          `/deals/${r.deal_id}`,
          `chase_draft:${r.id}:${r.chase_count + 1}`,
          r.ops_owner,
        ],
      );
      await q.query(
        "update submissions set last_chased_at = now(), chase_count = chase_count + 1 where id = $1",
        [r.id],
      );
      await q.query(
        "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
        [r.user_id, r.client_id, `Chase drafted for ops: ${r.fname}`],
      );
      out.drafted += 1;
      continue;
    }
    try {
      if (await chaseLender(q, r.id, r.rep_name, args.sendFor(r.user_id))) out.chased += 1;
      else out.skipped += 1;
    } catch {
      out.skipped += 1; // a disconnected Gmail is the rep's problem to fix in Settings, not a reason to stop the loop
    }
  }
  return out;
}
