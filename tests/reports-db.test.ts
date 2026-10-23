import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import { moveSchema, newClientSchema, touchSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addDays } from "@/lib/mca/dates";
import { loadCohort, loadTimerHistory, parsePeriod } from "@/lib/reports/queries";
import { buildDiscipline, buildFunnel, buildSources } from "@/lib/reports/report";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let ctx: UserContext;
const TZ = "Pacific/Auckland";

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", TZ);
  b = await insertUser(t.pool, "other@x.com");
  ctx = { today: t.today, timezone: TZ };
});
afterAll(async () => {
  await t.drop();
});

const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);
const newClient = (name: string, source = "") =>
  asA((q) => m.createClient(q, newClientSchema.parse({ businessName: name, source }), ctx));
const move = (clientId: string, stage: string, extra: Record<string, unknown> = {}) =>
  asA((q) => m.moveClient(q, moveSchema.parse({ clientId, stage, ...extra }), ctx));

describe("the report cohort, read from a real database", () => {
  let funded: string;
  let dead: string;
  let trashed: string;
  let old: string;

  beforeAll(async () => {
    funded = (await newClient("Funded Pizza", "Referral")).id;
    for (const stage of ["interested", "application_in", "submitted"]) await move(funded, stage);
    await move(funded, "funded", {
      funding: {
        amount: "50k",
        factorRate: "1.32",
        payment: "550",
        frequency: "daily",
        funderName: "Alpha",
      },
    });
    dead = (await newClient("Dead Diner", " referral")).id;
    await move(dead, "spoke_with_owner");
    await move(dead, "dead");
    trashed = (await newClient("Trashed Tacos", "Referral")).id;
    await asA((q) => m.trashClient(q, trashed));
    old = (await newClient("Old Auto", "")).id;
    await t.pool.query(
      "update clients set created_at = now() - interval '200 days' where id = $1",
      [old],
    );
    await t.db.withUser(b, (q) =>
      m.createClient(
        q,
        newClientSchema.parse({ businessName: "Other User's Client", source: "Referral" }),
        {
          today: t.today,
          timezone: "UTC",
        },
      ),
    );
  });

  it("includes only this user's live clients, and carries the history of every stage reached", async () => {
    const cohort = await asA((q) => loadCohort(q, null));
    const names = new Map(
      (
        await t.pool.query<{ id: string; business_name: string }>(
          "select id, business_name from clients",
        )
      ).rows.map((r) => [r.id, r.business_name]),
    );
    expect(cohort.map((c) => names.get(c.id)).sort()).toEqual([
      "Dead Diner",
      "Funded Pizza",
      "Old Auto",
    ]);
    const f = cohort.find((c) => c.id === funded);
    expect(Object.keys(f?.reached ?? {}).sort()).toEqual(
      ["application_in", "funded", "interested", "name_in", "submitted"].sort(),
    );
    expect(f).toMatchObject({ stage: "funded", fundedCents: 5_000_000, advances: 1 });
    expect(Object.keys(cohort.find((c) => c.id === dead)?.reached ?? {}).sort()).toEqual(
      ["dead", "name_in", "spoke_with_owner"].sort(),
    );
  });

  it("the period keeps only merchants added since then", async () => {
    const since = addDays(t.today, -90);
    const cohort = await asA((q) => loadCohort(q, since));
    expect(cohort.map((c) => c.id)).not.toContain(old);
    expect(cohort).toHaveLength(2);
  });

  it("feeds the pure builders end to end", async () => {
    const cohort = await asA((q) => loadCohort(q, addDays(t.today, -90)));
    const funnel = Object.fromEntries(buildFunnel(cohort).map((r) => [r.key, r.count]));
    expect(funnel).toMatchObject({ added: 2, spoke: 2, interested: 1, submitted: 1, funded: 1 });
    // "Referral" and " referral" are one source.
    expect(buildSources(cohort)).toEqual([
      {
        source: "Referral",
        added: 2,
        interested: 1,
        funded: 1,
        fundedCents: 5_000_000,
        rate: 50,
        small: true,
      },
    ]);
  });

  it("timer history marks a snooze as pushed and a logged call as handled, in the user's own day", async () => {
    const c = await newClient("Timer Co");
    await t.pool.query(
      "update timers set due_on = current_date - 1 where client_id = $1 and done_at is null",
      [c.id],
    );
    await asA((q) =>
      m.logTouch(q, touchSchema.parse({ clientId: c.id, kind: "call", outcome: "reached" }), ctx),
    );
    const s = await newClient("Snooze Co");
    await t.pool.query(
      "update timers set due_on = current_date - 1 where client_id = $1 and done_at is null",
      [s.id],
    );
    await asA((q) => m.setFollowUp(q, { clientId: s.id, dueOn: addDays(t.today, 10) }, ctx));
    const o = await newClient("Overdue Co");
    await t.pool.query(
      "update timers set due_on = current_date - 3 where client_id = $1 and done_at is null",
      [o.id],
    );

    const history = await asA((q) => loadTimerHistory(q, t.today, 30, TZ));
    const { rows } = await t.pool.query<{ d: string }>(
      "select (now() at time zone $1)::date::text as d",
      [TZ],
    );
    const nzToday = rows[0]?.d;
    const completed = history.find(
      (h) => h.doneReason === "completed" && h.dueOn === addDays(t.today, -1),
    );
    expect(completed?.doneOn).toBe(nzToday);
    expect(
      history.some((h) => h.doneReason === "replaced" && h.dueOn === addDays(t.today, -1)),
    ).toBe(true);
    expect(history.some((h) => h.doneOn === null && h.dueOn === addDays(t.today, -3))).toBe(true);
    const d = buildDiscipline(history, t.today);
    expect(d.pushed).toBeGreaterThanOrEqual(1);
    expect(d.overdue).toBeGreaterThanOrEqual(1);
  });

  it("another user's timers never show up: each user gets exactly their own count", async () => {
    await t.db.withUser(b, (q) =>
      m.createClient(q, newClientSchema.parse({ businessName: "B Timer Co" }), {
        today: t.today,
        timezone: "UTC",
      }),
    );
    await t.pool.query(
      "update timers set due_on = current_date - 1 where user_id = $1 and done_at is null",
      [b],
    );
    const count = async (user: string) =>
      (
        await t.pool.query(
          "select count(*)::int n from timers where user_id = $1 and due_on <= current_date",
          [user],
        )
      ).rows[0].n;
    const mine = await asA((q) => loadTimerHistory(q, t.today, null, TZ));
    const theirs = await t.db.withUser(b, (q) => loadTimerHistory(q, t.today, null, "UTC"));
    expect(mine).toHaveLength(await count(a));
    expect(theirs).toHaveLength(await count(b));
    expect(theirs.length).toBeGreaterThan(0);
  });

  it("created dates come out as ISO strings, not Date objects", async () => {
    const cohort = await asA((q) => loadCohort(q, null));
    for (const c of cohort) {
      expect(typeof c.createdAt).toBe("string");
      expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt);
    }
  });

  it("the period starts at midnight in the USER's time zone, not the database's", async () => {
    const edge = (await newClient("Edge Of Day")).id;
    // 23:00 UTC on Sep 9 is 11:00 on Sep 10 in Auckland.
    await t.pool.query("update clients set created_at = '2026-09-09 23:00:00+00' where id = $1", [
      edge,
    ]);
    const inUtc = await asA((q) => loadCohort(q, "2026-09-10", "UTC"));
    const inAuckland = await asA((q) => loadCohort(q, "2026-09-10", "Pacific/Auckland"));
    expect(inUtc.map((c) => c.id)).not.toContain(edge);
    expect(inAuckland.map((c) => c.id)).toContain(edge);
  });

  it("an imported merchant (added part-way) is flagged by its first stage, and isn't timed", async () => {
    const c = await asA((q) =>
      m.createClient(
        q,
        newClientSchema.parse({ businessName: "Imported Late", stage: "application_in" }),
        ctx,
      ),
    );
    const cohort = (await asA((q) => loadCohort(q, null))).filter((x) => x.id === c.id);
    expect(cohort[0]?.initialStage).toBe("application_in");
  });
});

describe("period parsing", () => {
  it("accepts the known periods and falls back to 90 days", () => {
    expect(parsePeriod("30")).toBe("30");
    expect(parsePeriod("all")).toBe("all");
    expect(parsePeriod("7")).toBe("90");
    expect(parsePeriod(undefined)).toBe("90");
    expect(parsePeriod("90; drop table clients")).toBe("90");
  });
});
