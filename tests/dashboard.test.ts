import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meterTone, nowScore, rankNow } from "@/lib/dashboard/metrics";
import { emailMeters, monthScoreboard, nowItems, repScorecard } from "@/lib/dashboard/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("email meter", () => {
  it("goes amber at the warning line and red at the cap", () => {
    expect(meterTone(100, 1500, 1200)).toBe("green");
    expect(meterTone(1200, 1500, 1200)).toBe("amber");
    expect(meterTone(1500, 1500, 1200)).toBe("red");
  });
});

describe("do-this-now ranking", () => {
  it("a reply beats an overdue timer; age lifts a score but cannot swamp the kind", () => {
    expect(nowScore("merchant_replied", 0, 0)).toBeGreaterThan(nowScore("overdue", 0, 14));
    expect(nowScore("overdue", 0, 10)).toBeGreaterThan(nowScore("overdue", 0, 1));
    // age stops counting at two weeks
    expect(nowScore("overdue", 0, 14)).toBe(nowScore("overdue", 0, 60));
    const ranked = rankNow([
      {
        kind: "overdue",
        client_id: "a",
        business_name: "A",
        label: "",
        detail: "",
        cents: 0,
        age_days: 1,
        href: "",
      },
      {
        kind: "merchant_replied",
        client_id: "b",
        business_name: "B",
        label: "",
        detail: "",
        cents: 0,
        age_days: 0,
        href: "",
      },
    ]);
    expect(ranked[0]?.kind).toBe("merchant_replied");
  });
});

describe("dashboard queries", () => {
  let t: TestDb;
  let rep: string;
  let rep2: string;
  let manager: string;
  let pizza: string;
  let taco: string;
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
    const d = await t.pool.query<{ m: string; d: string }>(
      "select to_char(current_date, 'YYYY-MM') as m, current_date::text as d",
    );
    month = d.rows[0]?.m as string;
    today = d.rows[0]?.d as string;

    // Pizza: the application is in, and the rep called two hours after the lead landed.
    await t.pool.query(
      "update clients set application_received_on = current_date, created_at = now() - interval '5 hours' where id = $1",
      [pizza],
    );
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, outcome, body, occurred_at) values ($1, $2, 'call', 'reached', '', now() - interval '3 hours')",
      [rep, pizza],
    );
    // Taco: an old follow-up is overdue, and the merchant has written back.
    await t.pool.query(
      "update timers set due_on = current_date - 5 where client_id = $1 and done_at is null",
      [taco],
    );
    await t.pool.query(
      "select record_merchant_reply($1, 'Re: statements', 'Sending them', 't@taco.com')",
      [taco],
    );
  });
  afterAll(async () => {
    await t.drop();
  });

  it("the month counts new leads and applications in, for the rep's own book or the whole shop", async () => {
    const shop = await t.db.withUser(manager, (q) => monthScoreboard(q, month));
    expect(shop).toMatchObject({ new_leads: 2, apps_in: 1 });
    expect(await t.db.withUser(rep, (q) => monthScoreboard(q, month))).toMatchObject({
      new_leads: 1,
      apps_in: 1,
    });
    expect(await t.db.withUser(rep2, (q) => monthScoreboard(q, month))).toMatchObject({
      new_leads: 1,
      apps_in: 0,
    });
  });

  it("the now-list ranks the merchant who wrote back above the overdue call; a rep sees only their own", async () => {
    const mine = await t.db.withUser(rep2, (q) => nowItems(q, today));
    expect(mine.map((n) => n.kind)).toEqual(["merchant_replied", "overdue"]);
    expect(mine.every((n) => n.business_name === "Taco Town")).toBe(true);
    expect(mine[0]?.href).toBe(`/clients/${taco}`);
    expect(await t.db.withUser(rep, (q) => nowItems(q, today))).toEqual([]);
    const all = await t.db.withUser(manager, (q) => nowItems(q, today));
    expect(all.length).toBeGreaterThanOrEqual(mine.length);
  });

  it("the rep table shows one row to a rep and every rep to a manager, with leads, overdue and speed to lead", async () => {
    const mine = await t.db.withUser(rep2, (q) => repScorecard(q, month, today));
    expect(mine.map((r) => r.email)).toEqual(["rep2@x.com"]);
    expect(mine[0]).toMatchObject({ new_leads: 1, overdue: 1, speed_to_lead_hours: null });
    const all = await t.db.withUser(manager, (q) => repScorecard(q, month, today));
    expect(all.map((r) => r.email).sort()).toEqual(["boss@x.com", "rep2@x.com", "rep@x.com"]);
    // Pizza landed five hours ago and was called three hours ago: two hours to the first call
    expect(all.find((r) => r.email === "rep@x.com")).toMatchObject({
      new_leads: 1,
      overdue: 0,
      speed_to_lead_hours: 2,
    });
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
