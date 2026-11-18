/**
 * Round 5, the bucket engine. A template whose merge field is blank for this merchant ({first_name} with no contact
 * name) is held like any other step that cannot go out today: the pause flag (the rep's, the merchant's) is never
 * set, the timeline says why once, the step is retried daily (the field may get filled in), and the 3-day limit
 * moves the sequence on. Proved in the database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let n = 0;
const APP = "https://crm.test";
const base = Date.now();
const day = (d: number) => new Date(base + d * 86_400_000);
const go = (d: number) => runBucketSteps({ db: t.db, now: day(d), appUrl: APP });

async function setup(opts: { contact: string; steps?: number }) {
  n += 1;
  const tpl = (
    await t.pool.query<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Hello', 'Hi {first_name}, your link: {upload_link}', true) returning id",
      [rep, `R5 template ${n}`],
    )
  ).rows[0]?.id as string;
  const b = (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule) values ($1, $2, 'manual') returning id",
      [`R5 bucket ${n}`, rep],
    )
  ).rows[0]?.id as string;
  await t.pool.query(
    "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2)",
    [b, tpl],
  );
  if (opts.steps === 2) {
    const next = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Second', 'Next {business}', true) returning id",
        [rep, `R5 second ${n}`],
      )
    ).rows[0]?.id as string;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 2, 1, $2)",
      [b, next],
    );
  }
  const c = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, $3, '3055550100', $4, 'FL') returning id",
      [rep, `R5 Shop ${n}`, opts.contact, `r5b${n}@x.com`],
    )
  ).rows[0]?.id as string;
  await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [c, b]));
  return c;
}
const enrol = async (c: string) =>
  (
    await t.pool.query<{
      paused: boolean;
      next_step: number;
      steps_sent: number;
      hold: boolean;
      due: string;
    }>(
      `select paused, next_step, steps_sent, hold_since is not null as hold, next_due_on::text as due
         from enrollments where client_id = $1 and stopped_at is null`,
      [c],
    )
  ).rows[0];
const notes = async (c: string, like: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like $2 order by occurred_at, id",
      [c, like],
    )
  ).rows.map((r) => r.body);
const outboxCount = async (c: string) =>
  Number((await t.pool.query("select count(*) n from outbox where client_id = $1", [c])).rows[0].n);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep5@x.com", "America/New_York");
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St', sequences_enabled = true",
  );
});
afterAll(async () => {
  await t.drop();
});

describe("a template with a blank merge field", () => {
  it("holds the step without pausing, notes it once, and the 3-day limit moves the sequence on", async () => {
    const c = await setup({ contact: "", steps: 2 });
    for (const d of [0, 1, 2]) {
      await go(d);
      expect(await enrol(c)).toMatchObject({
        paused: false,
        next_step: 1,
        steps_sent: 0,
        hold: true,
        due: day(d + 1)
          .toISOString()
          .slice(0, 10),
      });
    }
    expect(await outboxCount(c)).toBe(0);
    const held = await notes(c, "Bucket email on hold%");
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("first_name");
    expect(await notes(c, "Bucket email paused%")).toHaveLength(0);

    await go(3); // three days held: step 1 is skipped, step 2 is next
    expect(await enrol(c)).toMatchObject({ paused: false, next_step: 2, hold: false });
    expect(await notes(c, "Bucket email skipped%")).toHaveLength(1);
    await go(4);
    expect(await outboxCount(c)).toBe(1);
  });

  it("goes out by itself the next day once the merchant's name is filled in", async () => {
    const c = await setup({ contact: "" });
    await go(0);
    expect(await outboxCount(c)).toBe(0);
    await t.pool.query("update clients set contact_name = 'Rosa Diaz' where id = $1", [c]);
    await go(1);
    expect(await outboxCount(c)).toBe(1);
    expect(await enrol(c)).toMatchObject({ paused: false, hold: false });
  });
});
