/**
 * Round 4, the bucket engine. A step that cannot go out is held, never paused, and the hold is counted from when
 * the current hold began (enrollments.hold_since), proved in the database:
 *   - a template with a field that does not exist leaves the pause flag alone and ends by the same 3-day rule;
 *   - a second break of the same template gets its own note and its own clock;
 *   - an old, resolved hold never shortens a new one on a step that repeats (sequences off).
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

const BROKEN = "Hi {frist_name}, your link: {upload_link}";
const FIXED = "Hi {first_name}, your link: {upload_link}";

async function setup(opts: { body: string; approved?: boolean; steps?: number }) {
  n += 1;
  const tpl = (
    await t.pool.query<{ id: string }>(
      "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Hello', $3, $4) returning id",
      [rep, `R4 template ${n}`, opts.body, opts.approved ?? true],
    )
  ).rows[0]?.id as string;
  const b = (
    await t.pool.query<{ id: string }>(
      "insert into buckets (name, owner_id, rule) values ($1, $2, 'manual') returning id",
      [`R4 bucket ${n}`, rep],
    )
  ).rows[0]?.id as string;
  await t.pool.query(
    "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2)",
    [b, tpl],
  );
  if (opts.steps === 2) {
    const live = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, $2, 'Second', 'Next {business}', true) returning id",
        [rep, `R4 live ${n}`],
      )
    ).rows[0]?.id as string;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 2, 1, $2)",
      [b, live],
    );
  }
  const c = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Rosa Diaz', '3055550100', $3, 'FL') returning id",
      [rep, `R4 Shop ${n}`, `r4b${n}@x.com`],
    )
  ).rows[0]?.id as string;
  await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [c, b]));
  return { tpl, c };
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
const setBody = (tpl: string, body: string) =>
  t.pool.query("update templates set body = $2 where id = $1", [tpl, body]);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "update shop_settings set postal_address = '1 Main St', sequences_enabled = true",
  );
});
afterAll(async () => {
  await t.drop();
});

describe("a template with a field that does not exist", () => {
  it("holds the step without pausing the enrolment, and the 3-day limit moves the sequence on", async () => {
    const { c } = await setup({ body: BROKEN, steps: 2 });
    for (const d of [0, 1, 2]) {
      await go(d);
      // never paused (the flag is the rep's and the merchant's), stamped as held, nothing sent
      expect(await enrol(c)).toMatchObject({
        paused: false,
        next_step: 1,
        steps_sent: 0,
        hold: true,
      });
    }
    expect(await outboxCount(c)).toBe(0);
    const held = await notes(c, "Bucket email on hold%");
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("{frist_name}");

    // day 3: three days held, so step 1 is skipped and step 2 is next; the hold clock is cleared
    await go(3);
    expect(await enrol(c)).toMatchObject({
      paused: false,
      next_step: 2,
      steps_sent: 0,
      hold: false,
    });
    expect(await notes(c, "Bucket email skipped%")).toHaveLength(1);

    // day 4: step 2 goes out
    await go(4);
    expect(await outboxCount(c)).toBe(1);
  });

  it("goes out by itself once the template is fixed, with no one resuming anything", async () => {
    const { tpl, c } = await setup({ body: BROKEN });
    await go(0);
    expect(await outboxCount(c)).toBe(0);
    await setBody(tpl, FIXED);
    await go(1);
    expect(await outboxCount(c)).toBe(1);
    expect((await enrol(c))?.hold).toBe(false);
  });

  it("a rep's own pause is still a pause: the engine does not lift or set it", async () => {
    const { c } = await setup({ body: BROKEN });
    await t.pool.query("update enrollments set paused = true where client_id = $1", [c]);
    await go(0);
    expect(await enrol(c)).toMatchObject({ paused: true, hold: false });
  });

  it("a second break of the same template gets a new note and its own 3-day clock", async () => {
    // sequences off: the one step repeats daily, so the step number never changes
    await t.pool.query("update shop_settings set sequences_enabled = false");
    try {
      const { tpl, c } = await setup({ body: BROKEN });
      await go(0);
      expect(await notes(c, "Bucket email on hold%")).toHaveLength(1);
      await setBody(tpl, FIXED);
      await go(1); // sent: the hold is over
      expect(await outboxCount(c)).toBe(1);
      expect((await enrol(c))?.hold).toBe(false);
      await t.pool.query("delete from outbox where client_id = $1", [c]); // the pending copy of the step is gone
      await setBody(tpl, BROKEN);
      await go(2); // broken again
      expect(await notes(c, "Bucket email on hold%")).toHaveLength(2);
      // the new hold began on day 2: day 3 and day 4 are still holds, the skip is on day 5
      await go(3);
      await go(4);
      expect(await notes(c, "Bucket email skipped%")).toHaveLength(0);
      expect((await enrol(c))?.hold).toBe(true);
      await go(5);
      expect(await notes(c, "Bucket email skipped%")).toHaveLength(1);
    } finally {
      await t.pool.query("update shop_settings set sequences_enabled = true");
    }
  });
});

describe("the hold of a template that cannot send, on a step that repeats", () => {
  it("an old resolved hold does not make a new one hit the limit at once", async () => {
    await t.pool.query("update shop_settings set sequences_enabled = false");
    try {
      const { tpl, c } = await setup({ body: FIXED, approved: false });
      await go(0); // held: not approved
      expect(await notes(c, "Bucket email on hold%")).toHaveLength(1);
      await t.pool.query("update templates set approved = true where id = $1", [tpl]);
      await go(1); // sent
      expect(await outboxCount(c)).toBe(1);
      expect((await enrol(c))?.hold).toBe(false);
      await t.pool.query("delete from outbox where client_id = $1", [c]);
      await t.pool.query("update templates set approved = false where id = $1", [tpl]);
      await go(2); // held again: a new hold, a new note
      expect(await notes(c, "Bucket email on hold%")).toHaveLength(2);
      await go(3);
      await go(4);
      // three days from day 2 is day 5; before the fix the hold from day 0 made day 3 the limit
      expect(await notes(c, "Bucket email skipped%")).toHaveLength(0);
      expect(await outboxCount(c)).toBe(0);
      await go(5);
      expect(await notes(c, "Bucket email skipped%")).toHaveLength(1);
    } finally {
      await t.pool.query("update shop_settings set sequences_enabled = true");
    }
  });

  it("the limit is elapsed time from hold_since, not calendar dates", async () => {
    const { c } = await setup({ body: FIXED, approved: false, steps: 2 });
    await go(0);
    const h = (
      await t.pool.query<{ hold_since: Date }>(
        "select hold_since from enrollments where client_id = $1 and stopped_at is null",
        [c],
      )
    ).rows[0]?.hold_since;
    expect(h?.getTime()).toBe(day(0).getTime());
    await go(1);
    await go(2);
    expect((await enrol(c))?.next_step).toBe(1);
    await go(3);
    expect((await enrol(c))?.next_step).toBe(2);
    expect((await enrol(c))?.hold).toBe(false);
  });
});
