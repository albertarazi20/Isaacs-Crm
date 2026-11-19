import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopEmailsForGood } from "@/lib/approvals/hardStop";
import {
  approvalWithFirstSchema,
  checkSentAt,
  parseSentAt,
  recordFirstSchema,
} from "@/lib/approvals/manualFirst";
import {
  createApproval,
  markPitched,
  pauseApprovalEmails,
  recordFirstEmailSent,
  resumeApprovalEmails,
  saveApprovalDesign,
  setApprovalDelay,
} from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { listApprovals } from "@/lib/approvals/queries";
import { emailsStatus } from "@/lib/approvals/words";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { advanceApprovalNow, runApprovalEmails } from "@/lib/system/approvals";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * "I sent the first email myself": the CRM never sends approval email 1. The rep sends it from their own mailbox and
 * tells the CRM when. Step 1 is recorded as sent at that time with NOTHING on the outbox, and the engine schedules
 * follow-up 1 its delay (Settings) after that moment, then carries on by itself until a reply, a pitch, a close, a
 * pause, the hold date, an unsubscribe, a bounce, do-not-contact or a hard stop. Until the rep has recorded theirs the
 * approval is held, the engine queues nothing and Resume is refused. Every claim is read back from the DATABASE.
 */

const design = (
  title: string,
  extra = "",
) => `<!DOCTYPE html><html><head><title>${title}</title></head>
<body><h1>Congrats, {{first_name}}.</h1><p>{{business_name}} is approved for {{offer_amount}}.</p>${extra}
<p>{{rep_name}} {{rep_phone}} {{rep_email}}</p>
<p>1 Test Street, Testville, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`;

let t: TestDb;
let rep: string;
let other: string;
let boss: string;
let HOLD = "";
const APP = "https://crm.test";
const H = 3_600_000;
// Monday 16 Nov 2026, 2pm in Florida: inside the 9am-6pm weekday window, and so is every moment used below
const NOW = new Date("2026-11-16T19:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * H);
// the delays set in Settings for the three follow-ups (hours after the email before)
const DELAYS = { 2: 3, 3: 20, 4: 26 } as const;

const ctx = (userId: string, now = NOW) => ({ userId, now, appUrl: APP });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;
const many = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];

const sent: { to: string; subject: string }[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (sent.push({ to: m.to, subject: m.subject }), `g_${sent.length}`),
  resend: async (m) => (sent.push({ to: m.to, subject: m.subject }), `r_${sent.length}`),
};
const drain = (now: Date) => drainOutbox({ db: t.db, deliver, now, appUrl: APP });
const run = (now: Date) => runApprovalEmails({ db: t.db, appUrl: APP, now });

let n = 0;
async function merchant(owner = rep): Promise<string> {
  n += 1;
  return (
    await one<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', $3, $4, 'FL') returning id`,
      [owner, `Shop ${n}`, `30555504${String(n).padStart(2, "0")}`, `owner${n}@shop${n}.test`],
    )
  ).id;
}
const outbox = (clientId: string) =>
  many<{
    source: string;
    lane: string;
    status: string;
    skip_reason: string | null;
    sent_at: Date | null;
    not_before: Date;
    subject: string;
  }>(
    "select source, lane, status, skip_reason, sent_at, not_before, subject from outbox where client_id = $1 order by created_at",
    [clientId],
  );
const approvalRow = (id: string) =>
  one<{
    status: string;
    emails: string;
    emails_note: string;
    next_step: number | null;
    next_email_at: Date | null;
    first_sent_at: Date | null;
    first_sent_by: string | null;
    emails_since: Date;
  }>(
    "select status, emails, emails_note, next_step, next_email_at, first_sent_at, first_sent_by, emails_since from approvals where id = $1",
    [id],
  );

/** The form's own path: parse the input, create the approval under the rep's row security, move it along. */
async function mark(
  clientId: string,
  input: Record<string, unknown> = {},
  userId = rep,
  now = NOW,
) {
  const parsed = approvalWithFirstSchema.parse({
    clientId,
    amount: "85000",
    holdUntil: HOLD,
    ...input,
  });
  const firstSentAt = parsed.firstEmail === "mine" ? (parseSentAt(parsed.sentAt) ?? now) : null;
  const made = await t.db.withUser(userId, (q) =>
    createApproval(q, { ...parsed, firstSentAt }, ctx(userId, now)),
  );
  const first = made.started
    ? await advanceApprovalNow(t.db, made.approvalId, ctx(userId, now))
    : null;
  return { ...made, first };
}
const mine = (clientId: string, sentAt: Date = NOW, more: Record<string, unknown> = {}) =>
  mark(clientId, { firstEmail: "mine", sentAt: sentAt.toISOString(), ...more });

beforeAll(async () => {
  t = await createTestDb();
  HOLD = (await one<{ d: string }>("select (current_date + 60)::text as d")).d;
  rep = await insertUser(t.pool, "rep@crm.test", "America/New_York");
  other = await insertUser(t.pool, "other@crm.test", "America/New_York");
  boss = await insertUser(t.pool, "boss@crm.test");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
  await t.pool.query(
    "update app_users set name = 'sam rep', phone = '(561) 555-0142' where id = $1",
    [rep],
  );
  await t.pool.query("update app_users set phone = '(561) 555-0143' where id = $1", [other]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep-gmail@crm.test', 'enc', 'send', 'ok')",
    [rep],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Test Street, Testville, FL 33487'",
  );
  await t.db.withUser(boss, async (q) => {
    await saveApprovalDesign(
      q,
      { step: 1, subject: "Congrats {{first_name}}", html: design("x"), fileName: "" },
      boss,
    );
    for (const step of [2, 3])
      await saveApprovalDesign(
        q,
        { step, subject: `Follow-up ${step - 1}, {{first_name}}`, html: design("x"), fileName: "" },
        boss,
      );
    await saveApprovalDesign(
      q,
      {
        step: 4,
        subject: "Last call",
        html: design("x", "<p>I can hold it until {{offer_expiry}}.</p>"),
        fileName: "",
      },
      boss,
    );
    for (const [step, hours] of Object.entries(DELAYS))
      await setApprovalDelay(q, Number(step), hours, boss);
  });
});
afterAll(async () => {
  await t.drop();
});

describe("the form's input and the time the rep gives", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("defaults to 'later' (the rep records it when sent), and reads 'I sent it myself' with an optional time", () => {
    expect(approvalWithFirstSchema.parse({ clientId: id, amount: "50k" })).toMatchObject({
      firstEmail: "later",
      sentAt: null,
    });
    expect(
      approvalWithFirstSchema.parse({ clientId: id, amount: "50k", firstEmail: "later" }),
    ).toMatchObject({ firstEmail: "later", sentAt: null });
    // the system no longer sends it: "auto" is not a choice any more
    expect(() =>
      approvalWithFirstSchema.parse({ clientId: id, amount: "50k", firstEmail: "auto" }),
    ).toThrow();
    expect(
      approvalWithFirstSchema.parse({
        clientId: id,
        amount: "50k",
        firstEmail: "mine",
        sentAt: "2026-11-16T18:30:00.000Z",
      }),
    ).toMatchObject({ firstEmail: "mine", sentAt: "2026-11-16T18:30:00.000Z" });
    expect(() =>
      approvalWithFirstSchema.parse({
        clientId: id,
        amount: "50k",
        firstEmail: "mine",
        sentAt: "yesterday",
      }),
    ).toThrow(/date and time/);
    expect(() =>
      approvalWithFirstSchema.parse({ clientId: id, amount: "50k", firstEmail: "soon" }),
    ).toThrow();
    expect(recordFirstSchema.parse({ approvalId: id })).toEqual({ approvalId: id, sentAt: null });
  });

  it("accepts now and the recent past; refuses the future and anything older than 30 days", () => {
    expect(checkSentAt(null, NOW)).toEqual(NOW);
    expect(checkSentAt(at(-2), NOW)).toEqual(at(-2));
    // a few minutes of clock slack: counted as now, never later than now
    expect(checkSentAt(new Date(NOW.getTime() + 2 * 60_000), NOW)).toEqual(NOW);
    expect(() => checkSentAt(at(1), NOW)).toThrow(/still ahead/);
    expect(() => checkSentAt(at(-31 * 24), NOW)).toThrow(/last 30 days/);
    expect(() => checkSentAt(new Date("nope"), NOW)).toThrow(/date and time/);
  });
});

describe("'I sent it myself' when marking a merchant approved", () => {
  let m: string;
  let approvalId: string;

  it("records step 1 as sent at that time and puts NOTHING on the outbox", async () => {
    m = await merchant();
    const sentAt = at(-1); // sent an hour ago from the rep's own mail
    const res = await mine(m, sentAt);
    approvalId = res.approvalId;
    expect(res).toMatchObject({ started: true, emailsStopped: false });

    expect(await outbox(m)).toEqual([]);
    expect(await one("select count(*)::int as n from outbox where client_id = $1", [m])).toEqual({
      n: 0,
    });

    const a = await approvalRow(approvalId);
    expect(a).toMatchObject({
      status: "open",
      emails: "running",
      emails_note: "",
      first_sent_by: rep,
    });
    expect(a.first_sent_at?.toISOString()).toBe(sentAt.toISOString());
    // replies are counted from the moment the rep sent it
    expect(a.emails_since.toISOString()).toBe(sentAt.toISOString());

    // the timeline says so, dated at the moment it was sent
    const lines = await many<{ body: string; at: Date }>(
      "select body, occurred_at as at from activities where client_id = $1 and body like 'First approval email%'",
      [m],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toBe("First approval email sent by hand");
    expect(lines[0]!.at.toISOString()).toBe(sentAt.toISOString());
    expect(
      await many<{ body: string }>(
        "select body from activities where client_id = $1 and body like 'Approved:%'",
        [m],
      ),
    ).toHaveLength(1);
  });

  it("schedules follow-up 1 its delay after the time given, per Settings, and still queues nothing", async () => {
    const a = await approvalRow(approvalId);
    expect(a.next_step).toBe(2);
    // sent at 1pm Florida, delay 3 hours: 4pm, inside the window
    expect(a.next_email_at?.toISOString()).toBe(at(-1 + DELAYS[2]).toISOString());
    expect(await outbox(m)).toEqual([]);
    await run(at(0.5));
    expect(await outbox(m)).toEqual([]);

    // the list's status line reads it right: the emails are going, with follow-up 1 next
    const row = (await t.db.withUser(rep, (q) => listApprovals(q, "open"))).find(
      (r) => r.id === approvalId,
    )!;
    expect(row).toMatchObject({ emails: "running", halt: null, next_step: 2 });
    const status = emailsStatus(row, (iso) => iso);
    expect(status).toMatchObject({ tone: "good", label: "Emailing" });
    expect(status.detail).toMatch(/^Follow-up 1 /);
  });

  it("the engine then sends follow-ups 1, 2 and 3 in order, each its own delay after the one before was sent", async () => {
    sent.length = 0;
    const due2 = at(-1 + DELAYS[2]);
    // a minute early: still nothing
    await run(new Date(due2.getTime() - 60_000));
    expect(await outbox(m)).toEqual([]);

    // follow-up 1 is due: queued, then sent when the worker runs (a few minutes later)
    await run(due2);
    let rows = await outbox(m);
    expect(rows.map((r) => r.source)).toEqual([`approval:${approvalId}:step:2`]);
    expect(rows[0]).toMatchObject({
      lane: "approval",
      status: "queued",
      subject: "Follow-up 1, Rosa",
    });
    const sent2 = new Date(due2.getTime() + 5 * 60_000);
    await drain(sent2);
    rows = await outbox(m);
    expect(rows[0]).toMatchObject({ status: "sent" });
    expect(rows[0]!.sent_at?.toISOString()).toBe(sent2.toISOString());
    expect(sent.map((s) => s.subject)).toEqual(["Follow-up 1, Rosa"]);

    // follow-up 2 is 20 hours after follow-up 1 WENT (not after it was queued)
    const due3 = new Date(sent2.getTime() + DELAYS[3] * H);
    await run(new Date(due3.getTime() - 60_000));
    expect(await outbox(m)).toHaveLength(1);
    expect((await approvalRow(approvalId)).next_email_at?.toISOString()).toBe(due3.toISOString());
    await run(due3);
    await drain(due3);
    rows = await outbox(m);
    expect(rows.map((r) => [r.source, r.status])).toEqual([
      [`approval:${approvalId}:step:2`, "sent"],
      [`approval:${approvalId}:step:3`, "sent"],
    ]);

    // follow-up 3, with the hold date filled in
    const due4 = new Date(due3.getTime() + DELAYS[4] * H);
    await run(due4);
    await drain(due4);
    rows = await outbox(m);
    expect(rows.map((r) => r.source)).toEqual([
      `approval:${approvalId}:step:2`,
      `approval:${approvalId}:step:3`,
      `approval:${approvalId}:step:4`,
    ]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    // three emails left the system: the first was the rep's own
    expect(sent.map((s) => s.subject)).toEqual([
      "Follow-up 1, Rosa",
      "Follow-up 2, Rosa",
      "Last call",
    ]);

    // every email has gone: the sequence is finished
    await run(new Date(due4.getTime() + 60_000));
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "finished", next_step: null });
    expect(await outbox(m)).toHaveLength(3);
  });
});

describe("the follow-ups stop on every stop condition", () => {
  const stopCases: {
    name: string;
    note: string;
    apply: (m: string, approvalId: string) => Promise<unknown>;
  }[] = [
    {
      name: "the merchant replies",
      note: "replied",
      apply: (m) =>
        t.pool.query(
          `insert into inbound_emails (mailbox_user_id, gmail_id, from_address, subject, received_at, client_id, kind)
           values ($1, $2, 'owner@shop.test', 'Re: approved', now(), $3, 'merchant')`,
          [rep, `g-${m}`, m],
        ),
    },
    {
      name: "the rep marks it pitched",
      note: "pitched",
      apply: (_m, a) => t.db.withUser(rep, (q) => markPitched(q, a, ctx(rep))),
    },
    {
      name: "the hold date passes",
      note: "expired",
      apply: (_m, a) =>
        t.pool.query("update approvals set hold_until = current_date - 2 where id = $1", [a]),
    },
    {
      name: "the merchant unsubscribes",
      note: "opted_out",
      apply: (m) => t.pool.query("select opt_out($1, 'email', 'unsubscribe', 'page')", [m]),
    },
    {
      name: "the address bounces",
      note: "bounced",
      apply: async (m) => {
        // what the delivery webhook does: the address goes on the list as a hard bounce and the card is marked
        await t.pool.query(
          "select app.suppress('email', app.suppression_key(email), lower(email), 'hard_bounce', 'mailbox full', id, null) from clients where id = $1",
          [m],
        );
        await t.pool.query("update clients set email_bounced_at = now() where id = $1", [m]);
      },
    },
    {
      name: "the merchant is marked do-not-contact",
      note: "dnc",
      apply: (m) => t.pool.query("update clients set contact_status = 'dnc' where id = $1", [m]),
    },
    {
      name: "someone presses Stop emails for good",
      note: "manual_stop",
      apply: (m) => stopEmailsForGood(t.db, { userId: rep, email: "rep@crm.test" }, m),
    },
  ];

  for (const c of stopCases)
    it(`${c.name}: follow-up 1 never goes (${c.note})`, async () => {
      const m = await merchant();
      const { approvalId } = await mine(m, NOW);
      expect((await approvalRow(approvalId)).next_step).toBe(2);
      await c.apply(m, approvalId);
      // the follow-up's moment, and a day later
      await run(at(DELAYS[2]));
      await run(at(30));
      await drain(at(31));
      expect(await outbox(m)).toEqual([]);
      const a = await approvalRow(approvalId);
      expect(a.emails).not.toBe("running");
      expect(a.emails_note).toBe(c.note);
    });

  it("a pause holds the follow-up, and Resume (a person pressing it) sends the overdue one at once", async () => {
    const m = await merchant();
    const { approvalId } = await mine(m, NOW);
    await t.db.withUser(rep, (q) => pauseApprovalEmails(q, approvalId));
    expect(await approvalRow(approvalId)).toMatchObject({
      emails: "paused",
      emails_note: "paused",
      next_step: null,
      first_sent_by: rep,
    });
    // the follow-up's time comes and goes while paused: nothing
    await run(at(DELAYS[2] + 1));
    await run(at(30));
    expect(await outbox(m)).toEqual([]);
    // Resume the next morning-ish (Tuesday noon Florida): the first email still counts as sent, so follow-up 1 is next
    await t.db.withUser(rep, (q) => resumeApprovalEmails(q, approvalId));
    const r = await advanceApprovalNow(t.db, approvalId, ctx(rep, at(21)));
    expect(r).toMatchObject({ kind: "queued", step: 2 });
    expect((await outbox(m)).map((x) => x.source)).toEqual([`approval:${approvalId}:step:2`]);
  });
});

describe("'I already sent the first email' on an approval created with the emails held", () => {
  it("records it, starts the follow-ups on their own schedule, and puts nothing on the outbox", async () => {
    const m = await merchant();
    const held = await mark(m, { firstEmail: "later" });
    expect(held).toMatchObject({ started: false });
    expect(await approvalRow(held.approvalId)).toMatchObject({
      emails: "paused",
      emails_note: "held",
      first_sent_at: null,
    });

    const sentAt = at(-2);
    const rec = await t.db.withUser(rep, (q) =>
      recordFirstEmailSent(q, held.approvalId, sentAt, ctx(rep)),
    );
    expect(rec).toEqual({ at: sentAt.toISOString() });
    const next = await advanceApprovalNow(t.db, held.approvalId, ctx(rep));
    expect(next).toMatchObject({ kind: "waiting", step: 2 });

    const a = await approvalRow(held.approvalId);
    expect(a).toMatchObject({
      emails: "running",
      emails_note: "",
      next_step: 2,
      first_sent_by: rep,
    });
    expect(a.first_sent_at?.toISOString()).toBe(sentAt.toISOString());
    // sent two hours ago, delay 3 hours: due in one hour
    expect(a.next_email_at?.toISOString()).toBe(at(1).toISOString());
    expect(await outbox(m)).toEqual([]);
    expect(
      await many(
        "select body from activities where client_id = $1 and body = 'First approval email sent by hand'",
        [m],
      ),
    ).toHaveLength(1);

    await run(at(1));
    expect((await outbox(m)).map((r) => r.source)).toEqual([`approval:${held.approvalId}:step:2`]);
  });

  it("with no time given, now is recorded; the second time, or on an approval already running, is refused", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m, { firstEmail: "later" });
    await t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, null, ctx(rep)));
    expect((await approvalRow(approvalId)).first_sent_at?.toISOString()).toBe(NOW.toISOString());
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, null, ctx(rep))),
    ).rejects.toThrow(/already recorded/);

    // an approval that is not held (here a row pushed to running with no first email, as a stale one could be) is not
    // for this either, and nothing is recorded
    const m2 = await merchant();
    const odd = await mark(m2);
    await t.pool.query("update approvals set emails = 'running', emails_note = '' where id = $1", [
      odd.approvalId,
    ]);
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, odd.approvalId, null, ctx(rep))),
    ).rejects.toThrow(/created with the emails held/);
    expect(await approvalRow(odd.approvalId)).toMatchObject({
      emails: "running",
      first_sent_at: null,
      first_sent_by: null,
    });
    // one that already started with the rep's own first email is refused too: it is recorded
    const m3 = await merchant();
    const started = await mine(m3, at(-1));
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, started.approvalId, null, ctx(rep))),
    ).rejects.toThrow(/already recorded/);
    expect((await approvalRow(started.approvalId)).first_sent_at?.toISOString()).toBe(
      at(-1).toISOString(),
    );
  });

  it("refuses a time in the future or more than 30 days back, and changes nothing", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m, { firstEmail: "later" });
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, at(2), ctx(rep))),
    ).rejects.toThrow(/still ahead/);
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, at(-40 * 24), ctx(rep))),
    ).rejects.toThrow(/last 30 days/);
    expect(await approvalRow(approvalId)).toMatchObject({
      emails: "paused",
      emails_note: "held",
      first_sent_at: null,
    });
  });

  it("a rep cannot record it on another rep's approval; a manager can", async () => {
    const theirs = await merchant(other);
    const { approvalId } = await mark(theirs, { firstEmail: "later" }, other);
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, null, ctx(rep))),
    ).rejects.toThrow(/no longer exists/);
    expect((await approvalRow(approvalId)).first_sent_at).toBeNull();
    await t.db.withUser(boss, (q) => recordFirstEmailSent(q, approvalId, null, ctx(boss)));
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "running", first_sent_by: boss });
  });

  it("is refused for a merchant whose emails were stopped for good", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m, { firstEmail: "later" });
    await stopEmailsForGood(t.db, { userId: rep, email: "rep@crm.test" }, m);
    await expect(
      t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, null, ctx(rep))),
    ).rejects.toThrow(/stopped for good/);
    expect(await approvalRow(approvalId)).toMatchObject({
      emails: "stopped",
      emails_note: "manual_stop",
      first_sent_at: null,
    });
  });
});

describe("the CRM never sends the first email", () => {
  it("the default is 'later': the approval is held, with nothing on the outbox, now or when the engines run", async () => {
    const m = await merchant();
    const { approvalId, started, emailsStopped, first } = await mark(m);
    expect({ started, emailsStopped, first }).toEqual({
      started: false,
      emailsStopped: false,
      first: null,
    });
    expect(await approvalRow(approvalId)).toMatchObject({
      status: "open",
      emails: "paused",
      emails_note: "held",
      next_step: null,
      first_sent_at: null,
      first_sent_by: null,
    });
    await run(at(2));
    await drain(at(3));
    await run(at(30));
    expect(await outbox(m)).toEqual([]);
    expect(
      await many(
        "select 1 from activities where client_id = $1 and body like 'First approval email%'",
        [m],
      ),
    ).toHaveLength(0);
  });

  it("the engine never queues step 1, even for a running approval with no first_sent_at", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m);
    // a stale row, or one pushed back by hand: running, and no first email recorded
    await t.pool.query("update approvals set emails = 'running', emails_note = '' where id = $1", [
      approvalId,
    ]);
    const r = await advanceApprovalNow(t.db, approvalId, ctx(rep));
    expect(r).toEqual({ kind: "waiting", note: "first_by_rep", step: 1, at: null });
    expect(await approvalRow(approvalId)).toMatchObject({
      emails: "running",
      emails_note: "first_by_rep",
      next_step: 1,
      next_email_at: null,
      first_sent_at: null,
    });
    // every engine pass, whatever the time: still nothing
    await run(at(2));
    await run(at(48));
    await drain(at(49));
    expect(await outbox(m)).toEqual([]);
    expect(sent.filter((s) => s.to === `owner${n}@shop${n}.test`)).toEqual([]);
    expect((await approvalRow(approvalId)).emails_note).toBe("first_by_rep");
  });

  it("Resume on a held approval is refused in words, and the approval is exactly as it was", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m);
    const before = await approvalRow(approvalId);
    await expect(t.db.withUser(rep, (q) => resumeApprovalEmails(q, approvalId))).rejects.toThrow(
      /Send the first email from your own mail/,
    );
    expect(await approvalRow(approvalId)).toEqual(before);
    expect(await advanceApprovalNow(t.db, approvalId, ctx(rep, at(1)))).toEqual({ kind: "idle" });
    expect(await outbox(m)).toEqual([]);
  });

  it("Resume is allowed once a first email is on record: the rep's own, or one the system sent before this rule", async () => {
    // the rep's own, recorded: paused by hand, then resumed
    const m = await merchant();
    const { approvalId } = await mine(m, at(-1));
    await t.db.withUser(rep, (q) => pauseApprovalEmails(q, approvalId));
    await t.db.withUser(rep, (q) => resumeApprovalEmails(q, approvalId));
    expect(await approvalRow(approvalId)).toMatchObject({ emails: "running", emails_note: "" });

    // an older approval whose first email went from the system (a SENT step 1 on the outbox) and was then held
    const old = await merchant();
    const held = await mark(old);
    await t.pool.query(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at, not_before)
       values ($1, $2, 'approval', $3, (select email from clients where id = $2), 'Hello', 'Hi', 'sent', $4, $4)`,
      [rep, old, `approval:${held.approvalId}:step:1`, at(-1).toISOString()],
    );
    await t.db.withUser(rep, (q) => resumeApprovalEmails(q, held.approvalId));
    expect(await approvalRow(held.approvalId)).toMatchObject({
      emails: "running",
      emails_note: "",
    });
    // its follow-up 1 comes its delay after that step 1 went, and step 1 is not queued again
    const next = await advanceApprovalNow(t.db, held.approvalId, ctx(rep));
    expect(next).toMatchObject({ kind: "waiting", step: 2 });
    expect((await outbox(old)).map((r) => [r.source, r.status])).toEqual([
      [`approval:${held.approvalId}:step:1`, "sent"],
    ]);
  });

  it("recording the first email starts follow-up 1 its delay later, and step 1 is never queued along the way", async () => {
    const m = await merchant();
    const { approvalId } = await mark(m);
    expect(await outbox(m)).toEqual([]);
    await t.db.withUser(rep, (q) => recordFirstEmailSent(q, approvalId, NOW, ctx(rep)));
    expect(await advanceApprovalNow(t.db, approvalId, ctx(rep))).toMatchObject({
      kind: "waiting",
      step: 2,
    });
    const a = await approvalRow(approvalId);
    expect(a).toMatchObject({ emails: "running", emails_note: "", next_step: 2 });
    expect(a.next_email_at?.toISOString()).toBe(at(DELAYS[2]).toISOString());
    // a minute before its delay is up: nothing; at the moment: follow-up 1, and only that
    await run(new Date(at(DELAYS[2]).getTime() - 60_000));
    expect(await outbox(m)).toEqual([]);
    await run(at(DELAYS[2]));
    expect((await outbox(m)).map((r) => [r.source, r.status])).toEqual([
      [`approval:${approvalId}:step:2`, "queued"],
    ]);
  });

  it("the old schema still parses the old input (the form's other fields are untouched)", () => {
    expect(
      approvalSchema.parse({ clientId: "11111111-1111-4111-8111-111111111111", amount: "85k" }),
    ).toMatchObject({ startEmails: true });
  });
});
