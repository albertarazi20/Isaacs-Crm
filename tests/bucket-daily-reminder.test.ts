/**
 * A bucket with a daily template (migration 0593): every live member gets one reminder a day at the shop's set time in
 * the merchant's own zone, every day but Saturday, until they leave. Proved in the database: the outbox rows (exact
 * not_before / expires_at, source, lane) and the enrolment (next_due_on, next_step, steps_sent), never a return value.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { inSendWindow } from "@/lib/send/rules";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let n = 0;
const APP = "https://crm.test";
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);
const run = (now: string) => runBucketSteps({ db: t.db, now: at(now), appUrl: APP });

interface OutRow {
  source: string;
  lane: string;
  status: string;
  skip_reason: string | null;
  not_before: Date;
  expires_at: Date | null;
}
const outbox = async (clientId: string): Promise<OutRow[]> =>
  (
    await t.pool.query<OutRow>(
      "select source, lane, status, skip_reason, not_before, expires_at from outbox where client_id = $1 order by not_before, created_at",
      [clientId],
    )
  ).rows;
const live = async (clientId: string) =>
  (
    await t.pool.query<{
      bucket_id: string;
      next_step: number;
      next_due_on: string | null;
      steps_sent: number;
      hold: boolean;
    }>(
      `select bucket_id, next_step, next_due_on::text, steps_sent, hold_since is not null as hold
         from enrollments where client_id = $1 and stopped_at is null`,
      [clientId],
    )
  ).rows[0];
const iso = (d: Date | null) => d?.toISOString();

async function template(opts: { approved?: boolean; body?: string } = {}): Promise<string> {
  n += 1;
  return (
    await t.pool.query<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Reminder for {business}', $3, $4) returning id",
      [
        rep,
        `Daily template ${n}`,
        opts.body ?? "Hi {first_name}, a quick reminder to send your documents for {business}.",
        opts.approved ?? true,
      ],
    )
  ).rows[0]?.id as string;
}
async function dailyBucket(templateId?: string): Promise<string> {
  n += 1;
  const tpl = templateId ?? (await template());
  return (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule, daily_template_id) values ($1, $2, 'manual', $3) returning id",
      [`Daily bucket ${n}`, rep, tpl],
    )
  ).rows[0]?.id as string;
}
async function client(tz: string, label = "Shop"): Promise<string> {
  n += 1;
  return (
    await t.pool.query<{ id: string }>(
      `insert into clients (user_id, business_name, contact_name, phone, email, state, timezone, timezone_source)
       values ($1, $2, 'Mike', '3055550100', $3, 'FL', $4, 'manual') returning id`,
      [rep, `${label} ${n}`, `daily${n}@x.com`, tz],
    )
  ).rows[0]?.id as string;
}
const enrol = (clientId: string, bucketId: string) =>
  t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [clientId, bucketId]));
/** Enrol and say which local day the first run is due (the function itself uses the database clock). */
async function enrolDue(clientId: string, bucketId: string, due: string) {
  await enrol(clientId, bucketId);
  await t.pool.query(
    "update enrollments set next_due_on = $2 where client_id = $1 and stopped_at is null",
    [clientId, due],
  );
}

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", NY);
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep' where id = $1",
    [rep],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St', sequences_enabled = true",
  );
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  // every test starts with nobody enrolled, so one test's members never run in another's
  await t.pool.query(
    "update enrollments set stopped_at = now(), stop_reason = 'removed' where stopped_at is null",
  );
  await t.pool.query("update shop_settings set daily_reminder_minute = 600");
});

describe("the daily reminder: when it is queued", () => {
  it("queues one row per member at 10:00 in each member's own zone, expiring four hours later", async () => {
    const b = await dailyBucket();
    const ny = await client(NY);
    const la = await client(LA);
    await enrolDue(ny, b, "2026-11-23");
    await enrolDue(la, b, "2026-11-23");

    // Monday 23 Nov 2026, 12:00 UTC: 07:00 in New York, 04:00 in Los Angeles
    const s = await run("2026-11-23T12:00:00Z");
    expect(s.emailed).toBe(2);

    expect(await outbox(ny)).toEqual([
      {
        source: `bucket:${b}:daily:2026-11-23`,
        lane: "sequence",
        status: "queued",
        skip_reason: null,
        not_before: at("2026-11-23T15:00:00.000Z"), // 10:00 EST
        expires_at: at("2026-11-23T19:00:00.000Z"),
      },
    ]);
    expect(await outbox(la)).toEqual([
      {
        source: `bucket:${b}:daily:2026-11-23`,
        lane: "sequence",
        status: "queued",
        skip_reason: null,
        not_before: at("2026-11-23T18:00:00.000Z"), // 10:00 PST
        expires_at: at("2026-11-23T22:00:00.000Z"),
      },
    ]);
    // the enrolment waits for the next day, stays on its one step, and counts the email
    expect(await live(ny)).toMatchObject({
      next_step: 1,
      next_due_on: "2026-11-24",
      steps_sent: 1,
    });
    expect(await live(la)).toMatchObject({
      next_step: 1,
      next_due_on: "2026-11-24",
      steps_sent: 1,
    });
  });

  it("records the queued row on the enrolment and fills the template for the merchant", async () => {
    const b = await dailyBucket();
    const c = await client(NY, "Rosa Bakery");
    await enrolDue(c, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    const row = (
      await t.pool.query<{ id: string; text_body: string; subject: string; template_id: string }>(
        "select id, text_body, subject, template_id from outbox where client_id = $1",
        [c],
      )
    ).rows[0];
    expect(row?.subject).toContain("Rosa Bakery");
    expect(row?.text_body).toContain("Hi Mike");
    expect(row?.text_body).toContain("Sam");
    const e = (
      await t.pool.query<{ last_outbox_id: string }>(
        "select last_outbox_id from enrollments where client_id = $1 and stopped_at is null",
        [c],
      )
    ).rows[0];
    expect(e?.last_outbox_id).toBe(row?.id);
  });

  it("does not queue a second row when it runs again the same day", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    await run("2026-11-23T12:30:00Z");
    await run("2026-11-23T13:00:00Z");
    expect(await outbox(c)).toHaveLength(1);
    expect(await live(c)).toMatchObject({ next_due_on: "2026-11-24", steps_sent: 1 });

    // even a run that finds the enrolment due again (a repeated cron) cannot make a copy while the first is queued
    await t.pool.query("update enrollments set next_due_on = '2026-11-23' where client_id = $1", [
      c,
    ]);
    await run("2026-11-23T13:30:00Z");
    expect(await outbox(c)).toHaveLength(1);
    expect(await live(c)).toMatchObject({ next_due_on: "2026-11-24", steps_sent: 1 });
  });

  it("queues the next day's row the next day, one row per day", async () => {
    const b = await dailyBucket();
    const ny = await client(NY);
    const la = await client(LA);
    await enrolDue(ny, b, "2026-11-23");
    await enrolDue(la, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    // Tuesday 24 Nov, same hour
    await run("2026-11-24T12:00:00Z");
    const nyRows = await outbox(ny);
    expect(nyRows.map((r) => [r.source, iso(r.not_before), iso(r.expires_at)])).toEqual([
      [`bucket:${b}:daily:2026-11-23`, "2026-11-23T15:00:00.000Z", "2026-11-23T19:00:00.000Z"],
      [`bucket:${b}:daily:2026-11-24`, "2026-11-24T15:00:00.000Z", "2026-11-24T19:00:00.000Z"],
    ]);
    const laRows = await outbox(la);
    expect(laRows.map((r) => iso(r.not_before))).toEqual([
      "2026-11-23T18:00:00.000Z",
      "2026-11-24T18:00:00.000Z",
    ]);
    expect(await live(ny)).toMatchObject({
      next_step: 1,
      next_due_on: "2026-11-25",
      steps_sent: 2,
    });
  });

  it("keeps 10:00 local across a clock change: the same merchant's rows move by an hour in UTC", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    // Friday 6 Mar 2026 is EST; the clocks go forward on Sunday 8 March
    await enrolDue(c, b, "2026-03-06");
    await run("2026-03-06T12:00:00Z");
    await run("2026-03-08T12:00:00Z"); // 08:00 EDT Sunday
    expect((await outbox(c)).map((r) => iso(r.not_before))).toEqual([
      "2026-03-06T15:00:00.000Z", // 10:00 EST
      "2026-03-08T14:00:00.000Z", // 10:00 EDT
    ]);
  });

  it("never queues a Saturday: Friday after the time goes to Sunday, in each merchant's own zone", async () => {
    const b = await dailyBucket();
    const ny = await client(NY);
    const la = await client(LA);
    await enrolDue(ny, b, "2026-11-20");
    await enrolDue(la, b, "2026-11-20");

    // Friday 20 Nov, 17:00 UTC: 12:00 in New York (10:00 has passed), 09:00 in Los Angeles (still ahead)
    await run("2026-11-20T17:00:00Z");
    expect((await outbox(ny)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-22`, "2026-11-22T15:00:00.000Z"], // Sunday 10:00 EST
    ]);
    expect((await outbox(la)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-20`, "2026-11-20T18:00:00.000Z"], // today, 10:00 PST
    ]);
    // New York's next day after Sunday is Monday; Los Angeles's is Sunday (Saturday skipped)
    expect(await live(ny)).toMatchObject({ next_due_on: "2026-11-23", steps_sent: 1 });
    expect(await live(la)).toMatchObject({ next_due_on: "2026-11-22", steps_sent: 1 });

    // Saturday 21 Nov: nobody is due, nothing is queued
    const sat = await run("2026-11-21T12:00:00Z");
    expect(sat.due).toBe(0);
    expect(await outbox(ny)).toHaveLength(1);
    expect(await outbox(la)).toHaveLength(1);

    // Sunday 22 Nov: Los Angeles gets its Sunday row, New York already has its own and gets no second one
    await run("2026-11-22T12:00:00Z");
    expect((await outbox(la)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-20`, "2026-11-20T18:00:00.000Z"],
      [`bucket:${b}:daily:2026-11-22`, "2026-11-22T18:00:00.000Z"],
    ]);
    expect(await outbox(ny)).toHaveLength(1);
    expect(await live(la)).toMatchObject({ next_due_on: "2026-11-23", steps_sent: 2 });

    // no row in the whole outbox is dated or timed on a Saturday in its merchant's zone
    const all = await t.pool.query(
      `select 1 from outbox o join clients c on c.id = o.client_id
        where o.client_id in ($1, $2) and (o.source like '%:daily:2026-11-21'
              or extract(dow from o.not_before at time zone app.client_timezone(c)) = 6)`,
      [ny, la],
    );
    expect(all.rowCount).toBe(0);
  });

  it("a merchant who joins on a Saturday gets Sunday's reminder and nothing that day", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-21"); // enrolling makes the first reminder due today: a Saturday
    await run("2026-11-21T12:00:00Z");
    expect((await outbox(c)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-22`, "2026-11-22T15:00:00.000Z"],
    ]);
    expect(await live(c)).toMatchObject({ next_due_on: "2026-11-23", steps_sent: 1 });
  });

  it("a merchant who joins after the time gets tomorrow's slot", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    // 12:00 in New York: 10:00 has passed
    await run("2026-11-23T17:00:00Z");
    expect((await outbox(c)).map((r) => [r.source, iso(r.not_before), iso(r.expires_at)])).toEqual([
      [`bucket:${b}:daily:2026-11-24`, "2026-11-24T15:00:00.000Z", "2026-11-24T19:00:00.000Z"],
    ]);
    // the next run is the day after the slot's day, so Tuesday's reminder is not made twice
    expect(await live(c)).toMatchObject({ next_step: 1, next_due_on: "2026-11-25", steps_sent: 1 });
    await run("2026-11-24T12:00:00Z");
    expect(await outbox(c)).toHaveLength(1);
    await run("2026-11-25T12:00:00Z");
    expect((await outbox(c)).map((r) => iso(r.not_before))).toEqual([
      "2026-11-24T15:00:00.000Z",
      "2026-11-25T15:00:00.000Z",
    ]);
  });

  it("follows the shop's reminder time: changing it changes the next row's time", async () => {
    const b = await dailyBucket();
    const ny = await client(NY);
    const la = await client(LA);
    await enrolDue(ny, b, "2026-11-23");
    await enrolDue(la, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    expect(iso((await outbox(ny))[0]?.not_before ?? null)).toBe("2026-11-23T15:00:00.000Z");

    // the shop moves the time to 14:30 (870 minutes after midnight)
    await t.pool.query("update shop_settings set daily_reminder_minute = 870");
    await run("2026-11-24T12:00:00Z");
    expect((await outbox(ny)).map((r) => iso(r.not_before))).toEqual([
      "2026-11-23T15:00:00.000Z", // already queued at the old time: left alone
      "2026-11-24T19:30:00.000Z", // 14:30 EST
    ]);
    expect((await outbox(la)).map((r) => iso(r.not_before))).toEqual([
      "2026-11-23T18:00:00.000Z",
      "2026-11-24T22:30:00.000Z", // 14:30 PST
    ]);
    expect((await outbox(ny))[1]?.expires_at).toEqual(at("2026-11-24T23:30:00.000Z"));
  });

  it("a time that has already passed under the new setting moves the slot to tomorrow", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    await t.pool.query("update shop_settings set daily_reminder_minute = 360"); // 06:00
    // 08:00 EST: 06:00 has gone
    await run("2026-11-23T13:00:00Z");
    expect((await outbox(c)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-24`, "2026-11-24T11:00:00.000Z"],
    ]);
  });
});

describe("the daily reminder: holds and what it replaces", () => {
  it("a template that cannot auto-send is held: nothing queued, the member stays, tried again tomorrow", async () => {
    const tpl = await template({ approved: false });
    const b = await dailyBucket(tpl);
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");

    await run("2026-11-23T12:00:00Z");
    expect(await outbox(c)).toHaveLength(0);
    expect(await live(c)).toMatchObject({
      bucket_id: b,
      next_step: 1,
      next_due_on: "2026-11-24",
      steps_sent: 0,
      hold: true,
    });
    const notes = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like 'Bucket email on hold:%'",
      [c],
    );
    expect(notes.rows).toHaveLength(1);

    // a second day of the same hold adds no second note
    await run("2026-11-24T12:00:00Z");
    expect(await outbox(c)).toHaveLength(0);
    expect(
      (
        await t.pool.query(
          "select 1 from activities where client_id = $1 and body like 'Bucket email on hold:%'",
          [c],
        )
      ).rowCount,
    ).toBe(1);

    // approved: the next day's run queues the reminder and clears the hold
    await t.pool.query("update templates set approved = true where id = $1", [tpl]);
    await run("2026-11-25T12:00:00Z");
    expect((await outbox(c)).map((r) => [r.source, iso(r.not_before)])).toEqual([
      [`bucket:${b}:daily:2026-11-25`, "2026-11-25T15:00:00.000Z"],
    ]);
    expect(await live(c)).toMatchObject({ next_due_on: "2026-11-26", steps_sent: 1, hold: false });
  });

  it("a template held for three days is skipped for that day, and the member is still in the bucket", async () => {
    const tpl = await template({ approved: false });
    const b = await dailyBucket(tpl);
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    for (const d of ["23", "24", "25", "26"]) await run(`2026-11-${d}T12:00:00Z`);
    expect(await outbox(c)).toHaveLength(0);
    const e = await live(c);
    expect(e).toMatchObject({ bucket_id: b, steps_sent: 0 });
    expect(
      (
        await t.pool.query(
          "select 1 from activities where client_id = $1 and body like 'Bucket email skipped:%'",
          [c],
        )
      ).rowCount,
    ).toBe(1);
  });

  it("a merchant with no email address queues nothing but stays enrolled for tomorrow", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await t.pool.query("update clients set email = '' where id = $1", [c]);
    await enrolDue(c, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    expect(await outbox(c)).toHaveLength(0);
    expect(await live(c)).toMatchObject({ bucket_id: b, next_due_on: "2026-11-24", steps_sent: 0 });
  });

  it("a bucket with no daily template runs its steps as before (step source, 36 hours, the shared window)", async () => {
    const c = await client(NY);
    const interested = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]?.id as string;
    await enrolDue(c, interested, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    const rows = await outbox(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe(`bucket:${interested}:step:1`);
    expect(rows[0]?.source).not.toContain(":daily:");
    // in the shop's 9-11 window in the merchant's zone, not at the reminder time; expiry 36 hours after it
    expect(
      inSendWindow(rows[0]?.not_before as Date, {
        timezone: NY,
        startHour: 9,
        endHour: 11,
        weekends: false,
      }),
    ).toBe(true);
    expect((rows[0]?.expires_at?.getTime() ?? 0) - (rows[0]?.not_before.getTime() ?? 0)).toBe(
      36 * 3_600_000,
    );
    expect(await live(c)).toMatchObject({ bucket_id: interested, next_step: 2, steps_sent: 1 });
  });

  it("a daily bucket ignores its own call and move-to-Cold steps: the member is still in it after day 30", async () => {
    const tpl = await template();
    const b = await dailyBucket(tpl);
    await t.pool.query(
      `insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values
         ($1, 1, 0, $2, 'email'), ($1, 2, 1, null, 'call'), ($1, 3, 30, null, 'move_to_cold')`,
      [b, tpl],
    );
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    // she joined 40 days ago: the Cold step would long since have been due
    await t.pool.query("update enrollments set entered_at = $2 where client_id = $1", [
      c,
      "2026-10-14T12:00:00Z",
    ]);
    // run on consecutive days across the "call" day and well past day 30
    for (const d of ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]) {
      await run(`${d}T12:00:00Z`);
    }
    expect((await outbox(c)).map((r) => r.source)).toEqual([
      `bucket:${b}:daily:2026-11-23`,
      `bucket:${b}:daily:2026-11-24`,
      `bucket:${b}:daily:2026-11-25`,
      `bucket:${b}:daily:2026-11-26`,
    ]);
    expect(await live(c)).toMatchObject({ bucket_id: b, next_step: 1, steps_sent: 4 });
    // no call task was made and the member never moved to Cold
    expect(
      (await t.pool.query("select 1 from timers where client_id = $1 and note like 'Call:%'", [c]))
        .rowCount,
    ).toBe(0);
    const history = await t.pool.query<{ stop_reason: string | null; key: string | null }>(
      "select e.stop_reason, b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1",
      [c],
    );
    expect(history.rows).toEqual([{ stop_reason: null, key: null }]);
  });

  it("runs the daily template even when the sequence switch is off", async () => {
    await t.pool.query("update shop_settings set sequences_enabled = false");
    try {
      const b = await dailyBucket();
      const c = await client(NY);
      await enrolDue(c, b, "2026-11-23");
      await run("2026-11-23T12:00:00Z");
      await run("2026-11-24T12:00:00Z");
      expect((await outbox(c)).map((r) => r.source)).toEqual([
        `bucket:${b}:daily:2026-11-23`,
        `bucket:${b}:daily:2026-11-24`,
      ]);
      expect(await live(c)).toMatchObject({
        next_step: 1,
        next_due_on: "2026-11-25",
        steps_sent: 2,
      });
    } finally {
      await t.pool.query("update shop_settings set sequences_enabled = true");
    }
  });

  it("a paused member is not queued, and the first run after the pause queues that day's reminder", async () => {
    const b = await dailyBucket();
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    await t.pool.query(
      "update enrollments set paused = true where client_id = $1 and stopped_at is null",
      [c],
    );
    await run("2026-11-23T12:00:00Z");
    expect(await outbox(c)).toHaveLength(0);
    await t.pool.query(
      "update enrollments set paused = false where client_id = $1 and stopped_at is null",
      [c],
    );
    await run("2026-11-24T12:00:00Z");
    expect((await outbox(c)).map((r) => r.source)).toEqual([`bucket:${b}:daily:2026-11-24`]);
  });
});

describe("leaving a daily bucket", () => {
  it("moving the merchant to another bucket cancels the queued daily reminder", async () => {
    const b = await dailyBucket();
    const other = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'missing_app'")
    ).rows[0]?.id as string;
    const c = await client(NY);
    await enrolDue(c, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    expect((await outbox(c))[0]).toMatchObject({ status: "queued", skip_reason: null });

    await enrol(c, other);

    expect(await outbox(c)).toEqual([
      expect.objectContaining({
        source: `bucket:${b}:daily:2026-11-23`,
        lane: "sequence",
        status: "cancelled",
        skip_reason: "stopped",
      }),
    ]);
    const old = await t.pool.query<{ stopped_at: Date | null; stop_reason: string | null }>(
      "select stopped_at, stop_reason from enrollments where client_id = $1 and bucket_id = $2",
      [c, b],
    );
    expect(old.rows[0]?.stop_reason).toBe("moved");
    expect(old.rows[0]?.stopped_at).not.toBeNull();
    expect((await live(c))?.bucket_id).toBe(other);
    // and the daily bucket no longer queues anything for them
    await run("2026-11-24T12:00:00Z");
    expect((await outbox(c)).filter((r) => r.source.includes(":daily:2026-11-24"))).toHaveLength(0);
  });

  it("stopping the enrolment cancels the queued reminder too", async () => {
    const b = await dailyBucket();
    const c = await client(LA);
    await enrolDue(c, b, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    await t.db.withUser(rep, (q) => q.query("select stop_enrollment($1, 'removed')", [c]));
    expect((await outbox(c))[0]).toMatchObject({ status: "cancelled", skip_reason: "stopped" });
    expect(await live(c)).toBeUndefined();
  });

  it("moving into a daily bucket cancels the old bucket's queued step and makes the first reminder due today", async () => {
    const b = await dailyBucket();
    const interested = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]?.id as string;
    const c = await client(LA);
    await enrolDue(c, interested, "2026-11-23");
    await run("2026-11-23T12:00:00Z");
    expect((await outbox(c))[0]?.source).toBe(`bucket:${interested}:step:1`);

    await enrol(c, b);

    expect((await outbox(c))[0]).toMatchObject({ status: "cancelled", skip_reason: "stopped" });
    const e = (
      await t.pool.query<{ next_due_on: string; today: string; next_step: number }>(
        `select e.next_due_on::text, (now() at time zone app.client_timezone(c))::date::text as today, e.next_step
           from enrollments e join clients c on c.id = e.client_id
          where e.client_id = $1 and e.stopped_at is null`,
        [c],
      )
    ).rows[0];
    expect(e).toBeDefined();
    expect(e?.next_due_on).toBe(e?.today);
    expect(e?.next_step).toBe(1);
  });

  it("a non-daily bucket's first step is still due by its own day offset, not today (regression of the enrolment change)", async () => {
    const tpl = await template();
    n += 1;
    const b = (
      await t.pool.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule) values ($1, $2, 'manual') returning id",
        [`Plain bucket ${n}`, rep],
      )
    ).rows[0]?.id as string;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 3, $2)",
      [b, tpl],
    );
    const c = await client(NY);
    await enrol(c, b);
    const e = (
      await t.pool.query<{ next_due_on: string; expect: string }>(
        `select e.next_due_on::text, ((now() at time zone app.client_timezone(c))::date + 3)::text as expect
           from enrollments e join clients c on c.id = e.client_id
          where e.client_id = $1 and e.stopped_at is null`,
        [c],
      )
    ).rows[0];
    expect(e?.next_due_on).toBe(e?.expect);
  });
});
