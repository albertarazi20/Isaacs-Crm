/**
 * The send worker and a bucket's daily reminder (migration 0593). A row whose source is
 * bucket:<id>:daily:<date> goes at its own time, outside the shared 9-11 window and on a Sunday, and skips the
 * per-merchant daily / weekly caps; it is cancelled ('left_bucket') once the merchant is no longer a live member of a
 * bucket that still has a daily template. Everything else (opt-out, do-not-contact, suppression, trash, pause,
 * the shop's own cap, expiry, the postal address) still applies. Every assertion reads the outbox, the ledger and the
 * enrolments, not the run summary alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { enqueueEmail } from "@/lib/send/enqueue";
import { inSendWindow } from "@/lib/send/rules";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let n = 0;
const APP = "https://crm.test";
const NY = "America/New_York";
const GMAIL = "rep@selectivecap.com";
const at = (iso: string) => new Date(iso);

// Sunday 22 Nov 2026, 17:00 in New York: outside the 9-11 window, and a weekend
const SUN = "2026-11-22T22:00:00.000Z";
// Wednesday 25 Nov 2026, 10:00 in New York: inside the window on a weekday
const WED = "2026-11-25T15:00:00.000Z";

const sentTo: string[] = [];
const ok: Deliverer = {
  gmail: async (_u, m) => (sentTo.push(m.to), `g_${sentTo.length}`),
  resend: async (m) => (sentTo.push(m.to), `r_${sentTo.length}`),
};
const failing: Deliverer = {
  gmail: async () => {
    throw new Error("gmail 500");
  },
  resend: async () => "x",
};
const drain = (now: string, deliver: Deliverer = ok) =>
  drainOutbox({ db: t.db, deliver, now: at(now), appUrl: APP });

interface Row {
  id: string;
  status: string;
  skip_reason: string | null;
  last_error: string | null;
  not_before: Date;
  attempts: number;
}
const row = async (id: string): Promise<Row> =>
  (
    await t.pool.query<Row>(
      "select id, status, skip_reason, last_error, not_before, attempts from outbox where id = $1",
      [id],
    )
  ).rows[0] as Row;
const ledgerFor = async (outboxId: string) =>
  (await t.pool.query("select 1 from send_ledger where outbox_id = $1", [outboxId])).rowCount;

async function dailyBucket(): Promise<string> {
  n += 1;
  const tpl = (
    await t.pool.query<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Reminder', 'Hi {first_name}, a reminder.', true) returning id",
      [rep, `Worker daily template ${n}`],
    )
  ).rows[0]?.id as string;
  return (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule, daily_template_id) values ($1, $2, 'manual', $3) returning id",
      [`Worker daily bucket ${n}`, rep, tpl],
    )
  ).rows[0]?.id as string;
}
async function plainBucket(): Promise<string> {
  n += 1;
  return (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule) values ($1, $2, 'manual') returning id",
      [`Worker plain bucket ${n}`, rep],
    )
  ).rows[0]?.id as string;
}
async function client(): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `worker${n}@x.com`;
  const id = (
    await t.pool.query<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state, timezone, timezone_source)
       values ($1, $2, 'Mike', '3055550100', $3, 'FL', $4, 'manual') returning id`,
      [rep, `Worker Shop ${n}`, email, NY],
    )
  ).rows[0]?.id as string;
  return { id, email };
}
const enrol = (clientId: string, bucketId: string) =>
  t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [clientId, bucketId]));
/** Queue a daily reminder for a bucket exactly as the engine does: its own moment, 4 hours to live. */
async function queueDaily(
  clientId: string,
  bucketId: string,
  when: string,
  date = when.slice(0, 10),
): Promise<string> {
  const r = await t.db.withUser(rep, (q) =>
    enqueueEmail(
      q,
      {
        clientId,
        lane: "sequence",
        source: `bucket:${bucketId}:daily:${date}`,
        subject: "Reminder",
        text: "Hi Mike, a reminder to send your documents.",
        when: "window",
        at: at(when),
        expiresInHours: 4,
      },
      at(when),
    ),
  );
  if (!r.queued) throw new Error(`not queued: ${r.reason}`);
  return r.outboxId;
}
/** A normal sequence step, queued for the moment given (what the engine did before daily buckets). */
async function queueStep(clientId: string, bucketId: string, when: string): Promise<string> {
  n += 1;
  const r = await t.db.withUser(rep, (q) =>
    enqueueEmail(
      q,
      {
        clientId,
        lane: "sequence",
        source: `bucket:${bucketId}:step:${n}`,
        subject: "Step",
        text: "Hi Mike, a step email.",
        when: "now",
        expiresInHours: 36,
      },
      at(when),
    ),
  );
  if (!r.queued) throw new Error(`not queued: ${r.reason}`);
  return r.outboxId;
}
async function mailbox(): Promise<string> {
  return (
    await t.pool.query<{ id: string }>(
      `insert into mailboxes (kind, user_id, address, provider_limit) values ('gmail', $1, $2, 2000)
       on conflict (kind, address) do update set active = true returning id`,
      [rep, GMAIL],
    )
  ).rows[0]?.id as string;
}
/** Earlier mail a merchant already got: `hoursAgo` before `now`, as the ledger records it. */
async function seedSent(clientId: string, now: string, hoursAgo: number[]) {
  const mb = await mailbox();
  for (const h of hoursAgo) {
    await t.pool.query(
      "insert into send_ledger (mailbox_id, client_id, lane, sent_at) values ($1, $2, 'sequence', $3)",
      [mb, clientId, new Date(at(now).getTime() - h * 3_600_000).toISOString()],
    );
  }
}

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", NY);
  await t.pool.query("update app_users set name = 'Sam Rep' where id = $1", [rep]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, $2, 'enc', 'send', 'ok')",
    [rep, GMAIL],
  );
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  // nothing left over from another test is queued, sent or counted against a cap
  await t.pool.query(
    "update outbox set status = 'cancelled', skip_reason = 'test_reset' where status in ('queued', 'sending')",
  );
  await t.pool.query("delete from send_ledger");
  await t.pool.query(
    `update shop_settings set postal_address = '1 Main St', daily_cap = 1500, reserved_for_intake = 150,
            per_merchant_daily = 1, per_merchant_weekly = 3, send_window_start = 9, send_window_end = 11,
            send_on_weekends = false, send_on_holidays = false, amber_at = 1200`,
  );
  sentTo.length = 0;
});

describe("a daily reminder goes at its own time", () => {
  it("sends outside the shared window and on a Sunday, while a normal sequence step is held to the window", async () => {
    const b = await dailyBucket();
    const a = await client();
    const c = await client();
    await enrol(a.id, b);
    const daily = await queueDaily(a.id, b, SUN);
    const step = await queueStep(c.id, await plainBucket(), SUN);

    // sanity: the moment really is outside the window and on a weekend
    expect(inSendWindow(at(SUN), { timezone: NY, startHour: 9, endHour: 11, weekends: true })).toBe(
      false,
    );

    await drain(SUN);

    expect(await row(daily)).toMatchObject({ status: "sent", skip_reason: null, attempts: 1 });
    expect(await ledgerFor(daily)).toBe(1);
    expect(sentTo).toEqual([a.email]);

    // the normal step is deferred, not sent, and re-timed to a slot inside the window
    const held = await row(step);
    expect(held).toMatchObject({ status: "queued", last_error: "outside_window" });
    expect(held.not_before.getTime()).toBeGreaterThan(at(SUN).getTime());
    expect(
      inSendWindow(held.not_before, { timezone: NY, startHour: 9, endHour: 11, weekends: false }),
    ).toBe(true);
    expect(await ledgerFor(step)).toBe(0);
  });

  it("does not send before its time", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, "2026-11-23T15:00:00.000Z");
    await drain("2026-11-23T14:59:00.000Z");
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(sentTo).toEqual([]);
    await drain("2026-11-23T15:00:00.000Z");
    expect(await row(id)).toMatchObject({ status: "sent" });
  });

  it("sends even when the merchant already got three emails this week and one today; a normal step in that state is deferred", async () => {
    const b = await dailyBucket();
    const a = await client();
    const c = await client();
    await enrol(a.id, b);
    const daily = await queueDaily(a.id, b, WED);
    const step = await queueStep(c.id, await plainBucket(), WED);
    // both merchants: one email an hour ago (today) and two more earlier this week
    for (const m of [a, c]) await seedSent(m.id, WED, [1, 48, 72]);

    await drain(WED);

    expect(await row(daily)).toMatchObject({ status: "sent" });
    expect(await ledgerFor(daily)).toBe(1);
    expect(sentTo).toEqual([a.email]);
    const held = await row(step);
    expect(held).toMatchObject({ status: "queued", last_error: "per_merchant_cap" });
    expect(held.not_before.getTime()).toBeGreaterThanOrEqual(at(WED).getTime() + 24 * 3_600_000);
    expect(await ledgerFor(step)).toBe(0);
    // the merchant's ledger now holds the four they had plus the reminder
    const count = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from send_ledger where client_id = $1",
      [a.id],
    );
    expect(count.rows[0]?.n).toBe(4);
  });

  it("still obeys the shop's own daily cap: held, and not re-timed into the window", async () => {
    await t.pool.query(
      "update shop_settings set daily_cap = 50, reserved_for_intake = 10, amber_at = 40",
    );
    const b = await dailyBucket();
    const a = await client();
    const other = await client();
    await enrol(a.id, b);
    // 41 sent from this mailbox in the last day: 41 >= 50 - 10, so no more bulk mail goes
    await seedSent(
      other.id,
      SUN,
      Array.from({ length: 41 }, (_, i) => 1 + i / 100),
    );
    const id = await queueDaily(a.id, b, SUN);

    await drain(SUN);

    const held = await row(id);
    expect(held).toMatchObject({ status: "queued", last_error: "cap" });
    expect(sentTo).toEqual([]);
    expect(await ledgerFor(id)).toBe(0);
    // retried the moment the oldest send ages out of the 24 hours (plus a minute): not moved to a Monday 9-11 slot
    const oldest = (await t.pool.query<{ t: Date }>("select min(sent_at) as t from send_ledger"))
      .rows[0]?.t as Date;
    expect(held.not_before.getTime()).toBe(oldest.getTime() + 24 * 3_600_000 + 60_000);
    expect(
      inSendWindow(held.not_before, { timezone: NY, startHour: 9, endHour: 11, weekends: true }),
    ).toBe(false);
  });
});

describe("a daily reminder stops when the merchant leaves the bucket", () => {
  it("is sent while the merchant is a live member (control)", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, WED);
    await drain(WED);
    expect(await row(id)).toMatchObject({ status: "sent" });
  });

  it("is cancelled 'left_bucket' when the enrolment was stopped", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    await t.db.withUser(rep, (q) => q.query("select stop_enrollment($1, 'removed')", [a.id]));
    // queued after the stop (a run that raced it): the worker must still refuse
    const id = await queueDaily(a.id, b, WED);
    await drain(WED);
    expect(await row(id)).toMatchObject({ status: "cancelled", skip_reason: "left_bucket" });
    expect(sentTo).toEqual([]);
    expect(await ledgerFor(id)).toBe(0);
  });

  it("is cancelled 'left_bucket' when the merchant moved to another bucket", async () => {
    const b = await dailyBucket();
    const other = await plainBucket();
    const a = await client();
    await enrol(a.id, b);
    await enrol(a.id, other);
    const id = await queueDaily(a.id, b, WED);
    await drain(WED);
    expect(await row(id)).toMatchObject({ status: "cancelled", skip_reason: "left_bucket" });
    expect(sentTo).toEqual([]);
  });

  it("is cancelled 'left_bucket' when the merchant moved to another DAILY bucket (the old one is not theirs any more)", async () => {
    const b = await dailyBucket();
    const other = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    await enrol(a.id, other);
    const old = await queueDaily(a.id, b, WED);
    const current = await queueDaily(a.id, other, WED);
    await drain(WED);
    expect(await row(old)).toMatchObject({ status: "cancelled", skip_reason: "left_bucket" });
    expect(await row(current)).toMatchObject({ status: "sent" });
    expect(sentTo).toEqual([a.email]);
  });

  it("is cancelled 'left_bucket' when the bucket's daily template was cleared", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, WED);
    await t.pool.query("update buckets set daily_template_id = null where id = $1", [b]);
    await drain(WED);
    expect(await row(id)).toMatchObject({ status: "cancelled", skip_reason: "left_bucket" });
    expect(sentTo).toEqual([]);
    // the merchant is still enrolled: only the daily mail stopped
    expect(
      (
        await t.pool.query(
          "select 1 from enrollments where client_id = $1 and bucket_id = $2 and stopped_at is null",
          [a.id, b],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("is cancelled 'left_bucket' for a bucket the merchant was never in", async () => {
    const b = await dailyBucket();
    const a = await client();
    const id = await queueDaily(a.id, b, WED);
    await drain(WED);
    expect(await row(id)).toMatchObject({ status: "cancelled", skip_reason: "left_bucket" });
  });
});

describe("everything else still stops a daily reminder", () => {
  const stopped = async (
    change: (clientId: string, email: string) => Promise<unknown>,
  ): Promise<{ id: string; email: string; clientId: string }> => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, WED);
    await change(a.id, a.email);
    await drain(WED);
    return { id, email: a.email, clientId: a.id };
  };

  it("an opt-out", async () => {
    const r = await stopped((c) =>
      t.pool.query("update clients set email_opt_out = true where id = $1", [c]),
    );
    expect(await row(r.id)).toMatchObject({ status: "skipped", skip_reason: "opted_out" });
    expect(sentTo).toEqual([]);
    expect(await ledgerFor(r.id)).toBe(0);
  });

  it("do-not-contact", async () => {
    const r = await stopped((c) =>
      t.pool.query("update clients set contact_status = 'dnc' where id = $1", [c]),
    );
    expect(await row(r.id)).toMatchObject({ status: "skipped", skip_reason: "dnc" });
    expect(sentTo).toEqual([]);
  });

  it("an address on the suppression list", async () => {
    const r = await stopped((_c, email) =>
      t.pool.query(
        "insert into suppressions (channel, key_hash, reason) values ('email', app.suppression_key($1), 'manual')",
        [email],
      ),
    );
    expect(await row(r.id)).toMatchObject({ status: "skipped", skip_reason: "suppressed" });
    expect(sentTo).toEqual([]);
  });

  it("a merchant in the trash", async () => {
    const r = await stopped((c) =>
      t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [c, rep]),
    );
    expect(await row(r.id)).toMatchObject({ status: "cancelled", skip_reason: "trashed" });
    expect(sentTo).toEqual([]);
  });

  it("a row past its expiry is skipped, one just inside it goes", async () => {
    const b = await dailyBucket();
    const inside = await client();
    const late = await client();
    await enrol(inside.id, b);
    await enrol(late.id, b);
    // both were due at 15:00Z and live until 19:00Z
    const goes = await queueDaily(inside.id, b, "2026-11-23T15:00:00.000Z");
    const gone = await queueDaily(late.id, b, "2026-11-23T15:00:00.000Z");
    await t.pool.query(
      "update outbox set expires_at = '2026-11-23T19:00:00Z' where id in ($1, $2)",
      [goes, gone],
    );
    // only the first is claimed by an early run: park the second until the late one
    await t.pool.query("update outbox set not_before = '2026-11-23T19:00:01Z' where id = $1", [
      gone,
    ]);
    await drain("2026-11-23T18:59:59.000Z");
    expect(await row(goes)).toMatchObject({ status: "sent" });
    expect(await row(gone)).toMatchObject({ status: "queued" });
    await drain("2026-11-23T19:00:01.000Z");
    expect(await row(gone)).toMatchObject({ status: "skipped", skip_reason: "expired" });
    expect(await ledgerFor(gone)).toBe(0);
    expect(sentTo).toEqual([inside.email]);
  });

  it("a postal address missing from the settings holds it for an hour, not re-timed into the window", async () => {
    await t.pool.query("update shop_settings set postal_address = ''");
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, SUN);
    await drain(SUN);
    const held = await row(id);
    expect(held).toMatchObject({ status: "queued", last_error: "no_postal_address" });
    expect(held.not_before).toEqual(at("2026-11-22T23:00:00.000Z")); // now + 1 hour, a Sunday evening
    expect(sentTo).toEqual([]);
  });
});

describe("a deferral is not re-timed into the window", () => {
  it("a paused member waits one hour from now, where a normal step waits for the next window slot", async () => {
    const b = await dailyBucket();
    const plain = await plainBucket();
    const a = await client();
    const c = await client();
    await enrol(a.id, b);
    await enrol(c.id, plain);
    await t.pool.query("update enrollments set paused = true where stopped_at is null");
    const daily = await queueDaily(a.id, b, SUN);
    // a step source that belongs to the paused enrolment's bucket, queued for the same moment
    const step = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        {
          clientId: c.id,
          lane: "sequence",
          source: `bucket:${plain}:step:1`,
          subject: "Step",
          text: "Hi Mike, a step.",
          when: "now",
          expiresInHours: 36,
        },
        at(SUN),
      ),
    );
    if (!step.queued) throw new Error("not queued");

    await drain(SUN);

    const d = await row(daily);
    expect(d).toMatchObject({ status: "queued", last_error: "paused" });
    expect(d.not_before).toEqual(at("2026-11-22T23:00:00.000Z")); // exactly one hour on: a Sunday, outside the window
    const s = await row(step.outboxId);
    expect(s).toMatchObject({ status: "queued" });
    // a step arriving outside the window is moved to the next window slot by its own check
    expect(
      inSendWindow(s.not_before, { timezone: NY, startHour: 9, endHour: 11, weekends: false }),
    ).toBe(true);
    expect(sentTo).toEqual([]);
  });

  it("a send that fails is retried 15 minutes on, not moved to the next window", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    const id = await queueDaily(a.id, b, SUN);
    await drain(SUN, failing);
    const r = await row(id);
    expect(r).toMatchObject({ status: "queued", attempts: 1, last_error: "gmail 500" });
    expect(r.not_before).toEqual(at("2026-11-22T22:15:00.000Z"));
    expect(await ledgerFor(id)).toBe(0);
    // the next run, at that time, sends it (still a Sunday evening)
    await drain("2026-11-22T22:15:00.000Z");
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(sentTo).toEqual([a.email]);
  });

  it("no Gmail connected holds it six hours from now, to the minute", async () => {
    const rep2 = await insertUser(t.pool, "nogmail@x.com", NY);
    n += 1;
    const tpl = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, 'T2', 'R', 'Hi {first_name}', true) returning id",
        [rep2],
      )
    ).rows[0]?.id as string;
    const b = (
      await t.pool.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule, daily_template_id) values ($1, $2, 'manual', $3) returning id",
        [`No gmail bucket ${n}`, rep2, tpl],
      )
    ).rows[0]?.id as string;
    const cid = (
      await t.pool.query<{ id: string }>(
        `insert into clients (user_id, business_name, contact_name, phone, email, state, timezone, timezone_source)
         values ($1, 'No Gmail Shop', 'Mike', '3055550100', 'nogmail-shop@x.com', 'FL', $2, 'manual') returning id`,
        [rep2, NY],
      )
    ).rows[0]?.id as string;
    await t.db.withUser(rep2, (q) => q.query("select enroll_in_bucket($1, $2)", [cid, b]));
    const r = await t.db.withUser(rep2, (q) =>
      enqueueEmail(
        q,
        {
          clientId: cid,
          lane: "sequence",
          source: `bucket:${b}:daily:2026-11-22`,
          subject: "R",
          text: "Hi Mike, a reminder.",
          when: "window",
          at: at(SUN),
          expiresInHours: 4,
        },
        at(SUN),
      ),
    );
    if (!r.queued) throw new Error("not queued");
    await drain(SUN);
    const held = await row(r.outboxId);
    expect(held).toMatchObject({ status: "queued", last_error: "gmail_not_connected" });
    expect(held.not_before).toEqual(at("2026-11-23T04:00:00.000Z")); // SUN 22:00Z + 6 h
    await t.pool.query(
      "update outbox set status = 'cancelled', skip_reason = 'test_reset' where id = $1",
      [r.outboxId],
    );
  });
});

describe("a daily reminder that ends unsent is not counted as sent", () => {
  const stepsSent = async (clientId: string) =>
    (
      await t.pool.query<{ steps_sent: number }>(
        "select steps_sent from enrollments where client_id = $1 and stopped_at is null",
        [clientId],
      )
    ).rows[0]?.steps_sent;
  const notes = async (clientId: string) =>
    (
      await t.pool.query(
        "select 1 from activities where client_id = $1 and kind = 'system' and body like 'Bucket email step%'",
        [clientId],
      )
    ).rowCount;

  it("the engine counts the reminder when it queues it; one that expires unsent takes it back, without a timeline note", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    await t.pool.query("update enrollments set next_due_on = '2026-11-23' where client_id = $1", [
      a.id,
    ]);
    await runBucketSteps({ db: t.db, now: at("2026-11-23T12:00:00Z"), appUrl: APP });
    expect(await stepsSent(a.id)).toBe(1);
    const queued = await t.pool.query<{ id: string }>(
      "select id from outbox where client_id = $1",
      [a.id],
    );
    const id = queued.rows[0]?.id as string;
    // 10:00 EST + 4 hours = 19:00Z: found after that, it is skipped as expired
    await drain("2026-11-23T19:30:00.000Z");
    expect(await row(id)).toMatchObject({ status: "skipped", skip_reason: "expired" });
    expect(await stepsSent(a.id)).toBe(0);
    expect(await notes(a.id)).toBe(0);
  });

  it("one that is sent stays counted", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    await t.pool.query("update enrollments set next_due_on = '2026-11-23' where client_id = $1", [
      a.id,
    ]);
    await runBucketSteps({ db: t.db, now: at("2026-11-23T12:00:00Z"), appUrl: APP });
    await drain("2026-11-23T15:00:00.000Z");
    expect(sentTo).toEqual([a.email]);
    expect(await stepsSent(a.id)).toBe(1);
  });

  it("one cancelled because the merchant's own opt-out stopped it is left to the opt-out's own entry", async () => {
    const b = await dailyBucket();
    const a = await client();
    await enrol(a.id, b);
    await t.pool.query("update enrollments set next_due_on = '2026-11-23' where client_id = $1", [
      a.id,
    ]);
    await runBucketSteps({ db: t.db, now: at("2026-11-23T12:00:00Z"), appUrl: APP });
    await t.pool.query("update clients set email_opt_out = true where id = $1", [a.id]);
    await drain("2026-11-23T15:00:00.000Z");
    expect(await stepsSent(a.id)).toBe(1); // same rule as a sequence step: the opt-out explains it
    expect(await notes(a.id)).toBe(0);
  });
});
