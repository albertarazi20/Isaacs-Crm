import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserError } from "@/lib/data/mutations";
import { handOff, undoHandOff } from "@/lib/followup/handoff";
import { addDays } from "@/lib/mca/dates";
import { enqueueEmail } from "@/lib/send/enqueue";
import type { Lane } from "@/lib/send/rules";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The finish line (docs/FOLLOW-UP-SYSTEM.md, decision 1; db/migrations/0540): hand_off marks a merchant as brought
 * in and ends the chase; undo_hand_off takes it back. Every claim is read from the database.
 */

let t: TestDb;
let rep: string;
let other: string;
let manager: string;
let phone = 3055550100;

/** A merchant added as the rep, with its own phone number and one follow-up for tomorrow. */
const merchant = (userId: string, name: string) =>
  t.db.withUser(userId, async (q) => {
    phone += 1;
    const { rows } = await q.query<{ id: string }>(
      "select id from create_client($1::jsonb, $2::jsonb)",
      [
        JSON.stringify({
          business_name: name,
          contact_name: "Owner",
          phone: String(phone),
          email: `owner${phone}@x.com`,
          state: "FL",
        }),
        JSON.stringify([{ kind: "follow_up", due_on: addDays(t.today, 1) }]),
      ],
    );
    return rows[0]!.id;
  });
const bucket = async (key: string) =>
  (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!.id;
const queue = (clientId: string, source: string, lane: Lane) =>
  t.db.withUser(rep, async (q) => {
    const r = await enqueueEmail(q, {
      clientId,
      lane,
      source,
      subject: "Hello",
      text: "Checking in",
      when: "now",
    });
    // a row the database cancelled as it landed (a handed-off merchant) is still a row to read back
    if (r.queued || r.reason === "brought_in") return r.outboxId;
    throw new Error(`not queued: ${r.reason}`);
  });
const outbox = async (id: string) =>
  (
    await t.pool.query<{ status: string; skip_reason: string | null }>(
      "select status, skip_reason from outbox where id = $1",
      [id],
    )
  ).rows[0]!;
const mark = async (id: string) =>
  (
    await t.pool.query<{ at: Date | null; by: string | null }>(
      "select brought_in_at as at, brought_in_by as by from clients where id = $1",
      [id],
    )
  ).rows[0]!;
const lines = async (id: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' order by occurred_at",
      [id],
    )
  ).rows.map((r) => r.body);
const openTimers = async (id: string) =>
  (
    await t.pool.query<{ kind: string; due_on: string }>(
      "select kind, due_on from timers where client_id = $1 and done_at is null",
      [id],
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  other = await insertUser(t.pool, "other@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await t.pool.query("update app_users set name = 'Rita Rep' where id = $1", [rep]);
});
afterAll(async () => {
  await t.drop();
});

describe("hand_off", () => {
  it("marks the merchant, stops the enrolment, cancels queued automated mail, closes the timers, writes the timeline and tells the managers; a second call changes nothing", async () => {
    const id = await merchant(rep, "Complete File Co");
    const b = await bucket("ready_for_ops");
    await t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, b]));
    const step = await queue(id, `bucket:${b}:step:1`, "sequence");
    const blast = await queue(id, "blast:spring", "blast");
    const welcome = await queue(id, "intake", "intake");
    expect(await openTimers(id)).toHaveLength(1);

    const at = await t.db.withUser(rep, (q) => handOff(q, id));

    const m = await mark(id);
    expect(m.at?.toISOString()).toBe(at);
    expect(m.by).toBe(rep);
    const e = await t.pool.query<{ stop_reason: string | null; live: boolean }>(
      "select stop_reason, stopped_at is null as live from enrollments where client_id = $1",
      [id],
    );
    expect(e.rows).toEqual([{ stop_reason: "brought_in", live: false }]);
    expect(await outbox(step)).toMatchObject({ status: "cancelled" });
    expect(await outbox(blast)).toEqual({ status: "cancelled", skip_reason: "brought_in" });
    // a one-to-one email already on its way is not automated mail
    expect((await outbox(welcome)).status).toBe("queued");
    expect(await openTimers(id)).toEqual([]);
    const closed = await t.pool.query<{ done_reason: string }>(
      "select done_reason from timers where client_id = $1",
      [id],
    );
    expect(closed.rows).toEqual([{ done_reason: "completed" }]);
    expect((await lines(id)).filter((l) => l === "Handed off — brought in")).toHaveLength(1);
    const alerts = async () =>
      // entering Ready to hand off also wrote the rep's 'file_complete' alert (0543, tests/engine-fixes.test.ts)
      (
        await t.pool.query<{ user_id: string; kind: string; title: string; body: string }>(
          "select user_id, kind, title, body from user_alerts where client_id = $1 and kind = 'brought_in'",
          [id],
        )
      ).rows;
    expect(await alerts()).toEqual([
      {
        user_id: manager,
        kind: "brought_in",
        title: "Complete File Co was brought in",
        body: expect.stringContaining("by Rita Rep") as string,
      },
    ]);

    // idempotent: the first time stands, nothing is written twice — even when a manager presses it later
    const again = await t.db.withUser(manager, (q) => handOff(q, id));
    expect(again).toBe(at);
    expect((await mark(id)).by).toBe(rep);
    expect((await lines(id)).filter((l) => l === "Handed off — brought in")).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it("a brought-in merchant gets no automated mail again: a new sequence or blast row is cancelled as it is written", async () => {
    const id = await merchant(rep, "No More Mail Co");
    await t.db.withUser(rep, (q) => handOff(q, id));
    const b = await bucket("interested");
    expect(await outbox(await queue(id, `bucket:${b}:step:1`, "sequence"))).toEqual({
      status: "cancelled",
      skip_reason: "brought_in",
    });
    expect(await outbox(await queue(id, "blast:later", "blast"))).toEqual({
      status: "cancelled",
      skip_reason: "brought_in",
    });
    // the worker's "try again later" cannot put one back either
    const row = await queue(id, "intake", "intake");
    await t.pool.query("update outbox set lane = 'sequence', status = 'sending' where id = $1", [
      row,
    ]);
    await t.pool.query("update outbox set status = 'queued' where id = $1", [row]);
    expect((await outbox(row)).status).toBe("cancelled");
    // a merchant who was not handed off is untouched
    const live = await merchant(rep, "Still Chasing Co");
    expect((await outbox(await queue(live, `bucket:${b}:step:1`, "sequence"))).status).toBe(
      "queued",
    );
  });

  it("another rep cannot hand off a merchant that is not theirs; a manager can", async () => {
    const id = await merchant(rep, "Not Yours Co");
    await expect(t.db.withUser(other, (q) => handOff(q, id))).rejects.toThrow(UserError);
    await expect(t.db.withUser(other, (q) => undoHandOff(q, id))).rejects.toThrow(UserError);
    expect(await mark(id)).toEqual({ at: null, by: null });
    expect(await lines(id)).not.toContain("Handed off — brought in");
    expect(await openTimers(id)).toHaveLength(1);

    await t.db.withUser(manager, (q) => handOff(q, id));
    expect((await mark(id)).by).toBe(manager);
  });

  it("a merchant in the trash is refused in plain words", async () => {
    const id = await merchant(rep, "Trashed Co");
    await t.db.withUser(rep, (q) => q.query("select trash_client($1)", [id]));
    await expect(t.db.withUser(rep, (q) => handOff(q, id))).rejects.toThrow(/in the trash/);
    expect((await mark(id)).at).toBeNull();
  });
});

describe("undo_hand_off", () => {
  it("clears the mark, writes the timeline and puts the merchant back in the bucket the hand-off stopped (0546)", async () => {
    const id = await merchant(rep, "Changed Mind Co");
    await t.db.withUser(rep, (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        id,
      ]),
    );
    const at = await t.db.withUser(rep, (q) => handOff(q, id));
    const undone = await t.db.withUser(rep, (q) => undoHandOff(q, id));
    expect(undone).toEqual({ undone: at, bucket: "Interested" });
    expect(await mark(id)).toEqual({ at: null, by: null });
    expect(await lines(id)).toContain("Hand-off undone");
    // back in the bucket, so no stand-in follow-up for tomorrow (the hand-off closed the one it had)
    expect(await openTimers(id)).toEqual([]);
    const live = await t.pool.query<{ key: string }>(
      `select b.key from enrollments e join buckets b on b.id = e.bucket_id
        where e.client_id = $1 and e.stopped_at is null`,
      [id],
    );
    expect(live.rows).toEqual([{ key: "interested" }]);
    // nothing to undo the second time
    expect(await t.db.withUser(rep, (q) => undoHandOff(q, id))).toEqual({
      undone: null,
      bucket: null,
    });
    expect((await lines(id)).filter((l) => l === "Hand-off undone")).toHaveLength(1);
    // and automated mail may reach the merchant again
    const b = await bucket("interested");
    expect((await outbox(await queue(id, `bucket:${b}:step:1`, "sequence"))).status).toBe("queued");
  });

  it("a merchant who was in no bucket gets one follow-up for tomorrow instead", async () => {
    const id = await merchant(rep, "No Bucket Co");
    await t.db.withUser(rep, (q) => handOff(q, id));
    expect(await t.db.withUser(rep, (q) => undoHandOff(q, id))).toMatchObject({ bucket: null });
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: addDays(t.today, 1) }]);
    const live = await t.pool.query(
      "select 1 from enrollments where client_id = $1 and stopped_at is null",
      [id],
    );
    expect(live.rowCount).toBe(0);
  });
});

describe("migration 0540", () => {
  it("the new functions are SECURITY DEFINER with a pinned search_path, for isaac_app and not PUBLIC", async () => {
    const { rows } = await t.pool.query<{
      name: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      app_may: boolean;
      public_may: boolean;
    }>(
      `select p.proname as name, p.prosecdef, p.proconfig,
              has_function_privilege('isaac_app', p.oid, 'execute') as app_may,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_may
         from pg_proc p
        where p.proname in ('hand_off', 'undo_hand_off', 'outbox_skips_brought_in')
        order by p.proname`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      "hand_off",
      "outbox_skips_brought_in",
      "undo_hand_off",
    ]);
    for (const r of rows) {
      expect(r.prosecdef, r.name).toBe(true);
      expect(r.proconfig?.join(","), r.name).toMatch(/search_path=public, pg_temp/);
      expect(r.app_may, r.name).toBe(true);
      expect(r.public_may, r.name).toBe(false);
    }
  });

  it("the ready bucket reads 'Ready to hand off' and Cold has its 30/60/90-day nudge back", async () => {
    const b = await t.pool.query<{ key: string; name: string }>(
      "select key, name from buckets where key = 'ready_for_ops'",
    );
    expect(b.rows).toEqual([{ key: "ready_for_ops", name: "Ready to hand off" }]);
    const steps = await t.pool.query<{ day_offset: number; action: string; template: string }>(
      `select s.day_offset, s.action, t.name as template
         from bucket_steps s join buckets b on b.id = s.bucket_id join templates t on t.id = s.template_id
        where b.key = 'cold' order by s.step_no`,
    );
    expect(steps.rows).toEqual(
      [30, 60, 90].map((day_offset) => ({
        day_offset,
        action: "email",
        template: "Cold — monthly nudge",
      })),
    );
  });

  it("a document arriving after the hand-off does not put the merchant back in a bucket", async () => {
    const id = await merchant(rep, "Late Paper Co");
    await t.db.withUser(rep, (q) => handOff(q, id));
    await t.pool.query(
      "insert into stips (user_id, client_id, kind, required) values ($1, $2, 'signed_application', true)",
      [rep, id],
    );
    const live = await t.pool.query(
      "select 1 from enrollments where client_id = $1 and stopped_at is null",
      [id],
    );
    expect(live.rowCount).toBe(0);
  });
});
