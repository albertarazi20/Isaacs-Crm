import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceApproval } from "@/lib/approvals/engine";
import { emailsStoppedFor, stopEmailsForGood, turnEmailsBackOn } from "@/lib/approvals/hardStop";
import {
  createApproval,
  resumeApprovalEmails,
  saveApprovalDesign,
} from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { queueBlast, runBucketSteps } from "@/lib/buckets/engine";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { removeSuppression } from "@/lib/settings/mutations";
import { describeEvent } from "@/lib/settings/securityLog";
import { advanceApprovalNow, runApprovalEmails } from "@/lib/system/approvals";
import { runOpenNudges } from "@/lib/system/openNudge";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * "Stop emails for good" (0580). Every claim is read back from the DATABASE: the flags, the suppression row, the
 * approval, the outbox rows (queued ones cancelled, sent ones untouched), the enrolment, the timeline and the audit
 * log; and every automated lane is run for real against the stopped merchant (approval engine, bucket engine, nudge,
 * intake enqueue, manual blast, the outbox worker) to see that it skips them.
 */

const design = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head>
<body><h1>Congrats, {{first_name}}.</h1><p>{{business_name}} is approved for {{offer_amount}}.</p>
<p>{{rep_name}} {{rep_phone}} {{rep_email}}</p>
<p>1 Test Street, Testville, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`;

let t: TestDb;
let rep: string;
let other: string;
let boss: string;
let HOLD = "";
const APP = "https://crm.test";
const NOW = new Date("2026-11-18T19:00:00Z");
const ctx = (userId: string) => ({ userId, now: NOW, appUrl: APP });
const REP_EMAIL = "rep@crm.test";
const BOSS_EMAIL = "boss@crm.test";

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;
const many = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];

let n = 0;
async function merchant(owner = rep, email?: string): Promise<string> {
  n += 1;
  return (
    await one<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state)
       values ($1, $2, 'rosa diaz', $3, $4, 'FL') returning id`,
      [
        owner,
        `Shop ${n}`,
        `30555503${String(n).padStart(2, "0")}`,
        email ?? `owner${n}@shop${n}.test`,
      ],
    )
  ).id;
}
const emailOf = async (id: string) =>
  (await one<{ email: string }>("select email from clients where id = $1", [id])).email;

async function approve(clientId: string, userId = rep) {
  const { approvalId, started, emailsStopped } = await t.db.withUser(userId, (q) =>
    createApproval(
      q,
      approvalSchema.parse({ clientId, amount: "85000", holdUntil: HOLD }),
      ctx(userId),
    ),
  );
  if (started) await advanceApprovalNow(t.db, approvalId, ctx(userId));
  return { approvalId, started, emailsStopped };
}

/** A hand-written outbox row: the lanes the engines would have written, plus one already sent. */
async function outboxRow(
  clientId: string,
  lane: string,
  source: string,
  status = "queued",
  owner = rep,
) {
  return (
    await one<{ id: string }>(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at)
       values ($1, $2, $3, $4, (select email from clients where id = $2), 'Hello', 'Hi there', $5,
               case when $5 = 'sent' then now() end) returning id`,
      [owner, clientId, lane, source, status],
    )
  ).id;
}
const outbox = (clientId: string) =>
  many<{ id: string; lane: string; source: string; status: string; skip_reason: string | null }>(
    "select id, lane, source, status, skip_reason from outbox where client_id = $1 order by created_at",
    [clientId],
  );

const delivered: string[] = [];
const deliver: Deliverer = {
  gmail: async (_u, m) => (delivered.push(m.to), `g_${delivered.length}`),
  resend: async (m) => (delivered.push(m.to), `r_${delivered.length}`),
};

const stop = (clientId: string, userId = rep, email = REP_EMAIL) =>
  stopEmailsForGood(t.db, { userId, email }, clientId, { ip: "203.0.113.9", userAgent: "test" });

beforeAll(async () => {
  t = await createTestDb();
  HOLD = (await one<{ d: string }>("select (current_date + 60)::text as d")).d;
  rep = await insertUser(t.pool, REP_EMAIL, "America/New_York");
  other = await insertUser(t.pool, "other@crm.test", "America/New_York");
  boss = await insertUser(t.pool, BOSS_EMAIL);
  await t.pool.query("update app_users set role = 'manager', name = 'amy boss' where id = $1", [
    boss,
  ]);
  await t.pool.query(
    "update app_users set name = 'sam rep', phone = '(561) 555-0142' where id = $1",
    [rep],
  );
  await t.pool.query(
    "update app_users set name = 'olly other', phone = '(561) 555-0143' where id = $1",
    [other],
  );
  for (const [u, g] of [
    [rep, "rep-gmail@crm.test"],
    [other, "other-gmail@crm.test"],
  ] as const)
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, $2, 'enc', 'send', 'ok')",
      [u, g],
    );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Test Street, Testville, FL 33487'",
  );
  await t.db.withUser(boss, async (q) => {
    for (const step of [1, 2, 3, 4])
      await saveApprovalDesign(
        q,
        { step, subject: `Email ${step} for {{first_name}}`, html: design("x"), fileName: "" },
        boss,
      );
  });
});
afterAll(async () => {
  await t.drop();
});

describe("Stop emails for good: what one press does", () => {
  let m: string;
  let approvalId: string;
  let sentId: string;
  let replyId: string;
  let sentBefore: Record<string, unknown>;
  const queuedLanes = ["intake", "blast", "system"];

  it("sets up a merchant with an approval, a bucket chase, queued mail on several lanes and one email already sent", async () => {
    m = await merchant();
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        m,
      ]),
    );
    await runBucketSteps({ db: t.db, appUrl: APP });
    ({ approvalId } = await approve(m));
    for (const lane of queuedLanes) await outboxRow(m, lane, `${lane}:test`);
    sentId = await outboxRow(m, "sequence", "bucket:old:step:0", "sent");
    replyId = await outboxRow(m, "reply", "offer:test");
    sentBefore = await one("select * from outbox where id = $1", [sentId]);

    const rows = await outbox(m);
    // the chase's step 1, the approval's step 1, the three hand-written lanes and the reply row are queued
    expect(
      rows
        .filter((r) => r.status === "queued")
        .map((r) => r.lane)
        .sort(),
    ).toEqual(["approval", "blast", "intake", "reply", "sequence", "system"].sort());
    expect(
      await one(
        "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
        [m],
      ),
    ).toEqual({ n: 1 });
    expect(await t.db.withUser(rep, (q) => emailsStoppedFor(q, m))).toBeNull();
  });

  it("stops the merchant's emails: flags, suppression, approval, queued mail, enrolment, note and audit line", async () => {
    const res = await stop(m);
    expect(res).toMatchObject({ already: false, wasOptedOut: false, approvals: 1, enrollments: 1 });
    // the chase step, the approval step and the three lanes: the reply row stays
    expect(res.cancelled).toBe(5);

    // flags on the merchant
    const c = await one<{
      email_opt_out: boolean;
      emails_stopped_at: Date | null;
      emails_stopped_by: string | null;
    }>("select email_opt_out, emails_stopped_at, emails_stopped_by from clients where id = $1", [
      m,
    ]);
    expect(c.email_opt_out).toBe(true);
    expect(c.emails_stopped_at).toBeInstanceOf(Date);
    expect(c.emails_stopped_by).toBe(rep);

    // the address is on the do-not-email list, reason manual, tied to the merchant and the rep
    const sup = await many(
      "select reason, client_id, created_by, display from suppressions where channel = 'email' and key_hash = app.suppression_key($1)",
      [await emailOf(m)],
    );
    expect(sup).toEqual([
      {
        reason: "manual",
        client_id: m,
        created_by: rep,
        display: (await emailOf(m)).toLowerCase(),
      },
    ]);

    // the approval sequence is stopped with the right note and nothing scheduled
    expect(
      await one(
        "select emails, emails_note, next_step, next_email_at, status from approvals where id = $1",
        [approvalId],
      ),
    ).toEqual({
      emails: "stopped",
      emails_note: "manual_stop",
      next_step: null,
      next_email_at: null,
      status: "open",
    });

    // queued automated mail is cancelled with a reason; the rep's own one-off (reply lane) is not touched
    const rows = await outbox(m);
    for (const r of rows.filter((x) => x.id !== sentId && x.lane !== "reply"))
      expect(r).toMatchObject({ status: "cancelled", skip_reason: "manual_stop" });
    expect(rows.find((r) => r.id === replyId)).toMatchObject({ status: "queued" });

    // mail already sent is exactly as it was
    expect(await one("select * from outbox where id = $1", [sentId])).toEqual(sentBefore);

    // the live enrolment ended
    expect(
      await one(
        "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
        [m],
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        "select stop_reason from enrollments where client_id = $1 order by stopped_at desc limit 1",
        [m],
      ),
    ).toEqual({ stop_reason: "opted_out" });

    // a timeline note, on the merchant's rep's timeline
    const note = await many(
      "select body, kind, user_id from activities where client_id = $1 and body like 'Emails stopped by%'",
      [m],
    );
    expect(note).toEqual([{ body: "Emails stopped by sam rep", kind: "system", user_id: rep }]);

    // and one audit line, with counts and the merchant's id, never their details
    const audit = await many<{
      kind: string;
      email: string;
      client_id: string;
      detail: Record<string, unknown>;
      ip: string;
    }>(
      "select kind, email, client_id, detail, ip from audit_events where kind = 'merchant_emails_stopped' and client_id = $1",
      [m],
    );
    expect(audit).toEqual([
      {
        kind: "merchant_emails_stopped",
        email: REP_EMAIL,
        client_id: m,
        detail: {
          cancelled: 5,
          enrollments_stopped: 1,
          approvals_stopped: 1,
          already_opted_out: false,
        },
        ip: "203.0.113.9",
      },
    ]);
    expect(
      describeEvent({
        kind: "merchant_emails_stopped",
        email: audit[0]!.email,
        detail: audit[0]!.detail,
      }),
    ).toBe(`${REP_EMAIL} stopped all automated emails to a merchant (5 queued emails taken back).`);

    // the rep's merchant page can read the state without reading the suppression list
    expect(await t.db.withUser(rep, (q) => emailsStoppedFor(q, m))).toMatchObject({
      by: "sam rep",
    });
  });

  it("pressing it again changes nothing and writes no second note or audit line", async () => {
    const before = await one("select count(*)::int as n from activities where client_id = $1", [m]);
    expect(await stop(m)).toMatchObject({ already: true, cancelled: 0 });
    expect(
      await one("select count(*)::int as n from activities where client_id = $1", [m]),
    ).toEqual(before);
    expect(
      await one(
        "select count(*)::int as n from audit_events where kind = 'merchant_emails_stopped' and client_id = $1",
        [m],
      ),
    ).toEqual({ n: 1 });
    expect(
      await one(
        "select count(*)::int as n from suppressions where key_hash = app.suppression_key($1)",
        [await emailOf(m)],
      ),
    ).toEqual({ n: 1 });
  });

  it("every automated lane skips the stopped merchant", async () => {
    const before = (await outbox(m)).length;

    // the approval engine: forced back to running (as a stale row could be), it stops itself and queues nothing
    await t.pool.query("update approvals set emails = 'running', emails_note = '' where id = $1", [
      approvalId,
    ]);
    const ran = await runApprovalEmails({ db: t.db, appUrl: APP, now: NOW });
    expect(ran.queued).toBe(0);
    expect(
      await t.db.withSystem((q) => advanceApproval(q, approvalId, { now: NOW, appUrl: APP })),
    ).toEqual({ kind: "idle" });
    expect(
      await one("select emails, emails_note from approvals where id = $1", [approvalId]),
    ).toEqual({ emails: "stopped", emails_note: "opted_out" });
    // a rep pressing Resume is refused in words
    await expect(t.db.withUser(rep, (q) => resumeApprovalEmails(q, approvalId))).rejects.toThrow(
      /stopped for good/,
    );
    await t.pool.query(
      "update approvals set emails = 'stopped', emails_note = 'manual_stop' where id = $1",
      [approvalId],
    );

    // the bucket engine: re-enrolled by hand, it queues nothing
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        m,
      ]),
    );
    await runBucketSteps({ db: t.db, appUrl: APP });

    // the nudge after an open
    await t.pool.query("update shop_settings set open_nudge = true");
    await t.pool.query(
      "insert into link_opens (client_id, kind, opened_at) values ($1, 'upload', now() - interval '25 hours')",
      [m],
    );
    await runOpenNudges({ db: t.db, appUrl: APP });

    // the intake welcome email and a manual blast, through the same door every lane uses
    const intake = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, {
        clientId: m,
        lane: "intake",
        source: "intake:again",
        subject: "Welcome",
        text: "Welcome",
      }),
    );
    expect(intake).toEqual({ queued: false, reason: "opted_out" });
    const tpl = (
      await one<{ id: string }>("select id from templates where name = 'Cold — monthly nudge'")
    ).id;
    const blast = await t.db.withUser(rep, (q) =>
      queueBlast(q, { templateId: tpl, clientIds: [m], appUrl: APP }),
    );
    expect(blast).toMatchObject({ queued: 0, skipped: [{ clientId: m, reason: "opted_out" }] });

    // nothing new reached the outbox for this merchant
    expect((await outbox(m)).length).toBe(before);
  });

  it("the worker refuses stale queued rows on every lane that reach it after the stop", async () => {
    const lanes: [string, string][] = [
      ["intake", "intake:stale"],
      ["sequence", "bucket:stale:step:9"],
      ["blast", "blast:stale:2026-11-18"],
      ["system", "system:stale"],
      ["approval", `approval:${approvalId}:step:3`],
      ["reply", "offer:stale"],
    ];
    const ids: string[] = [];
    for (const [lane, source] of lanes) ids.push(await outboxRow(m, lane, source));
    delivered.length = 0;
    // the earlier reply-lane row is still queued too: the worker refuses it as well while the opt-out stands.
    // (rows written by hand are due at the database's own now, so the worker's clock is the real one)
    await drainOutbox({ db: t.db, deliver, now: new Date(Date.now() + 60_000), appUrl: APP });
    expect(delivered).not.toContain(await emailOf(m));
    const rows = await many<{ id: string; status: string }>(
      "select id, status from outbox where id = any($1) or id = $2",
      [ids, replyId],
    );
    expect(rows).toHaveLength(ids.length + 1);
    for (const r of rows) expect(r.status).toBe("skipped");
  });
});

describe("Who can stop whom", () => {
  it("a rep cannot stop another rep's merchant, and nothing about it changes", async () => {
    const theirs = await merchant(other);
    await outboxRow(theirs, "sequence", "bucket:x:step:1", "queued", other);
    await expect(stop(theirs, rep)).rejects.toMatchObject({ code: "P0002" });
    expect(
      await one("select email_opt_out, emails_stopped_at from clients where id = $1", [theirs]),
    ).toEqual({ email_opt_out: false, emails_stopped_at: null });
    expect(
      await one("select count(*)::int as n from suppressions where client_id = $1", [theirs]),
    ).toEqual({ n: 0 });
    expect((await outbox(theirs)).map((r) => r.status)).toEqual(["queued"]);
    expect(
      await one(
        "select count(*)::int as n from audit_events where kind = 'merchant_emails_stopped' and client_id = $1",
        [theirs],
      ),
    ).toEqual({ n: 0 });
  });

  it("a manager can stop any rep's merchant; the note names the manager and sits on the owner's timeline", async () => {
    const theirs = await merchant(other);
    await outboxRow(theirs, "sequence", "bucket:x:step:1", "queued", other);
    const res = await stop(theirs, boss, BOSS_EMAIL);
    expect(res).toMatchObject({ already: false, cancelled: 1 });
    expect(
      await one("select emails_stopped_by, email_opt_out from clients where id = $1", [theirs]),
    ).toEqual({ emails_stopped_by: boss, email_opt_out: true });
    expect(
      await one(
        "select user_id, body from activities where client_id = $1 and body like 'Emails stopped by%'",
        [theirs],
      ),
    ).toEqual({ user_id: other, body: "Emails stopped by amy boss" });
    expect((await outbox(theirs)).map((r) => r.status)).toEqual(["cancelled"]);
  });
});

describe("Merchants that are not the usual case", () => {
  it("a merchant with no email address is flagged (no suppression row: an empty address would match every such merchant)", async () => {
    const m = await merchant(rep, "");
    await stop(m);
    expect(
      await one(
        "select email_opt_out, emails_stopped_at is not null as stopped from clients where id = $1",
        [m],
      ),
    ).toEqual({ email_opt_out: true, stopped: true });
    expect(
      await one("select count(*)::int as n from suppressions where client_id = $1", [m]),
    ).toEqual({ n: 0 });
    // another merchant with no email address is not blocked by it
    const x = await merchant(rep, "");
    expect(
      await t.db.withUser(rep, (q) =>
        enqueueEmail(q, { clientId: x, lane: "intake", source: "i:x", subject: "s", text: "t" }),
      ),
    ).toEqual({ queued: false, reason: "no_address" });
    expect(await one("select email_opt_out from clients where id = $1", [x])).toEqual({
      email_opt_out: false,
    });
  });

  it("a merchant who already unsubscribed keeps their own opt-out: no hard-stop flag is set, queued mail is still taken back", async () => {
    const m = await merchant();
    await t.pool.query("select opt_out($1, 'email', 'unsubscribe', 'page')", [m]);
    await outboxRow(m, "sequence", "bucket:late:step:2");
    const res = await stop(m);
    expect(res).toMatchObject({ already: false, wasOptedOut: true, cancelled: 1 });
    expect(
      await one("select emails_stopped_at, email_opt_out from clients where id = $1", [m]),
    ).toEqual({ emails_stopped_at: null, email_opt_out: true });
    expect(await many("select reason from suppressions where client_id = $1", [m])).toEqual([
      { reason: "unsubscribe" },
    ]);
    // so a manager has nothing to turn back on
    expect(await turnEmailsBackOn(t.db, { userId: boss, email: BOSS_EMAIL }, m)).toEqual({
      changed: false,
    });
    expect(await one("select email_opt_out from clients where id = $1", [m])).toEqual({
      email_opt_out: true,
    });
  });

  it("an approval marked for a stopped merchant is saved with the emails stopped, and nothing is queued", async () => {
    const m = await merchant();
    await stop(m);
    const { approvalId, started, emailsStopped } = await approve(m);
    expect({ started, emailsStopped }).toEqual({ started: false, emailsStopped: true });
    expect(
      await one("select emails, emails_note from approvals where id = $1", [approvalId]),
    ).toEqual({ emails: "stopped", emails_note: "manual_stop" });
    await runApprovalEmails({ db: t.db, appUrl: APP, now: NOW });
    expect(await outbox(m)).toHaveLength(0);
  });
});

describe("Turning the emails back on", () => {
  let m: string;
  let approvalId: string;

  it("is for managers: a rep is refused in words and nothing changes", async () => {
    m = await merchant();
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        m,
      ]),
    );
    ({ approvalId } = await approve(m));
    await stop(m);
    await expect(
      turnEmailsBackOn(t.db, { userId: rep, email: REP_EMAIL }, m),
    ).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/Only a manager/) });
    expect(
      await one(
        "select email_opt_out, emails_stopped_at is not null as s from clients where id = $1",
        [m],
      ),
    ).toEqual({ email_opt_out: true, s: true });
  });

  it("clears the flag and the suppression, writes a note and an audit line, and restarts NOTHING by itself", async () => {
    const queuedBefore = (await outbox(m)).length;
    expect(await turnEmailsBackOn(t.db, { userId: boss, email: BOSS_EMAIL }, m)).toEqual({
      changed: true,
    });
    expect(
      await one(
        "select email_opt_out, emails_stopped_at, emails_stopped_by from clients where id = $1",
        [m],
      ),
    ).toEqual({ email_opt_out: false, emails_stopped_at: null, emails_stopped_by: null });
    expect(
      await one(
        "select count(*)::int as n from suppressions where key_hash = app.suppression_key($1)",
        [await emailOf(m)],
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        "select body from activities where client_id = $1 and body like 'Emails turned back on%'",
        [m],
      ),
    ).toEqual({ body: "Emails turned back on by amy boss" });
    expect(
      await one(
        "select count(*)::int as n from audit_events where kind = 'merchant_emails_resumed' and client_id = $1",
        [m],
      ),
    ).toEqual({ n: 1 });

    // the approval is still stopped (the note now offers "Start the emails"); the enrolment is still ended
    expect(
      await one("select emails, emails_note, next_step from approvals where id = $1", [approvalId]),
    ).toEqual({ emails: "stopped", emails_note: "reopened", next_step: null });
    expect(
      await one(
        "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
        [m],
      ),
    ).toEqual({ n: 0 });

    // run every engine: still nothing
    await runApprovalEmails({ db: t.db, appUrl: APP, now: NOW });
    await runBucketSteps({ db: t.db, appUrl: APP });
    await drainOutbox({ db: t.db, deliver, now: new Date(Date.now() + 60_000), appUrl: APP });
    expect((await outbox(m)).length).toBe(queuedBefore);
    expect(await one("select emails from approvals where id = $1", [approvalId])).toEqual({
      emails: "stopped",
    });
  });

  it("only a person pressing Start the emails sends the approval again", async () => {
    await t.db.withUser(rep, (q) => resumeApprovalEmails(q, approvalId));
    const r = await advanceApprovalNow(t.db, approvalId, ctx(rep));
    expect(r).toMatchObject({ kind: "queued", step: 1 });
    expect(
      (await outbox(m)).filter((x) => x.lane === "approval" && x.status === "queued"),
    ).toHaveLength(1);
  });

  it("is refused when the merchant also unsubscribed: their own wish stands, and the suppression says so", async () => {
    const x = await merchant();
    await stop(x);
    // the unsubscribe arrives after the stop: the suppression row's reason becomes theirs (0580)
    await t.pool.query("select opt_out($1, 'email', 'unsubscribe', 'the unsubscribe page')", [x]);
    expect(await many("select reason from suppressions where client_id = $1", [x])).toEqual([
      { reason: "unsubscribe" },
    ]);
    await expect(
      turnEmailsBackOn(t.db, { userId: boss, email: BOSS_EMAIL }, x),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringMatching(/also asked not to be emailed/),
    });
    expect(await one("select email_opt_out from clients where id = $1", [x])).toEqual({
      email_opt_out: true,
    });
    // and the Settings button refuses it too
    const supId = (
      await one<{ id: string }>("select id from suppressions where client_id = $1", [x])
    ).id;
    await expect(t.db.withUser(boss, (q) => removeSuppression(q, supId))).rejects.toThrow(
      /unsubscribed/,
    );
  });

  it("Settings > Suppressions removing the manual row turns the emails back on the same way", async () => {
    const x = await merchant();
    const { approvalId: a } = await approve(x);
    await stop(x);
    const supId = (
      await one<{ id: string }>("select id from suppressions where client_id = $1", [x])
    ).id;
    // a rep cannot read or remove the list: nothing happens for them
    await t.db.withUser(rep, (q) => removeSuppression(q, supId));
    expect(await one("select email_opt_out from clients where id = $1", [x])).toEqual({
      email_opt_out: true,
    });
    await t.db.withUser(boss, (q) => removeSuppression(q, supId));
    expect(
      await one("select email_opt_out, emails_stopped_at from clients where id = $1", [x]),
    ).toEqual({ email_opt_out: false, emails_stopped_at: null });
    expect(await one("select emails, emails_note from approvals where id = $1", [a])).toEqual({
      emails: "stopped",
      emails_note: "reopened",
    });
  });
});
