import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import { newClientSchema } from "@/lib/data/schemas";
import { loadCloseOfDay, loadStreak } from "@/lib/data/streak";
import { addDays } from "@/lib/mca/dates";
import { buildStreak } from "@/lib/mca/streak";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// 2026-10-23 is a Friday.
const TODAY = "2026-10-23";
const day = (n: number) => addDays(TODAY, n);

describe("buildStreak", () => {
  it("counts clean business days back from the last finished one", () => {
    const s = buildStreak(
      [
        { day: day(-4), open: 3 }, // Mon, unclean
        { day: day(-3), open: 0 }, // Tue
        { day: day(-2), open: 0 }, // Wed
        { day: day(-1), open: 0 }, // Thu
      ],
      TODAY,
      2,
    );
    expect(s).toEqual({ current: 3, best: 3, openNow: 2, empty: false });
  });
  it("an unclean day resets it, and best remembers the longest run", () => {
    const s = buildStreak(
      [
        { day: "2026-10-12", open: 0 },
        { day: "2026-10-13", open: 0 },
        { day: "2026-10-14", open: 0 },
        { day: "2026-10-15", open: 4 },
        { day: "2026-10-16", open: 0 },
      ],
      "2026-10-19",
      0,
    );
    expect(s).toMatchObject({ current: 1, best: 3 });
  });
  it("weekends neither break nor extend a streak", () => {
    // Fri 16th clean, Sat 17th and Sun 18th unclean, Mon 19th clean.
    const s = buildStreak(
      [
        { day: "2026-10-16", open: 0 },
        { day: "2026-10-17", open: 5 },
        { day: "2026-10-18", open: 5 },
        { day: "2026-10-19", open: 0 },
      ],
      "2026-10-20",
      0,
    );
    expect(s.current).toBe(2);
  });
  it("today is never counted, however clean it looks", () => {
    expect(buildStreak([{ day: TODAY, open: 0 }], TODAY, 0)).toMatchObject({
      current: 0,
      empty: true,
    });
  });
  it("is empty when nothing has been measured", () => {
    expect(buildStreak([], TODAY, 0).empty).toBe(true);
  });
  it("does not depend on the order the days arrive in", () => {
    const a = [
      { day: "2026-10-14", open: 0 },
      { day: "2026-10-15", open: 0 },
      { day: "2026-10-16", open: 3 },
    ];
    expect(buildStreak([...a].reverse(), "2026-10-19", 0)).toEqual(buildStreak(a, "2026-10-19", 0));
  });
});

describe("loadCloseOfDay, from a real database", () => {
  let t: TestDb;
  let a: string;
  let b: string;
  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com", "UTC");
    b = await insertUser(t.pool, "other@x.com", "UTC");
  });
  afterAll(async () => {
    await t.drop();
  });

  const ctx = () => ({ today: t.today, timezone: "UTC" });
  const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
    t.db.withUser(a, fn);

  it("counts a timer open on the days it was overdue and not after it was handled", async () => {
    const c = await asA((q) =>
      m.createClient(q, newClientSchema.parse({ businessName: "Streak Pizza" }), ctx()),
    );
    // Pretend it was created and due three days ago, then handled yesterday.
    await t.pool.query(
      `update timers set due_on = current_date - 3, created_at = now() - interval '5 days' where client_id = $1 and done_at is null`,
      [c.id],
    );
    await t.pool.query(
      "update activities set occurred_at = now() - interval '5 days' where client_id = $1",
      [c.id],
    );
    await t.pool.query(
      "update timers set done_at = now() - interval '1 day', done_reason = 'completed' where client_id = $1 and done_at is null",
      [c.id],
    );
    // Whatever the handled timer's replacement was is irrelevant: remove it so only this timer is measured.
    await t.pool.query("delete from timers where client_id = $1 and done_at is null", [c.id]);
    const days = await asA((q) => loadCloseOfDay(q, t.today, "UTC"));
    const byDay = new Map(days.map((d) => [d.day, d.open]));
    expect(byDay.get(addDays(t.today, -4))).toBe(0); // not due yet
    expect(byDay.get(addDays(t.today, -3))).toBe(1); // due, open at close
    expect(byDay.get(addDays(t.today, -2))).toBe(1);
    expect(byDay.get(addDays(t.today, -1))).toBe(0); // handled that day, so not open at its close
  });

  it("starts at the first follow-up ever created, not before", async () => {
    const days = await asA((q) => loadCloseOfDay(q, t.today, "UTC"));
    expect(days[0]?.day).toBe(addDays(t.today, -5));
  });

  it("another user's follow-ups never count", async () => {
    const c = await t.db.withUser(b, (q) =>
      m.createClient(q, newClientSchema.parse({ businessName: "Other Pizza" }), {
        today: t.today,
        timezone: "UTC",
      }),
    );
    await t.pool.query(
      "update timers set due_on = current_date - 1 where client_id = $1 and done_at is null",
      [c.id],
    );
    const mine = await asA((q) => loadCloseOfDay(q, t.today, "UTC"));
    expect(mine.find((d) => d.day === addDays(t.today, -1))?.open).toBe(0);
  });

  it("loadStreak puts the pieces together", async () => {
    const s = await asA((q) => loadStreak(q, t.today, "UTC"));
    expect(s.openNow).toBeGreaterThanOrEqual(0);
    expect(typeof s.current).toBe("number");
  });
});
