import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmFunding, fundSchema, proposeFunding } from "@/lib/money/fund";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * app.plan_for after 0526: a funding dated before every plan's effective_from takes the newest plan the person has
 * (their own first) instead of no plan at all; a plan that is effective on the date still wins over one that is not.
 */
let t: TestDb;
let rep: string;
let manager: string;
let pearl: string;

interface Plan {
  split_pct: string;
  manager_override_pct: string;
  user_id: string | null;
}

const planFor = async (user: string, on: string) =>
  (
    await t.pool.query<Plan>(
      "select (p).split_pct::text as split_pct, (p).manager_override_pct::text as manager_override_pct, (p).user_id from app.plan_for($1, $2::date) p",
      [user, on],
    )
  ).rows[0];

beforeAll(async () => {
  t = await createTestDb();
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query("update app_users set name = 'Josh', invited_by = $2 where id = $1", [
    rep,
    manager,
  ]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'subs@pearl.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
  // the seeded shop plan keeps its effective_from (the migration day = the database's today); it gains an override
  await t.pool.query("update commission_plans set manager_override_pct = 10 where user_id is null");
});
afterAll(async () => {
  await t.drop();
});

describe("app.plan_for falls back to the newest plan", () => {
  it("a date before every plan gets the shop plan, not nothing; a date the plan covers still gets it", async () => {
    const before = await t.pool.query<{ d: string }>("select (current_date - 30)::text as d");
    const early = await planFor(rep, before.rows[0]!.d);
    expect(early).toMatchObject({
      split_pct: "50.00",
      manager_override_pct: "10.00",
      user_id: null,
    });
    const today = await t.pool.query<{ d: string }>("select current_date::text as d");
    expect(await planFor(rep, today.rows[0]!.d)).toMatchObject({
      user_id: null,
      split_pct: "50.00",
    });
  });
  it("an effective shop plan beats the rep's own plan that is not effective yet; before both, the rep's own newest wins", async () => {
    await t.pool.query(
      "insert into commission_plans (user_id, effective_from, split_pct) values ($1, current_date + 10, 60)",
      [rep],
    );
    const d = (
      await t.pool.query<{ today: string; early: string; later: string }>(
        "select current_date::text as today, (current_date - 30)::text as early, (current_date + 10)::text as later",
      )
    ).rows[0]!;
    expect(await planFor(rep, d.today)).toMatchObject({ user_id: null, split_pct: "50.00" });
    expect(await planFor(rep, d.later)).toMatchObject({ user_id: rep, split_pct: "60.00" });
    expect(await planFor(rep, d.early)).toMatchObject({ user_id: rep, split_pct: "60.00" });
    await t.pool.query("delete from commission_plans where user_id = $1", [rep]);
  });
  it("confirming a funding dated before the shop plan posts the plan's override line, as the plan says", async () => {
    const id = await insertClient(t.db, rep, "Backfill Bakery");
    await t.pool.query("update clients set state = 'NY', email = 'bb@x.com' where id = $1", [id]);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [id]));
    const fundedOn = (await t.pool.query<{ d: string }>("select (current_date - 5)::text as d"))
      .rows[0]!.d;
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: id,
          funderId: pearl,
          amount: "50000",
          sellRate: "1.35",
          buyRate: "1.28",
          psf: "0",
          payment: "506.25",
          frequency: "daily",
          termDays: 120,
        }),
        fundedOn,
      ),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    const lines = (
      await t.pool.query<{ kind: string; user_id: string; rep_cents: string }>(
        "select kind, user_id, rep_cents::text as rep_cents from commission_ledger where funding_id = $1 order by id",
        [fid],
      )
    ).rows;
    expect(lines.map((l) => [l.kind, l.user_id === rep ? "rep" : "boss", l.rep_cents])).toEqual([
      ["expected", "rep", "175000"],
      ["override", "boss", "35000"],
    ]);
  });
});
