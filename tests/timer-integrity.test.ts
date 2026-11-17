import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
const d = (n: number) => addDays(t.today, n);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

const open = async (id: string) =>
  (
    await t.pool.query<{ kind: string; due_on: string }>(
      "select kind, due_on from timers where client_id = $1 and done_at is null order by due_on, kind",
      [id],
    )
  ).rows;
const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);

describe("a booked call cannot become a ghost", () => {
  const book = (id: string, hoursFromNow: number) =>
    t.pool.query(
      "update clients set scheduled_call_at = now() + make_interval(hours => $2) where id = $1",
      [id, hoursFromNow],
    );
  const addCallTimer = (id: string, due: string) =>
    t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'scheduled_call', $3)",
      [a, id, due],
    );

  it("logging a call near the booked time closes the booking and clears the time", async () => {
    const id = await insertClient(t.db, a, "Booked Done Co");
    await book(id, 1);
    await addCallTimer(id, d(0));
    await asA((q) =>
      q.query("select * from log_touch($1, 'call', 'reached', '', $2)", [id, d(14)]),
    );
    expect((await open(id)).map((x) => x.kind)).toEqual(["follow_up"]);
    expect(
      (await t.pool.query("select scheduled_call_at from clients where id = $1", [id])).rows[0]
        .scheduled_call_at,
    ).toBeNull();
  });
  it("a text or email does not count as the booked call", async () => {
    const id = await insertClient(t.db, a, "Booked Text Co");
    await book(id, 1);
    await addCallTimer(id, d(0));
    await asA((q) =>
      q.query("select * from log_touch($1, 'text', 'reached', '', $2)", [id, d(14)]),
    );
    expect((await open(id)).map((x) => x.kind).sort()).toEqual(["follow_up", "scheduled_call"]);
  });
  it("a call booked days from now survives an unrelated call", async () => {
    const id = await insertClient(t.db, a, "Booked Later Co");
    await book(id, 72);
    await addCallTimer(id, d(3));
    await asA((q) =>
      q.query("select * from log_touch($1, 'call', 'no_answer', '', $2)", [id, d(1)]),
    );
    expect((await open(id)).map((x) => x.kind).sort()).toEqual(["follow_up", "scheduled_call"]);
  });
  it("can be cancelled, leaving the client with a next date and a note in the timeline", async () => {
    const id = await insertClient(t.db, a, "Cancel Co");
    await book(id, 48);
    await addCallTimer(id, d(2));
    await asA((q) => q.query("select * from cancel_call($1)", [id]));
    expect((await open(id)).map((x) => x.kind)).toEqual(["follow_up"]);
    expect(
      (await t.pool.query("select scheduled_call_at from clients where id = $1", [id])).rows[0]
        .scheduled_call_at,
    ).toBeNull();
    const last = (
      await t.pool.query(
        "select body from activities where client_id = $1 order by occurred_at desc limit 1",
        [id],
      )
    ).rows[0];
    expect(last.body).toBe("Call cancelled");
  });
  it("cancelling when nothing is booked is harmless", async () => {
    const id = await insertClient(t.db, a, "Nothing Booked Co");
    await asA((q) => q.query("select * from cancel_call($1)", [id]));
    expect(await open(id)).toHaveLength(1);
  });
  it("a booking whose day has passed is closed when the client moves stage", async () => {
    const id = await insertClient(t.db, a, "Stale Booking Co");
    await book(id, -72);
    await addCallTimer(id, d(-3));
    await asA((q) =>
      q.query("select * from move_client($1, 'interested', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: d(2) }),
      ]),
    );
    expect((await open(id)).map((x) => x.kind)).toEqual(["follow_up"]);
  });
  it("another user cannot cancel my booking", async () => {
    const b = await insertUser(t.pool, "other@x.com");
    const id = await insertClient(t.db, a, "Mine Co");
    await book(id, 24);
    await addCallTimer(id, d(1));
    await expect(
      t.db.withUser(b, (q) => q.query("select * from cancel_call($1)", [id])),
    ).rejects.toThrow(/client not found/);
    expect((await open(id)).map((x) => x.kind).sort()).toEqual(["follow_up", "scheduled_call"]);
  });
});
