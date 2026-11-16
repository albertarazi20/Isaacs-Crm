import { UserError } from "../data/mutations";
import type { Db } from "../db";
import { chaseLender, type Sender } from "./submit";

/**
 * Chase drafts (S2-6, mode 'draft'): when a lender has been quiet, the nightly chase writes the nudge into an ops
 * alert (kind 'chase_draft') instead of sending it. These are those alerts, as the Review tray shows them, and the
 * way a person sends one. The alert's dedupe key names the lender row: `chase_draft:<submission id>:<chase number>`.
 */
export interface ChaseDraft {
  id: string;
  created_at: string;
  deal_id: string | null;
  deal_number: number | null;
  business_name: string | null;
  funder_name: string | null;
  submission_id: string | null;
  /** The lender row has answered since: the nudge no longer makes sense. */
  moot: boolean;
  to: string;
  subject: string;
  /** The nudge itself, ready to paste. */
  text: string;
  /** Why it was written ("Pearl has been quiet for 2 business days. Send this from the thread:"). */
  why: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lender row a draft is about, from the alert's dedupe key; null for any key that is not ours. */
export function submissionOfChaseKey(key: string | null): string | null {
  const m = /^chase_draft:([^:]+):\d+$/.exec(key ?? "");
  return m && UUID.test(m[1] ?? "") ? (m[1] ?? null) : null;
}

/** Splits the alert body the nightly chase writes: a sentence, `To:`, `Subject:`, a blank line, the nudge. */
export function parseChaseDraft(body: string): {
  why: string;
  to: string;
  subject: string;
  text: string;
} {
  const lines = body.split("\n");
  const toAt = lines.findIndex((l) => l.startsWith("To: "));
  const subjectAt = lines.findIndex((l) => l.startsWith("Subject: "));
  if (toAt < 0 || subjectAt < 0) return { why: "", to: "", subject: "", text: body.trim() };
  const why = lines.slice(0, toAt).join("\n").trim();
  const text = lines
    .slice(subjectAt + 1)
    .join("\n")
    .trim();
  return {
    why,
    to: (lines[toAt] ?? "").slice(4).trim(),
    subject: (lines[subjectAt] ?? "").slice(9).trim(),
    text,
  };
}

/** The person's unread chase drafts, newest first. Runs as the person: RLS keeps it to their own alerts. */
export async function listChaseDrafts(q: Db): Promise<ChaseDraft[]> {
  const { rows } = await q.query<{
    id: string;
    created_at: string;
    deal_id: string | null;
    dedupe_key: string | null;
    body: string;
    deal_number: number | null;
    business_name: string | null;
  }>(
    `select a.id::text as id, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            a.deal_id, a.dedupe_key, a.body, d.number as deal_number, c.business_name
       from user_alerts a
       left join deals d on d.id = a.deal_id
       left join clients c on c.id = a.client_id
      where a.user_id = app.current_user_id() and a.kind = 'chase_draft' and a.read_at is null
      order by a.created_at desc limit 100`,
  );
  const subIds = [
    ...new Set(rows.map((r) => submissionOfChaseKey(r.dedupe_key)).filter((x): x is string => !!x)),
  ];
  const subs = new Map(
    (subIds.length === 0
      ? []
      : (
          await q.query<{ id: string; funder_name: string; status: string }>(
            `select s.id, f.name as funder_name, s.status from submissions s join funders f on f.id = s.funder_id
              where s.id = any($1::uuid[])`,
            [subIds],
          )
        ).rows
    ).map((s) => [s.id, s]),
  );
  return rows.map((r) => {
    const submissionId = submissionOfChaseKey(r.dedupe_key);
    const sub = submissionId ? subs.get(submissionId) : undefined;
    const p = parseChaseDraft(r.body);
    return {
      id: r.id,
      created_at: r.created_at,
      deal_id: r.deal_id,
      deal_number: r.deal_number,
      business_name: r.business_name,
      funder_name: sub?.funder_name ?? null,
      submission_id: submissionId,
      moot: sub !== undefined && sub.status !== "sent",
      ...p,
    };
  });
}

/**
 * Sends a drafted nudge on the lender's own thread, from the deal's rep's mailbox (the same sender the automatic
 * 'send' mode uses), and marks the alert read. The draft already counted as a chase when it was written, so the
 * count is put back after the send: one nudge, one chase.
 */
export async function sendChaseDraft(
  q: Db,
  args: { alertId: string; sendFor: (userId: string) => Sender },
): Promise<{ funderName: string }> {
  const alert = (
    await q.query<{ dedupe_key: string | null; read_at: string | null }>(
      "select dedupe_key, read_at::text as read_at from user_alerts where id = $1::bigint and user_id = app.current_user_id() and kind = 'chase_draft'",
      [args.alertId],
    )
  ).rows[0];
  if (!alert) throw new UserError("That draft is not in your list");
  if (alert.read_at) throw new UserError("That draft was already dealt with");
  const submissionId = submissionOfChaseKey(alert.dedupe_key);
  if (!submissionId) throw new UserError("That draft doesn't name a lender row");
  const row = (
    await q.query<{ status: string; funder_name: string; rep_id: string; rep_name: string }>(
      `select s.status, f.name as funder_name, d.user_id as rep_id, coalesce(nullif(u.name, ''), 'the team') as rep_name
         from submissions s join funders f on f.id = s.funder_id join deals d on d.id = s.deal_id
         join app_users u on u.id = d.user_id where s.id = $1`,
      [submissionId],
    )
  ).rows[0];
  if (!row) throw new UserError("The lender row is gone: dismiss this draft");
  if (row.status !== "sent")
    throw new UserError(`${row.funder_name} has answered since: dismiss this draft`);
  const sent = await chaseLender(q, submissionId, row.rep_name, args.sendFor(row.rep_id));
  if (!sent) throw new UserError(`${row.funder_name} has no submission email on file`);
  await q.query("update submissions set chase_count = greatest(chase_count - 1, 0) where id = $1", [
    submissionId,
  ]);
  await q.query("update user_alerts set read_at = now() where id = $1::bigint", [args.alertId]);
  return { funderName: row.funder_name };
}
