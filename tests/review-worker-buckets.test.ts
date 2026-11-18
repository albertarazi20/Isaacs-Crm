import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;

const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const enrolment = async (clientId: string) =>
  (
    await t.pool.query<{ next_step: number; steps_sent: number; stopped: boolean }>(
      "select next_step, steps_sent, stopped_at is not null as stopped from enrollments where client_id = $1 order by entered_at desc limit 1",
      [clientId],
    )
  ).rows[0];
const notes = async (clientId: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like 'Bucket email%' order by occurred_at, id",
      [clientId],
    )
  ).rows.map((r) => r.body);

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

describe("a step whose template cannot send", () => {
  it("is held for up to 3 days with one note, then skipped so the sequence moves on", async () => {
    const dead = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Dead', 'Hey', 'Body {business}', false) returning id",
        [rep],
      )
    ).rows[0]?.id;
    const live = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Live', 'Second', 'Body {business}', true) returning id",
        [rep],
      )
    ).rows[0]?.id;
    const b = (
      await t.pool.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule) values ('Held bucket', $1, 'manual') returning id",
        [rep],
      )
    ).rows[0]?.id;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2), ($1, 2, 1, $3)",
      [b, dead, live],
    );
    const id = (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Held Co', 'Mike', '3055550100', 'held@x.com', 'FL') returning id",
        [rep],
      )
    ).rows[0]?.id as string;
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b]));

    // days 0, 1, 2: held on step 1, nothing sent, nothing counted
    for (const n of [0, 1, 2]) {
      await runBucketSteps({ db: t.db, now: day(n), appUrl: "https://crm.test" });
      expect(await enrolment(id)).toMatchObject({ next_step: 1, steps_sent: 0, stopped: false });
    }
    const held = await notes(id);
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("on hold");

    // day 3: the cap is reached, so step 1 is skipped (not counted as sent) and step 2 is next
    await runBucketSteps({ db: t.db, now: day(3), appUrl: "https://crm.test" });
    expect(await enrolment(id)).toMatchObject({ next_step: 2, steps_sent: 0, stopped: false });
    const all = await notes(id);
    expect(all).toHaveLength(2);
    expect(all[1]).toContain("skipped");

    // day 4: step 2 (usable template) goes out
    await runBucketSteps({ db: t.db, now: day(4), appUrl: "https://crm.test" });
    const out = await t.pool.query<{ source: string }>(
      "select source from outbox where client_id = $1",
      [id],
    );
    expect(out.rows.map((r) => r.source.split(":").slice(-2).join(":"))).toEqual(["step:2"]);
  });
});
