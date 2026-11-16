import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  biggestLeak,
  funnel,
  meterTone,
  nowScore,
  pace,
  rankNow,
  weekdaysInMonth,
} from "@/lib/dashboard/metrics";
import {
  emailMeters,
  listGoals,
  moneyOnTable,
  monthScoreboard,
  nowItems,
  repScorecard,
  setGoal,
} from "@/lib/dashboard/queries";
import { confirmFunding, fundSchema, proposeFunding } from "@/lib/money/fund";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("pace", () => {
  it("counts weekdays and knows where today sits", () => {
    // November 2026: the 1st is a Sunday, 30 days, 21 weekdays; the 16th is a Monday = 11th weekday.
    expect(weekdaysInMonth("2026-11-16")).toEqual({ total: 21, gone: 11 });
  });
  it("behind, on track, ahead and done come from the straight line to the goal", () => {
    const goal = 210_000_00; // $210k → $10k per weekday
    expect(pace(0, goal, "2026-11-16").status).toBe("behind"); // expected $110k by now
    expect(pace(110_000_00, goal, "2026-11-16").status).toBe("on_track");
    expect(pace(140_000_00, goal, "2026-11-16").status).toBe("ahead");
    expect(pace(210_000_00, goal, "2026-11-16").status).toBe("done");
    const p = pace(50_000_00, goal, "2026-11-16");
    expect(p.expectedByNowCents).toBe(110_000_00);
    expect(p.deltaCents).toBe(-60_000_00);
    expect(p.weekdaysLeft).toBe(10);
    expect(p.neededPerDayCents).toBe(16_000_00);
    expect(pace(5, 0, "2026-11-16").status).toBe("no_goal");
  });
});

describe("funnel", () => {
  it("gives conversion from the previous step and from the top, and names the leak", () => {
    const steps = funnel({ leads: 100, apps_in: 40, submitted: 30, approved: 15, funded: 6 });
    expect(steps.map((s) => s.fromPrevPct)).toEqual([null, 40, 75, 50, 40]);
    expect(steps.map((s) => s.fromTopPct)).toEqual([100, 40, 30, 15, 6]);
    expect(biggestLeak(steps)?.to.key).toBe("apps_in");
    expect(
      funnel({ leads: 0, apps_in: 0, submitted: 0, approved: 0, funded: 0 })[1]?.fromPrevPct,
    ).toBeNull();
  });
});

describe("email meter", () => {
  it("goes amber at the warning line and red at the cap", () => {
    expect(meterTone(100, 1500, 1200)).toBe("green");
    expect(meterTone(1200, 1500, 1200)).toBe("amber");
    expect(meterTone(1500, 1500, 1200)).toBe("red");
  });
});

describe("do-this-now ranking", () => {
  it("a reply beats an overdue timer; money and age lift a score but cannot swamp the kind", () => {
    expect(nowScore("merchant_replied", 0, 0)).toBeGreaterThan(nowScore("overdue", 50_000_00, 14));
    expect(nowScore("overdue", 50_000_00, 3)).toBeGreaterThan(nowScore("overdue", 5_000_00, 3));
    expect(nowScore("overdue", 5_000_00, 10)).toBeGreaterThan(nowScore("overdue", 5_000_00, 1));
    // age stops counting at two weeks
    expect(nowScore("overdue", 0, 14)).toBe(nowScore("overdue", 0, 60));
    const ranked = rankNow([
      {
        kind: "overdue",
        client_id: "a",
        deal_id: null,
        business_name: "A",
        label: "",
        detail: "",
        cents: 0,
        age_days: 1,
        href: "",
      },
      {
        kind: "kicked_back",
        client_id: "b",
        deal_id: null,
        business_name: "B",
        label: "",
        detail: "",
        cents: 0,
        age_days: 0,
        href: "",
      },
    ]);
    expect(ranked[0]?.kind).toBe("kicked_back");
  });
});

describe("dashboard queries", () => {
  let t: TestDb;
  let rep: string;
  let rep2: string;
  let manager: string;
  let pizza: string;
  let taco: string;
  let pearl: string;
  let month: string;
  let today: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    taco = await insertClient(t.db, rep2, "Taco Town");
    pearl = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email, max_upsell_points, psf_cap_pct, clawback_days, renewal_paydown_pct) values ($1, 'Pearl', 'subs@pearl.com', 8, 5, 45, 50) returning id",
        [manager],
      )
    ).rows[0]?.id as string;
    const d = await t.pool.query<{ m: string; d: string }>(
      "select to_char(current_date, 'YYYY-MM') as m, current_date::text as d",
    );
    month = d.rows[0]?.m as string;
    today = d.rows[0]?.d as string;

    // Pizza: submitted to ops, sent, approved by Pearl with an open offer; then funded and confirmed by the manager.
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    await t.pool.query(
      "update deals set ops_status = 'sent', sent_at = now() where client_id = $1",
      [pizza],
    );
    const sub = (
      await t.pool.query<{ id: string }>(
        "insert into submissions (user_id, client_id, funder_id, sent_on, status, responded_at) values ($1, $2, $3, current_date - 4, 'approved', now()) returning id",
        [rep, pizza, pearl],
      )
    ).rows[0]?.id as string;
    await t.pool.query(
      "insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate, received_on, status) values ($1, $2, $3, 5000000, 1.35, current_date - 3, 'presented')",
      [rep, pizza, sub],
    );

    // Taco: submitted to ops and kicked back; an old follow-up is overdue; a submission with no answer for a week.
    await t.db.withUser(rep2, (q) => q.query("select submit_to_ops($1)", [taco]));
    await t.pool.query(
      "update deals set ops_status = 'kicked_back', kicked_back_at = now() - interval '2 days', kickback_reason = 'missing_statement_month', kickback_count = 1, requested_cents = 2500000 where client_id = $1",
      [taco],
    );
    await t.pool.query(
      "update timers set due_on = current_date - 5 where client_id = $1 and done_at is null",
      [taco],
    );
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, sent_on, status) values ($1, $2, $3, current_date - 7, 'sent')",
      [rep2, taco, pearl],
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  it("money on the table lists the presented offer until it funds; the now-list says to close it", async () => {
    const m = await t.db.withUser(rep, (q) => moneyOnTable(q, today));
    expect(m.approved_unfunded.map((a) => a.business_name)).toEqual(["Pizza Palace"]);
    expect(m.approved_unfunded_cents).toBe(5_000_000);
    const now = await t.db.withUser(rep, (q) => nowItems(q, today, { manager: false }));
    expect(now.map((n) => n.kind)).toContain("approval_aging");
  });

  it("the scoreboard counts this month's funded money only after a manager confirms", async () => {
    const before = await t.db.withUser(manager, (q) => monthScoreboard(q, month));
    expect(before.funded_count).toBe(0);
    expect(before.submitted).toBe(1);
    expect(before.approved).toBe(1);
    expect(before.new_leads).toBe(2);

    const i = fundSchema.parse({
      clientId: pizza,
      funderId: pearl,
      amount: "50000",
      sellRate: "1.35",
      buyRate: "1.28",
      psf: "2500",
      payment: "506.25",
      frequency: "daily",
      termDays: 120,
      fundedOn: today,
    });
    const fid = await t.db.withUser(rep, (q) => proposeFunding(q, i, today));
    expect((await t.db.withUser(rep, (q) => monthScoreboard(q, month))).funded_count).toBe(0);
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));

    const after = await t.db.withUser(manager, (q) => monthScoreboard(q, month));
    expect(after.funded_count).toBe(1);
    expect(after.funded_cents).toBe(5_000_000);
    expect(after.commission_cents).toBe(600_000);
    expect(after.avg_points).toBe(7);

    // RLS: rep2 funded nothing, and the offer no longer counts as money on the table.
    expect((await t.db.withUser(rep2, (q) => monthScoreboard(q, month))).funded_count).toBe(0);
    const m = await t.db.withUser(rep, (q) => moneyOnTable(q, today));
    expect(m.approved_unfunded).toEqual([]);
    expect(m.expected_commission_cents).toBe(600_000);
  });

  it("the now-list ranks the kicked-back file above the overdue call and the stale submission; a rep sees only their own", async () => {
    const mine = await t.db.withUser(rep2, (q) => nowItems(q, today, { manager: false }));
    const kinds = mine.map((n) => n.kind);
    expect(kinds).toEqual(["kicked_back", "overdue", "stale_submission"]);
    expect(mine[0]?.label).toBe("Fix the file: A statement month is missing");
    expect(mine[0]?.href).toMatch(/^\/deals\//);
    expect(mine.every((n) => n.business_name === "Taco Town")).toBe(true);
    const all = await t.db.withUser(manager, (q) => nowItems(q, today, { manager: true }));
    expect(all.length).toBeGreaterThanOrEqual(mine.length);
  });

  it("the rep scorecard shows one row to a rep and every rep to a manager", async () => {
    const mine = await t.db.withUser(rep2, (q) => repScorecard(q, month, today));
    expect(mine.map((r) => r.email)).toEqual(["rep2@x.com"]);
    expect(mine[0]?.overdue).toBe(1);
    const all = await t.db.withUser(manager, (q) => repScorecard(q, month, today));
    expect(all.map((r) => r.email).sort()).toEqual(["boss@x.com", "rep2@x.com", "rep@x.com"]);
    expect(all.find((r) => r.email === "rep@x.com")?.funded_cents).toBe(5_000_000);
  });

  it("goals: the shop row exists from the migration, a manager sets a rep's, a rep cannot", async () => {
    await t.db.withUser(manager, (q) =>
      setGoal(q, { userId: rep, month, fundedCents: 20_000_000, deals: 4 }, manager),
    );
    const goals = await t.db.withUser(rep, (q) => listGoals(q, month));
    expect(goals.map((g) => [g.user_id, g.funded_cents])).toEqual([
      [null, 0],
      [rep, 20_000_000],
    ]);
    await expect(
      t.db.withUser(rep, (q) => setGoal(q, { userId: rep, month, fundedCents: 1, deals: 0 }, rep)),
    ).rejects.toThrow(/row-level security/);
  });

  it("the email meter reads the shop cap against each active mailbox", async () => {
    await t.pool.query(
      "insert into mailboxes (kind, user_id, address, provider_limit) values ('gmail', $1, 'rep@x.com', 2000)",
      [rep],
    );
    const meters = await t.db.withUser(rep, (q) => emailMeters(q));
    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      address: "rep@x.com",
      sent_24h: 0,
      cap: 1500,
      amber_at: 1200,
      tone: "green",
    });
  });
});
