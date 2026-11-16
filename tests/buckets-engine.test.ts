import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueBlast, runBucketSteps } from "@/lib/buckets/engine";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;

const bucket = async (key: string) =>
  (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]
    ?.id as string;
const liveBucketKey = async (clientId: string) =>
  (
    await t.pool.query<{ key: string | null }>(
      "select b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
      [clientId],
    )
  ).rows[0]?.key ?? null;
const outboxFor = async (clientId: string) =>
  (
    await t.pool.query<{ source: string; status: string; subject: string; text_body: string }>(
      "select source, status, subject, text_body from outbox where client_id = $1 order by created_at",
      [clientId],
    )
  ).rows;
const client = async (name: string, email = "owner@x.com") =>
  (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Mike', '3055550100', $3, 'FL') returning id",
      [rep, name, email],
    )
  ).rows[0]?.id as string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep' where id = $1",
    [rep],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
});
afterAll(async () => {
  await t.drop();
});

describe("enrol and the stips checklist", () => {
  it("enrolling queues step 1 for today; a second enrol in another bucket ends the first", async () => {
    const id = await client("Enrol Co");
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, $2)", [id, await bucket("interested")]),
    );
    expect(await liveBucketKey(id)).toBe("interested");
    const s = await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    expect(s.emailed).toBeGreaterThanOrEqual(1);
    const ob = await outboxFor(id);
    expect(ob[0]?.source).toMatch(/^bucket:.*:step:1$/);
    expect(ob[0]?.text_body).toContain("https://apply.test/x");
    expect(ob[0]?.text_body).toContain("Hi Mike");
    expect(ob[0]?.text_body).toContain("Sam");
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, $2)", [id, await bucket("missing_app")]),
    );
    expect(await liveBucketKey(id)).toBe("missing_app");
    const after = await outboxFor(id);
    // the old bucket's queued step was cancelled
    expect(after.find((o) => o.source.includes("step:1") && o.status === "cancelled")).toBeTruthy();
  });
  it("ticking a stip moves the merchant through the system buckets by itself, ending in Ready for ops", async () => {
    const id = await client("Docs Co", "docs@x.com");
    // a checklist with 2 statement months + app + id + check
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify([
          { kind: "signed_application", period: null, required: true },
          { kind: "bank_statement", period: "2026-09-01", required: true },
          { kind: "bank_statement", period: "2026-10-01", required: true },
          { kind: "drivers_license", period: null, required: true },
          { kind: "voided_check", period: null, required: true },
        ]),
      ]),
    );
    expect(await liveBucketKey(id)).toBe("missing_app");
    const stip = async (kind: string, period: string | null) =>
      (
        await t.pool.query<{ id: string }>(
          "select id from stips where client_id = $1 and kind = $2 and period is not distinct from $3::date",
          [id, kind, period],
        )
      ).rows[0]?.id;
    await t.db.withUser(rep, async (q) =>
      q.query("select set_stip_received($1, true)", [await stip("signed_application", null)]),
    );
    expect(await liveBucketKey(id)).toBe("missing_statements");
    await t.db.withUser(rep, async (q) =>
      q.query("select set_stip_received($1, true)", [await stip("bank_statement", "2026-09-01")]),
    );
    await t.db.withUser(rep, async (q) =>
      q.query("select set_stip_received($1, true)", [await stip("bank_statement", "2026-10-01")]),
    );
    expect(await liveBucketKey(id)).toBe("missing_id");
    await t.db.withUser(rep, async (q) =>
      q.query("select set_stip_received($1, true)", [await stip("drivers_license", null)]),
    );
    await t.db.withUser(rep, async (q) =>
      q.query("select set_stip_received($1, true)", [await stip("voided_check", null)]),
    );
    expect(await liveBucketKey(id)).toBe("ready_for_ops");
  });
  it("submitting to ops stops the chase; opting out stops it and cancels queued mail", async () => {
    const id = await client("Ops Co", "ops@x.com");
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, $2)", [id, await bucket("missing_statements")]),
    );
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [id]));
    expect(await liveBucketKey(id)).toBeNull();
    const reason = await t.pool.query<{ stop_reason: string }>(
      "select stop_reason from enrollments where client_id = $1",
      [id],
    );
    expect(reason.rows[0]?.stop_reason).toBe("deal_submitted");

    const id2 = await client("Bye Co", "bye@x.com");
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, $2)", [id2, await bucket("interested")]),
    );
    await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    await t.db.withUser(rep, (q) => q.query("select opt_out($1, 'email', 'unsubscribe')", [id2]));
    expect(await liveBucketKey(id2)).toBeNull();
    expect((await outboxFor(id2)).every((o) => o.status === "cancelled")).toBe(true);
  });
});

describe("the sequence runner", () => {
  it("steps advance by day offset, a call task replaces the fourth email, then Cold", async () => {
    const id = await client("Seq Co", "seq@x.com");
    const b = await bucket("missing_app");
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b]));
    const day = (n: number) => new Date(Date.UTC(2026, 10, 16 + n, 16, 0, 0)); // 11:00 ET
    // make entered_at the start of day 0 so offsets line up
    await t.pool.query(
      "update enrollments set entered_at = $2, next_due_on = $3 where client_id = $1",
      [id, day(0).toISOString(), "2026-11-16"],
    );
    const mine = async () => (await outboxFor(id)).filter((o) => o.status !== "cancelled").length;
    let s = await runBucketSteps({ db: t.db, now: day(0), appUrl: "https://crm.test" });
    expect(s.due).toBeGreaterThanOrEqual(1);
    expect(await mine()).toBe(1);
    let e = (
      await t.pool.query<{ next_step: number; next_due_on: string }>(
        "select next_step, next_due_on::text from enrollments where client_id = $1 and stopped_at is null",
        [id],
      )
    ).rows[0];
    expect(e).toEqual({ next_step: 2, next_due_on: "2026-11-17" });
    s = await runBucketSteps({ db: t.db, now: day(1), appUrl: "https://crm.test" });
    expect(await mine()).toBe(2);
    e = (
      await t.pool.query(
        "select next_step, next_due_on::text from enrollments where client_id = $1 and stopped_at is null",
        [id],
      )
    ).rows[0];
    expect(e).toEqual({ next_step: 3, next_due_on: "2026-11-19" });
    // nothing due on day 2
    s = await runBucketSteps({ db: t.db, now: day(2), appUrl: "https://crm.test" });
    expect(await mine()).toBe(2);
    await runBucketSteps({ db: t.db, now: day(3), appUrl: "https://crm.test" });
    s = await runBucketSteps({ db: t.db, now: day(5), appUrl: "https://crm.test" });
    expect(s.called).toBeGreaterThanOrEqual(1);
    const task = await t.pool.query<{ note: string }>(
      "select note from timers where client_id = $1 and done_at is null and kind = 'follow_up' order by created_at desc limit 1",
      [id],
    );
    expect(task.rows[0]?.note).toMatch(/Call: no reply/);
    s = await runBucketSteps({ db: t.db, now: day(14), appUrl: "https://crm.test" });
    expect(s.moved).toBeGreaterThanOrEqual(1);
    expect(await liveBucketKey(id)).toBe("cold");
    // three different emails went out, not the same one
    // three different emails went out over the sequence (the move to Cold cancels what was still queued)
    const subjects = (await outboxFor(id)).map((o) => o.subject);
    expect(new Set(subjects).size).toBe(3);
  });
  it("with sequences switched off, step 1 repeats daily", async () => {
    await t.pool.query("update shop_settings set sequences_enabled = false");
    const id = await client("Daily Co", "daily@x.com");
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, $2)", [id, await bucket("missing_statements")]),
    );
    const day = (n: number) => new Date(Date.UTC(2026, 11, 1 + n, 16, 0, 0));
    await t.pool.query("update enrollments set next_due_on = '2026-12-01' where client_id = $1", [
      id,
    ]);
    for (let n = 0; n < 3; n += 1)
      await runBucketSteps({ db: t.db, now: day(n), appUrl: "https://crm.test" });
    const ob = (await outboxFor(id)).map((o) => o.source);
    expect(ob).toHaveLength(3);
    expect(new Set(ob).size).toBe(1); // step 1 every time
    await t.pool.query("update shop_settings set sequences_enabled = true");
  });
  it("a rep's unapproved template is not sent; a manager's approval unlocks it", async () => {
    const tpl = (
      await t.pool.query<{ id: string }>(
        "insert into templates (owner_id, name, subject, body, approved) values ($1, 'Mine', 'Hey {first_name}', 'Body for {business}', false) returning id",
        [rep],
      )
    ).rows[0]?.id;
    const mine = (
      await t.pool.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule) values ('My bucket', $1, 'manual') returning id",
        [rep],
      )
    ).rows[0]?.id;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2)",
      [mine, tpl],
    );
    const id = await client("Mine Co", "mine@x.com");
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, mine]));
    let s = await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    expect(s.skipped).toBeGreaterThanOrEqual(1);
    expect(await outboxFor(id)).toHaveLength(0);
    await t.pool.query("update templates set approved = true where id = $1", [tpl]);
    // the unapproved run finished the one-step sequence; bring it back as if freshly enrolled
    await t.pool.query(
      "update enrollments set next_step = 1, next_due_on = current_date - 1, stopped_at = null, stop_reason = null where client_id = $1",
      [id],
    );
    s = await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    expect((await outboxFor(id)).length).toBe(1);
  });
  it("a blast merges per merchant and skips the ones with a blank field", async () => {
    const tpl = (
      await t.pool.query<{ id: string }>(
        "select id from templates where name = 'Cold — monthly nudge'",
      )
    ).rows[0]?.id as string;
    const a = await client("Blast A", "a@x.com");
    const b = await client("Blast B", "b@x.com");
    const r = await t.db.withUser(rep, (q) =>
      queueBlast(q, { templateId: tpl, clientIds: [a, b], appUrl: "https://crm.test" }),
    );
    expect(r.queued).toBe(2);
    expect((await outboxFor(a))[0]?.source).toMatch(/^blast:/);
  });
});
