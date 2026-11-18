import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { bucketScores, templateScores } from "@/lib/buckets/queries";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 1: S1-8 a bounce opens the rep's "get the right address by phone" task; S1-7 template and bucket scores,
 * and the bounce-spike auto-pause (template paused, queued rows cancelled, managers alerted).
 */

let t: TestDb;
let rep: string;
let manager: string;
let statements: string;
let template: string;
let n = 0;
const deliver: Deliverer = {
  gmail: async () => `g_${++n}`,
  resend: async () => `r_${++n}`,
};

const client = async (name: string) =>
  (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', '3055550100', $3, 'FL') returning id",
      [rep, name, `${name.toLowerCase().replace(/\W/g, "")}@x.com`],
    )
  ).rows[0]!.id;
const queue = (clientId: string, text = "Hi {first_name}, statements please") =>
  t.db.withUser(rep, async (q) => {
    const r = await enqueueEmail(q, {
      clientId,
      lane: "sequence",
      source: `bucket:${statements}:step:1`,
      subject: "Statements",
      text,
      when: "now",
      templateId: template,
    });
    if (!r.queued) throw new Error(`not queued: ${r.reason}`);
    return r.outboxId;
  });
const providerIdOf = async (outboxId: string) =>
  (
    await t.pool.query<{ provider_id: string }>("select provider_id from outbox where id = $1", [
      outboxId,
    ])
  ).rows[0]!.provider_id;
const bounce = (providerId: string, note = "mailbox does not exist") =>
  t.pool.query("select record_delivery_event('gmail', $1, 'hard_bounce', $2)", [providerId, note]);
const drain = () =>
  drainOutbox({ db: t.db, deliver, now: new Date(Date.now() + 5_000), appUrl: "https://crm.test" });

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
    [rep],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St', per_merchant_daily = 5, per_merchant_weekly = 20",
  );
  // these tests run on the wall clock and are about scores and bounces, not the window (bulk mail goes only inside it)
  await t.pool.query(
    "update shop_settings set send_window_start = 0, send_window_end = 24, send_on_weekends = true, send_on_holidays = true",
  );
  statements = (
    await t.pool.query<{ id: string }>("select id from buckets where key = 'missing_statements'")
  ).rows[0]!.id;
  template = (
    await t.pool.query<{ template_id: string }>(
      "select template_id from bucket_steps where bucket_id = $1 and step_no = 1",
      [statements],
    )
  ).rows[0]!.template_id;
});
afterAll(async () => {
  await t.drop();
});

describe("S1-8: a bounce is a call to make", () => {
  it("opens one follow-up for the rep, due today in the rep's zone, and never a second for the same merchant", async () => {
    const id = await client("Bounce Co");
    const row = await queue(id);
    expect((await drain()).sent).toBe(1);
    await bounce(await providerIdOf(row));
    const today = (
      await t.pool.query<{ d: string }>(
        "select (now() at time zone 'America/New_York')::date::text as d",
      )
    ).rows[0]!.d;
    const task = () =>
      t.pool.query<{ kind: string; due_on: string; note: string }>(
        "select kind, due_on::text, note from timers where client_id = $1 and done_at is null and note like 'Email bounced%'",
        [id],
      );
    expect((await task()).rows).toEqual([
      { kind: "follow_up", due_on: today, note: "Email bounced — get the right address by phone" },
    ]);
    // the merchant is suppressed and the chase stopped, as before
    const c = (
      await t.pool.query<{ email_bounced_at: string | null }>(
        "select email_bounced_at from clients where id = $1",
        [id],
      )
    ).rows[0];
    expect(c?.email_bounced_at).not.toBeNull();
    await bounce(await providerIdOf(row), "again");
    expect((await task()).rows).toHaveLength(1);
  });
});

describe("S1-7: scores and the bounce-spike auto-pause", () => {
  const ids: string[] = [];
  const rows: string[] = [];

  it("one bounce in twenty-one sends: no pause; the next (10%) pauses the template, cancels its queue and alerts managers", async () => {
    for (let i = 0; i < 20; i += 1) {
      const id = await client(`Spike ${i}`);
      ids.push(id);
      rows.push(await queue(id));
    }
    expect((await drain()).sent).toBe(20);
    await bounce(await providerIdOf(rows[0]!));
    let tpl = (
      await t.pool.query<{ auto_paused_at: string | null; ok: boolean; auto_pause_reason: string }>(
        "select auto_paused_at, auto_pause_reason, app.template_may_auto_send(id) as ok from templates where id = $1",
        [template],
      )
    ).rows[0];
    expect(tpl).toEqual({ auto_paused_at: null, auto_pause_reason: "", ok: true });

    // a step still waiting to go out from the same template
    const waiting = await queue(await client("Waiting Co"));
    await bounce(await providerIdOf(rows[1]!));
    tpl = (
      await t.pool.query<{ auto_paused_at: string | null; ok: boolean; auto_pause_reason: string }>(
        "select auto_paused_at, auto_pause_reason, app.template_may_auto_send(id) as ok from templates where id = $1",
        [template],
      )
    ).rows[0];
    expect(tpl?.auto_paused_at).not.toBeNull();
    expect(tpl?.ok).toBe(false);
    expect(tpl?.auto_pause_reason).toBe("3 of the last 21 emails bounced");
    const cancelled = (
      await t.pool.query<{ status: string; skip_reason: string | null }>(
        "select status, skip_reason from outbox where id = $1",
        [waiting],
      )
    ).rows[0];
    expect(cancelled).toEqual({ status: "cancelled", skip_reason: "template_paused" });
    const alerts = await t.pool.query<{
      user_id: string;
      kind: string;
      title: string;
      body: string;
    }>("select user_id, kind, title, body from user_alerts order by id");
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({
      user_id: manager,
      kind: "bounce_spike",
      title: "Template paused: Statements — first ask",
    });
    expect(alerts.rows[0]?.body).toMatch(/3 of the last 21 emails/);
    // the engine will not queue it while it is paused
    const fresh = await client("Fresh Co");
    await t.pool.query("select enroll_in_bucket($1, $2)", [fresh, statements]);
    const run = await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    expect(
      (await t.pool.query("select 1 from outbox where client_id = $1", [fresh])).rowCount,
    ).toBe(0);
  });

  it("template and bucket scores: sent, replies, docs in, days to docs, bounce and unsubscribe rates", async () => {
    // a reply, a document and an unsubscribe after the send, each on a different merchant
    await t.pool.query(
      `insert into inbound_emails (mailbox_user_id, gmail_id, from_address, subject, text_body, received_at, client_id, kind)
       values ($1, 'g-reply', 'spike2@x.com', 'Re: Statements', 'coming', now() + interval '1 hour', $2, 'merchant')`,
      [rep, ids[2]],
    );
    await t.pool.query(
      `insert into documents (user_id, client_id, kind, period, filename, content_type, size_bytes, sha256, storage_key, source, created_at)
       values ($1, $2, 'bank_statement', '2026-10-01', 'oct.pdf', 'application/pdf', 1000, repeat('a', 64), 'k1', 'upload_link', now() + interval '2 days')`,
      [rep, ids[3]],
    );
    await t.db.withUser(rep, (q) =>
      q.query("select opt_out($1, 'email', 'unsubscribe')", [ids[4]]),
    );
    // the sends were stamped a few seconds ahead (the drain's clock): the unsubscribe must follow them
    await t.pool.query(
      "update suppressions set created_at = now() + interval '1 hour' where client_id = $1",
      [ids[4]],
    );

    const byTemplate = await t.db.withUser(manager, (q) => templateScores(q));
    const s = byTemplate.find((x) => x.template_id === template);
    expect(s).toMatchObject({
      name: "Statements — first ask",
      sent: 21,
      replies: 1,
      docs_in: 1,
      avg_days_to_docs: 2,
      bounces: 3,
      unsubscribes: 1,
      bounce_rate: 0.143,
      reply_rate: 0.048,
      docs_rate: 0.048,
      unsubscribe_rate: 0.048,
    });
    expect(s?.auto_paused_at).not.toBeNull();
    const byBucket = await t.db.withUser(manager, (q) => bucketScores(q));
    const b = byBucket.find((x) => x.bucket_id === statements);
    expect(b).toMatchObject({
      name: "Missing statements",
      sent: 21,
      bounces: 3,
      replies: 1,
      docs_in: 1,
    });
    expect(b?.members).toBeGreaterThanOrEqual(1);
    // a template that never sent scores zero, not null
    const quiet = byTemplate.find((x) => x.name === "Cold — monthly nudge");
    expect(quiet).toMatchObject({ sent: 0, bounce_rate: 0, reply_rate: 0 });
  });
});
