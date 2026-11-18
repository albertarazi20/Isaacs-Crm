import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApproval } from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { approvalForClient, listApprovals } from "@/lib/approvals/queries";
import { canResume, emailsStatus } from "@/lib/approvals/words";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Two follow-ups to "Stop emails for good" and "I sent the first email myself".
 *  1. The approval's step marks (queries.ts, read by EmailSteps and the status line) used to read the outbox only, so a
 *     first email the rep sent by hand showed as not sent. They now read approvals.first_sent_at too.
 *  2. A hard stop is permanent: the row must not offer Resume.
 * Everything about the steps is read back from the DATABASE through the real queries.
 */

let t: TestDb;
let rep: string;
let HOLD = "";
const NOW = new Date("2026-11-16T19:00:00Z");
const SENT = new Date("2026-11-16T18:00:00Z");

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;

let n = 0;
async function merchant(): Promise<string> {
  n += 1;
  return (
    await one<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', $3, $4, 'FL') returning id`,
      [rep, `Shop ${n}`, `30555506${String(n).padStart(2, "0")}`, `owner${n}@shop${n}.test`],
    )
  ).id;
}

async function approve(clientId: string, firstSentAt: Date | null) {
  const { approvalId } = await t.db.withUser(rep, (q) =>
    createApproval(
      q,
      { ...approvalSchema.parse({ clientId, amount: "85000", holdUntil: HOLD }), firstSentAt },
      { userId: rep, now: NOW, appUrl: "https://crm.test" },
    ),
  );
  return approvalId;
}

const outboxStep = (approvalId: string, clientId: string, step: number, status: string) =>
  t.pool.query(
    `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at, not_before)
     values ($1, $2, 'approval', $3, (select email from clients where id = $2), 'Hello', 'Hi', $4,
             case when $4 = 'sent' then '2026-11-15T15:00:00Z'::timestamptz end, '2026-11-15T15:00:00Z')`,
    [rep, clientId, `approval:${approvalId}:step:${step}`, status],
  );

/** Two timestamps as the database reads them: the same instant, whatever zone each was written in. */
const sameInstant = async (a: string, b: string) =>
  (await one<{ same: boolean }>("select $1::timestamptz = $2::timestamptz as same", [a, b])).same;

const listed = async (approvalId: string) =>
  (await t.db.withUser(rep, (q) => listApprovals(q, "open"))).find((r) => r.id === approvalId)!;

beforeAll(async () => {
  t = await createTestDb();
  HOLD = (await one<{ d: string }>("select (current_date + 60)::text as d")).d;
  rep = await insertUser(t.pool, "rep@crm.test", "America/New_York");
});
afterAll(async () => {
  await t.drop();
});

describe("a first email the rep sent by hand shows as sent in the step marks", () => {
  it("lists step 1 as sent at the time the rep gave, with nothing on the outbox", async () => {
    const m = await merchant();
    const id = await approve(m, SENT);
    expect(
      (await one<{ n: number }>("select count(*)::int as n from outbox where client_id = $1", [m]))
        .n,
    ).toBe(0);
    for (const steps of [
      (await listed(id)).steps,
      (await t.db.withUser(rep, (q) => approvalForClient(q, m)))?.steps ?? [],
    ]) {
      expect(steps.map((s) => [s.step, s.status])).toEqual([[1, "sent"]]);
      expect(await sameInstant(steps[0]!.at, SENT.toISOString())).toBe(true);
    }
  });

  it("reads right in the status line: follow-up 1 next, step 1 counted as sent", async () => {
    const m = await merchant();
    const id = await approve(m, SENT);
    // what the engine writes once it has seen the hand-sent first email (delay 3 hours)
    await t.pool.query("update approvals set next_step = 2, next_email_at = $2 where id = $1", [
      id,
      new Date(SENT.getTime() + 3 * 3_600_000).toISOString(),
    ]);
    const row = await listed(id);
    expect(row).toMatchObject({ emails: "running", next_step: 2 });
    expect(row.steps.filter((s) => s.status === "sent").map((s) => s.step)).toEqual([1]);
    const status = emailsStatus(row, (iso) => `at ${iso}`);
    expect(status).toMatchObject({ tone: "good", label: "Emailing" });
    expect(status.detail).toBe(`Follow-up 1 at ${row.next_email_at}.`);
  });

  it("replaces a step 1 on the outbox that never went (cancelled), keeps the later steps, in step order", async () => {
    const m = await merchant();
    const id = await approve(m, SENT);
    await outboxStep(id, m, 1, "cancelled");
    await outboxStep(id, m, 2, "queued");
    const row = await listed(id);
    expect(row.steps.map((s) => [s.step, s.status])).toEqual([
      [1, "sent"],
      [2, "queued"],
    ]);
    const first = row.steps[0]!;
    expect(await sameInstant(first.at, SENT.toISOString())).toBe(true);
  });

  it("does not add a second step 1 when the outbox already has it sent", async () => {
    const m = await merchant();
    const id = await approve(m, SENT);
    await outboxStep(id, m, 1, "sent");
    const row = await listed(id);
    expect(row.steps).toHaveLength(1);
    expect(row.steps[0]).toMatchObject({ step: 1, status: "sent" });
    // the outbox's own time wins (15:00Z on the 15th, not the hand-sent 18:00Z on the 16th)
    expect(await sameInstant(row.steps[0]!.at, "2026-11-15T15:00:00Z")).toBe(true);
  });

  it("an approval with no hand-sent email is unchanged: nothing sent shows as nothing", async () => {
    const m = await merchant();
    const id = await approve(m, null);
    expect((await listed(id)).steps).toEqual([]);
    await outboxStep(id, m, 1, "queued");
    expect((await listed(id)).steps.map((s) => [s.step, s.status])).toEqual([[1, "queued"]]);
  });
});

describe("a hand stop is permanent, so Resume is not offered", () => {
  const base = {
    status: "open",
    emails: "stopped",
    emails_note: "manual_stop",
    halt: null,
  } as const;

  it("canResume is false for a manual stop, whether the note or the live halt says it", () => {
    expect(canResume(base)).toBe(false);
    expect(canResume({ ...base, emails: "running", emails_note: "", halt: "manual_stop" })).toBe(
      false,
    );
    expect(canResume({ ...base, emails: "paused", emails_note: "manual_stop" })).toBe(false);
  });

  it("the stops a person can fix still offer Resume", () => {
    expect(canResume({ ...base, emails_note: "paused" })).toBe(true);
    expect(canResume({ ...base, emails_note: "bounced" })).toBe(true);
    expect(canResume({ ...base, emails_note: "reopened" })).toBe(true);
  });

  it("the status line says it is stopped for good", () => {
    const s = emailsStatus(
      { ...base, next_step: null, next_email_at: null, steps: [], needs_call: false },
      (i) => i,
    );
    expect(s).toMatchObject({ tone: "bad", label: "Emails stopped for good" });
  });
});
