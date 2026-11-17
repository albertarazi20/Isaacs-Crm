import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMoves,
  bulkReschedule,
  clientDirectory,
  followUpReasons,
  snoozeCounts,
  snoozeWithReason,
} from "@/lib/data/overdue";
import { businessDaySlots, MAX_BULK } from "@/lib/data/priority";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
const today = () => t.today;
const ctx = () => ({ today: t.today, timezone: "UTC" });
const d = (days: number) => addDays(today(), days);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com");
  b = await insertUser(t.pool, "other@x.com");
});
afterAll(async () => {
  await t.drop();
});

interface Seed {
  user: string;
  name: string;
  stage?: string;
  contactStatus?: string;
  wanted?: number;
  timers: { kind: string; due: string; note?: string }[];
}

/** Direct inserts (the owner connection): the test controls dates the app's own functions would refuse. */
async function seed(s: Seed): Promise<string> {
  const { rows } = await t.pool.query<{ id: string }>(
    "insert into clients (user_id, business_name, stage, contact_status) values ($1, $2, $3, $4) returning id",
    [s.user, s.name, s.stage ?? "interested", s.contactStatus ?? "ok"],
  );
  const id = rows[0]?.id as string;
  for (const x of s.timers) {
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on, note) values ($1, $2, $3, $4, $5)",
      [s.user, id, x.kind, x.due, x.note ?? ""],
    );
  }
  if (s.wanted) {
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, $3)",
      [s.user, id, s.wanted],
    );
  }
  return id;
}

const openTimers = async (clientId: string) =>
  (
    await t.pool.query<{ kind: string; due_on: string; note: string }>(
      "select kind, due_on::text, note from timers where client_id = $1 and done_at is null order by due_on, kind",
      [clientId],
    )
  ).rows;

const bulkActivities = async (clientId: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'timer' and body like '%Rescheduled in bulk'",
      [clientId],
    )
  ).rows;

const snapshot = async (userId: string) =>
  (
    await t.pool.query(
      `select t.client_id, t.kind, t.due_on::text, t.done_at is null as open, t.note
         from timers t where t.user_id = $1 order by t.client_id, t.kind, t.due_on, t.created_at`,
      [userId],
    )
  ).rows;

describe("bulk reschedule: the database really moves", () => {
  const ids: Record<string, string> = {};
  let otherBefore: unknown;
  let otherActivitiesBefore: number;

  beforeAll(async () => {
    // --- A: three clients that should move, ranked by money
    ids.big = await seed({
      user: a,
      name: "Big Deal",
      wanted: 9_000_000,
      timers: [{ kind: "follow_up", due: d(-3) }],
    });
    ids.mid = await seed({
      user: a,
      name: "Mid Deal",
      wanted: 4_000_000,
      timers: [{ kind: "follow_up", due: d(-10) }],
    });
    ids.small = await seed({
      user: a,
      name: "Small Fry",
      stage: "name_in",
      wanted: 500_000,
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    // --- A: the ones that must NOT move
    ids.underwriting = await seed({
      user: a,
      name: "Contract Out",
      stage: "contract_out",
      wanted: 6_000_000,
      timers: [{ kind: "follow_up", due: d(-2) }],
    });
    ids.dnc = await seed({
      user: a,
      name: "Do Not Call",
      contactStatus: "dnc",
      wanted: 99_000_000,
      timers: [{ kind: "follow_up", due: d(-5) }],
    });
    ids.ghost = await seed({
      user: a,
      name: "Booked Call Passed",
      timers: [{ kind: "scheduled_call", due: d(-1) }],
    });
    ids.hiddenGhost = await seed({
      user: a,
      name: "Follow Up Plus Passed Call",
      timers: [
        { kind: "follow_up", due: d(-2) },
        { kind: "scheduled_call", due: d(-1) },
      ],
    });
    ids.future = await seed({
      user: a,
      name: "Future",
      timers: [{ kind: "follow_up", due: d(10) }],
    });
    ids.dueToday = await seed({
      user: a,
      name: "Due Today",
      timers: [{ kind: "follow_up", due: d(0) }],
    });
    // --- B: someone else's overdue pile
    for (const n of ["B One", "B Two", "B Three"]) {
      await seed({
        user: b,
        name: n,
        wanted: 90_000_000,
        timers: [{ kind: "follow_up", due: d(-4) }],
      });
    }
    otherBefore = await snapshot(b);
    otherActivitiesBefore = (
      await t.pool.query("select count(*)::int as n from activities where user_id = $1", [b])
    ).rows[0].n;
  });

  it("spreads the overdue clients over the next business days, biggest deal first", async () => {
    const result = await t.db.withUser(a, (q) =>
      bulkReschedule(q, ctx(), { days: 5, keepApplicationIn: true }),
    );
    expect(result).toMatchObject({ moved: 3, keptApplicationIn: 1, needHands: 2, overCap: 0 });

    const slots = businessDaySlots(today(), 5);
    expect(result.perDay).toEqual(slots.slice(0, 3).map((date) => ({ date, count: 1 })));

    // $90k interested > $40k interested > $5k name-in.
    const order = ["big", "mid", "small"];
    for (const [i, key] of order.entries()) {
      const timers = await openTimers(ids[key] as string);
      expect(
        timers.filter((x) => x.kind === "follow_up"),
        key,
      ).toEqual([{ kind: "follow_up", due_on: slots[i], note: "Rescheduled in bulk" }]);
    }
  });

  it("closes the old follow-up as replaced and writes one 'Rescheduled in bulk' timeline entry each", async () => {
    const { rows } = await t.pool.query(
      "select done_reason from timers where client_id = $1 and kind = 'follow_up' and done_at is not null",
      [ids.big],
    );
    expect(rows).toEqual([{ done_reason: "replaced" }]);
    for (const key of ["big", "mid", "small"]) {
      const acts = await bulkActivities(ids[key] as string);
      expect(acts, key).toHaveLength(1);
      expect(acts[0]?.body).toMatch(
        /^Follow up set for [A-Z][a-z]{2} \d{1,2}, \d{4} — Rescheduled in bulk$/,
      );
    }
  });

  it("leaves underwriting, do-not-contact, booked-call and untouched clients exactly as they were", async () => {
    expect(await openTimers(ids.underwriting as string)).toEqual([
      { kind: "follow_up", due_on: d(-2), note: "" },
    ]);
    expect(await openTimers(ids.dnc as string)).toEqual([
      { kind: "follow_up", due_on: d(-5), note: "" },
    ]);
    expect(await openTimers(ids.ghost as string)).toEqual([
      { kind: "scheduled_call", due_on: d(-1), note: "" },
    ]);
    // set_follow_up would have replaced the follow-up yet left the passed call overdue: so it is skipped whole.
    expect(await openTimers(ids.hiddenGhost as string)).toEqual([
      { kind: "follow_up", due_on: d(-2), note: "" },
      { kind: "scheduled_call", due_on: d(-1), note: "" },
    ]);
    expect(await openTimers(ids.future as string)).toEqual([
      { kind: "follow_up", due_on: d(10), note: "" },
    ]);
    expect(await openTimers(ids.dueToday as string)).toEqual([
      { kind: "follow_up", due_on: d(0), note: "" },
    ]);
    for (const key of ["underwriting", "dnc", "ghost", "hiddenGhost", "future", "dueToday"]) {
      expect(await bulkActivities(ids[key] as string), key).toEqual([]);
    }
  });

  it("another user's rows are untouched: timers and timeline identical", async () => {
    expect(await snapshot(b)).toEqual(otherBefore);
    const n = (
      await t.pool.query("select count(*)::int as n from activities where user_id = $1", [b])
    ).rows[0].n;
    expect(n).toBe(otherActivitiesBefore);
  });

  it("running it again moves nothing more: the overdue pile is what is left", async () => {
    const again = await t.db.withUser(a, (q) =>
      bulkReschedule(q, ctx(), { days: 5, keepApplicationIn: true }),
    );
    expect(again).toMatchObject({ moved: 0, keptApplicationIn: 1, needHands: 2 });
  });

  it("with the underwriting switch off it moves the deal that was being kept", async () => {
    const r = await t.db.withUser(a, (q) =>
      bulkReschedule(q, ctx(), { days: 3, keepApplicationIn: false }),
    );
    expect(r.moved).toBe(1);
    const timers = await openTimers(ids.underwriting as string);
    expect(timers).toEqual([
      { kind: "follow_up", due_on: businessDaySlots(today(), 3)[0], note: "Rescheduled in bulk" },
    ]);
  });

  it("a bulk reschedule is not counted as a snooze", async () => {
    const counts = await t.db.withUser(a, (q) =>
      snoozeCounts(q, [ids.big as string, ids.mid as string]),
    );
    expect(counts).toEqual({});
  });

  it("refuses nonsense day counts and changes nothing", async () => {
    const before = await snapshot(a);
    for (const days of [0, -2, 2.5]) {
      await expect(
        t.db.withUser(a, (q) => bulkReschedule(q, ctx(), { days, keepApplicationIn: false })),
      ).rejects.toThrow(RangeError);
    }
    expect(await snapshot(a)).toEqual(before);
  });
});

describe("all or nothing", () => {
  it("one id that is not yours rolls back every move before it", async () => {
    const mine1 = await seed({
      user: a,
      name: "AON 1",
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    const mine2 = await seed({
      user: a,
      name: "AON 2",
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    const theirs = await seed({
      user: b,
      name: "AON Theirs",
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    const beforeMine = [await openTimers(mine1), await openTimers(mine2)];
    const beforeTheirs = await openTimers(theirs);

    await expect(
      t.db.withUser(a, (q) =>
        applyMoves(q, [
          { id: mine1, dueOn: d(3) },
          { id: theirs, dueOn: d(3) },
          { id: mine2, dueOn: d(3) },
        ]),
      ),
    ).rejects.toThrow(/client not found/);

    expect([await openTimers(mine1), await openTimers(mine2)]).toEqual(beforeMine);
    expect(await openTimers(theirs)).toEqual(beforeTheirs);
    expect(await bulkActivities(mine1)).toEqual([]);
  });

  it("a date in the past is refused by the database and nothing moves", async () => {
    const c1 = await seed({
      user: a,
      name: "AON Past 1",
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    const c2 = await seed({
      user: a,
      name: "AON Past 2",
      timers: [{ kind: "follow_up", due: d(-1) }],
    });
    await expect(
      t.db.withUser(a, (q) =>
        applyMoves(q, [
          { id: c1, dueOn: d(2) },
          { id: c2, dueOn: d(-30) },
        ]),
      ),
    ).rejects.toThrow(/in the past/);
    expect(await openTimers(c1)).toEqual([{ kind: "follow_up", due_on: d(-1), note: "" }]);
  });

  it("an empty list is a no-op", async () => {
    expect(await t.db.withUser(a, (q) => applyMoves(q, []))).toBe(0);
  });
});

describe("the 200-per-call cap", () => {
  it("moves the 200 biggest, leaves the rest overdue, and says so", async () => {
    const c = await insertUser(t.pool, "cap@x.com");
    await t.pool.query(
      `insert into clients (user_id, business_name) select $1, 'Cap ' || lpad(g::text, 3, '0') from generate_series(1, 205) g`,
      [c],
    );
    await t.pool.query(
      `insert into timers (user_id, client_id, kind, due_on)
       select user_id, id, 'follow_up', current_date - 2 from clients where user_id = $1`,
      [c],
    );
    // Cap 001..205 asking $1,000 + $10 per number: Cap 205 is the biggest, Cap 001 the smallest.
    await t.pool.query(
      `insert into client_asks (user_id, client_id, wanted_amount_cents)
       select user_id, id, 100000 + substring(business_name from 5)::int * 1000 from clients where user_id = $1`,
      [c],
    );
    const r = await t.db.withUser(c, (q) =>
      bulkReschedule(q, ctx(), { days: 20, keepApplicationIn: false }),
    );
    expect(r.moved).toBe(MAX_BULK);
    expect(r.overCap).toBe(5);
    const { rows } = await t.pool.query<{ name: string; due: string }>(
      `select c.business_name as name, t.due_on::text as due from clients c join timers t on t.client_id = c.id
        where c.user_id = $1 and t.done_at is null and t.due_on < current_date order by 1`,
      [c],
    );
    expect(rows.map((x) => x.name)).toEqual([
      "Cap 001",
      "Cap 002",
      "Cap 003",
      "Cap 004",
      "Cap 005",
    ]);
    const moved = await t.pool.query(
      "select count(distinct client_id)::int as n from activities where user_id = $1 and body like '%Rescheduled in bulk'",
      [c],
    );
    expect(moved.rows[0].n).toBe(200);
  });
});

describe("snooze with a reason (the guard's second half)", () => {
  it("moves the date AND leaves the reason on the timeline, together", async () => {
    const id = await seed({
      user: a,
      name: "Guarded Deal",
      stage: "offers_in",
      timers: [{ kind: "follow_up", due: d(1) }],
    });
    const card = await t.db.withUser(a, (q) =>
      snoozeWithReason(q, ctx(), {
        clientId: id,
        dueOn: d(30),
        reason: "Waiting on his tax returns",
      }),
    );
    expect(card.next_due_on).toBe(d(30));
    expect((await openTimers(id)).map((x) => x.due_on)).toEqual([d(30)]);
    const { rows } = await t.pool.query<{ kind: string; body: string }>(
      "select kind, body from activities where client_id = $1 and kind = 'note'",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toMatch(
      /^Snoozed until [A-Z][a-z]{2} \d{1,2}(, \d{4})?: Waiting on his tax returns$/,
    );
  });
  it("a blank reason still snoozes and writes no note", async () => {
    const id = await seed({
      user: a,
      name: "Blank Reason",
      stage: "stips",
      timers: [{ kind: "follow_up", due: d(1) }],
    });
    await t.db.withUser(a, (q) =>
      snoozeWithReason(q, ctx(), { clientId: id, dueOn: d(21), reason: "" }),
    );
    expect((await openTimers(id)).map((x) => x.due_on)).toEqual([d(21)]);
    const { rows } = await t.pool.query(
      "select 1 from activities where client_id = $1 and kind = 'note'",
      [id],
    );
    expect(rows).toHaveLength(0);
  });
  it("a reason that looks like a card or SSN is refused and the snooze is rolled back with it", async () => {
    const id = await seed({
      user: a,
      name: "Sensitive",
      stage: "stips",
      timers: [{ kind: "follow_up", due: d(1) }],
    });
    await expect(
      t.db.withUser(a, (q) =>
        snoozeWithReason(q, ctx(), {
          clientId: id,
          dueOn: d(21),
          reason: "his ssn is 123-45-6789",
        }),
      ),
    ).rejects.toThrow();
    expect((await openTimers(id)).map((x) => x.due_on)).toEqual([d(1)]);
  });
  it("cannot snooze someone else's client", async () => {
    const theirs = await seed({
      user: b,
      name: "Not Yours",
      timers: [{ kind: "follow_up", due: d(1) }],
    });
    await expect(
      t.db.withUser(a, (q) =>
        snoozeWithReason(q, ctx(), { clientId: theirs, dueOn: d(30), reason: "x" }),
      ),
    ).rejects.toThrow();
    expect((await openTimers(theirs)).map((x) => x.due_on)).toEqual([d(1)]);
  });
});

describe("snooze counts, follow-up reasons and the client directory", () => {
  it("counts only recent snoozes, from the timeline, for the clients asked about", async () => {
    const x = await seed({ user: a, name: "Snoozer", timers: [{ kind: "follow_up", due: d(1) }] });
    const y = await seed({ user: a, name: "Once", timers: [{ kind: "follow_up", due: d(1) }] });
    await t.db.withUser(a, async (q) => {
      await q.query("select set_follow_up($1, $2)", [x, d(2)]);
      await q.query("select set_follow_up($1, $2)", [x, d(5)]);
      await q.query("select set_follow_up($1, $2)", [x, d(9)]);
      await q.query("select set_follow_up($1, $2)", [y, d(3)]);
    });
    // 20 days old: outside the 14-day window.
    await t.pool.query(
      `insert into activities (user_id, client_id, kind, body, occurred_at)
       values ($1, $2, 'timer', 'Follow up set for Sep 1, 2026', now() - interval '20 days')`,
      [a, x],
    );
    const counts = await t.db.withUser(a, (q) => snoozeCounts(q, [x, y]));
    expect(counts).toEqual({ [x]: 3, [y]: 1 });
    expect(await t.db.withUser(a, (q) => snoozeCounts(q, []))).toEqual({});
  });
  it("never reports another user's client", async () => {
    const theirs = await seed({
      user: b,
      name: "Their Snoozer",
      timers: [{ kind: "follow_up", due: d(1) }],
    });
    await t.db.withUser(b, (q) => q.query("select set_follow_up($1, $2)", [theirs, d(4)]));
    expect(await t.db.withUser(a, (q) => snoozeCounts(q, [theirs]))).toEqual({});
    expect(await t.db.withUser(a, (q) => followUpReasons(q, [theirs]))).toEqual({});
  });
  it("gives each client the note on its EARLIEST open timer", async () => {
    const id = await seed({
      user: a,
      name: "Two Timers",
      stage: "funded",
      timers: [
        { kind: "renewal", due: d(40), note: "renewal later" },
        { kind: "check_in", due: d(3), note: "check-in first" },
      ],
    });
    const r = await t.db.withUser(a, (q) => followUpReasons(q, [id]));
    expect(r[id]).toEqual({ kind: "check_in", note: "check-in first" });
  });
  it("lists only this user's clients with the newest ask, the last CALL and the next date", async () => {
    const id = await seed({
      user: a,
      name: "Directory Co",
      wanted: 1_000_000,
      timers: [
        { kind: "follow_up", due: d(9) },
        { kind: "check_in", due: d(4) },
      ],
    });
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents, created_at) values ($1, $2, 7700000, now() + interval '1 minute')",
      [a, id],
    );
    await t.pool.query(
      `insert into activities (user_id, client_id, kind, body, occurred_at) values
         ($1, $2, 'call', '', now() - interval '3 days'),
         ($1, $2, 'call', '', now() - interval '9 days'),
         ($1, $2, 'note', '', now() - interval '1 day')`,
      [a, id],
    );
    const rows = await t.db.withUser(a, (q) => clientDirectory(q));
    const mine = rows.find((r) => r.id === id);
    expect(mine).toMatchObject({
      business_name: "Directory Co",
      wanted_amount_cents: 7_700_000,
      next_due_on: d(4),
      contact_status: "ok",
    });
    const ageDays = (Date.now() - Date.parse(mine?.last_call_at ?? "")) / 86_400_000;
    expect(ageDays).toBeGreaterThan(2.9);
    expect(ageDays).toBeLessThan(3.1);
    const theirs = await t.pool.query("select id from clients where user_id = $1", [b]);
    for (const r of theirs.rows) expect(rows.some((x) => x.id === r.id)).toBe(false);
    expect(rows.every((r) => typeof r.business_name === "string")).toBe(true);
  });
});
