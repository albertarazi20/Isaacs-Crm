import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildScorecard, type ScorecardInput } from "@/lib/mca/scorecard";
import type { DigestSender } from "@/lib/system/reminders";
import { loadScorecard, runWeeklyScorecards } from "@/lib/system/weekly";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const base: ScorecardInput = {
  weekLabel: "Oct 19 – Oct 25",
  discipline: { total: 10, onTime: 8, late: 1, pushed: 1, overdue: 0, onTimeRate: 80 },
  added: 4,
  funded: { count: 2, cents: 7_500_000 },
  commissionReceivedCents: 600_000,
  overdue: [
    { clientId: "c1", businessName: "Mike's Pizza", wantedCents: 5_000_000, daysOverdue: 6 },
    { clientId: "c2", businessName: "Bella Nails", wantedCents: null, daysOverdue: 1 },
  ],
  overdueTotal: 7,
};

describe("buildScorecard", () => {
  it("states the facts and the deals to start with, with links", () => {
    const m = buildScorecard(base, "https://app.test");
    expect(m.subject).toBe("Your week: 80% on time · 2 funded · Oct 19 – Oct 25");
    expect(m.text).toContain("80% of 10 follow-ups that came due were done on the day");
    expect(m.text).toContain("4 new merchants added.");
    expect(m.text).toContain("2 advances funded — $75k.");
    expect(m.text).toContain("Commission received: $6k.");
    expect(m.text).toContain("Mike's Pizza, wants $50k — 6 days overdue");
    expect(m.text).toContain("https://app.test/clients/c1");
    expect(m.text).toContain("…and 5 more overdue.");
    expect(m.html).toContain('href="https://app.test/clients/c1"');
  });
  it("says so plainly when nothing came due, nothing funded and nothing is overdue", () => {
    const m = buildScorecard(
      {
        ...base,
        discipline: { total: 0, onTime: 0, late: 0, pushed: 0, overdue: 0, onTimeRate: null },
        added: 0,
        funded: { count: 0, cents: 0 },
        commissionReceivedCents: 0,
        overdue: [],
        overdueTotal: 0,
      },
      "https://app.test",
    );
    expect(m.subject).toBe("Your week · Oct 19 – Oct 25");
    expect(m.text).toContain("No follow-ups came due last week.");
    expect(m.text).toContain("Nothing funded.");
    expect(m.text).toContain("Nothing is overdue.");
    expect(m.text).not.toContain("Commission received");
  });
  it("calls out pushing back more than doing, but only with enough to say it", () => {
    const pushy = {
      ...base.discipline,
      total: 12,
      onTime: 3,
      pushed: 7,
      late: 1,
      overdue: 1,
      onTimeRate: 25,
    };
    expect(buildScorecard({ ...base, discipline: pushy }, "https://app.test").text).toContain(
      "pushed back than done",
    );
    const few = {
      ...base.discipline,
      total: 3,
      onTime: 0,
      pushed: 3,
      late: 0,
      overdue: 0,
      onTimeRate: 0,
    };
    expect(buildScorecard({ ...base, discipline: few }, "https://app.test").text).not.toContain(
      "pushed back than done",
    );
  });
  it("is safe: the subject stays on one line and names can't inject HTML", () => {
    const m = buildScorecard(
      {
        ...base,
        weekLabel: "Oct\r\n19",
        overdue: [
          {
            clientId: "c1",
            businessName: "<img src=x onerror=1>",
            wantedCents: null,
            daysOverdue: 2,
          },
        ],
      },
      "https://app.test",
    );
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<img");
  });
});

// 2026-10-26 is a Monday. The week being summarised is Oct 19 – Oct 25.
const MONDAY_NOON_NY = new Date("2026-10-26T16:00:00Z"); // 12:00 in New York
const MONDAY_EARLY_NY = new Date("2026-10-26T11:00:00Z"); // 07:00 in New York, before the 8 am digest hour
const TUESDAY_NY = new Date("2026-10-27T16:00:00Z");

describe("the weekly scorecard from a real database", () => {
  let t: TestDb;
  let a: string;
  let b: string;
  const rows = async (sql: string, params: unknown[] = []) =>
    (await t.pool.query(sql, params)).rows;

  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
    b = await insertUser(t.pool, "other@x.com", "America/New_York");
    const client = async (user: string, name: string, createdAt: string, wanted?: number) => {
      const { rows: r } = await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, created_at) values ($1, $2, $3) returning id",
        [user, name, createdAt],
      );
      const id = r[0]!.id;
      if (wanted)
        await t.pool.query(
          "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, $3)",
          [user, id, wanted],
        );
      return id;
    };
    const timer = (
      user: string,
      id: string,
      due: string,
      doneAt: string | null,
      reason: string | null,
    ) =>
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on, created_at, done_at, done_reason) values ($1, $2, 'follow_up', $3, '2026-10-01', $4, $5)",
        [user, id, due, doneAt, reason],
      );
    // User A: two merchants added last week, two added long ago. Follow-ups due in the week: 2 on time, 1 late, 1 pushed, 1 still open.
    // (The Oct 18 one is a week-and-a-day old: it is overdue NOW, but outside last week's window.)
    const m1 = await client(a, "Funded Pizza", "2026-10-20T15:00:00Z", 5_000_000);
    const m2 = await client(a, "Second New Co", "2026-10-22T15:00:00Z");
    const old = await client(a, "Old Overdue Biz", "2026-08-01T15:00:00Z", 9_000_000);
    const old2 = await client(a, "Older Overdue Biz", "2026-08-02T15:00:00Z");
    await timer(a, m1, "2026-10-21", "2026-10-21T16:00:00Z", "completed");
    await timer(a, m2, "2026-10-22", "2026-10-22T17:00:00Z", "completed");
    await timer(a, old, "2026-10-20", "2026-10-23T17:00:00Z", "completed"); // late
    await timer(a, old2, "2026-10-21", "2026-10-21T12:00:00Z", "replaced"); // pushed
    await timer(a, old, "2026-10-18", null, null); // still overdue (open)
    await timer(a, old2, "2026-10-24", null, null); // still overdue
    await t.pool.query(
      `insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency,
                             commission_cents, commission_received_cents, commission_received_on)
       values ($1, $2, '2026-10-22', 'Alpha', 5000000, 1.3, 50000, 'daily', 400000, 400000, '2026-10-24')`,
      [a, m1],
    );
    // A trashed merchant's funding must not count.
    const gone = await client(a, "Trashed Funded", "2026-10-20T15:00:00Z");
    await t.pool.query(
      "insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency) values ($1, $2, '2026-10-22', 'Alpha', 9900000, 1.3, 50000, 'daily')",
      [a, gone],
    );
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      gone,
      a,
    ]);
    // User B's data must never leak into A's card.
    const bm = await client(b, "B Merchant", "2026-10-21T15:00:00Z", 99_000_000);
    await timer(b, bm, "2026-10-20", null, null);
  });
  afterAll(async () => {
    await t.drop();
  });

  const ok = () =>
    vi.fn(async () => "resend_1") as unknown as DigestSender & ReturnType<typeof vi.fn>;
  const run = (send: DigestSender, now: Date) =>
    runWeeklyScorecards({ db: t.db, now, appUrl: "https://app.test", send });

  it("computes last week's numbers for one user only, trash and other users excluded", async () => {
    const card = await t.db.withUser(a, (q) => loadScorecard(q, "2026-10-26", "America/New_York"));
    expect(card.weekLabel).toBe("Oct 19 – Oct 25");
    expect(card.discipline).toMatchObject({ onTime: 2, late: 1, pushed: 1, overdue: 1, total: 5 });
    expect(card.added).toBe(2); // Funded Pizza and Second New Co; the trashed merchant is not counted
    expect(card.funded).toEqual({ count: 1, cents: 5_000_000 });
    expect(card.commissionReceivedCents).toBe(400_000);
    expect(card.overdueTotal).toBeGreaterThanOrEqual(2);
    expect(card.overdue[0]).toMatchObject({
      businessName: "Old Overdue Biz",
      wantedCents: 9_000_000,
    });
    expect(JSON.stringify(card)).not.toContain("B Merchant");
  });

  it("sends on Monday after the digest hour, once, with the real numbers", async () => {
    const send = ok();
    const first = await run(send, MONDAY_NOON_NY);
    expect(first).toEqual({ users: 2, sent: 2, skipped: 0, failed: 0 });
    const call = send.mock.calls.find(([to]) => to === "isaac@x.com");
    expect(call?.[1].subject).toBe("Your week: 40% on time · 1 funded · Oct 19 – Oct 25");
    expect(call?.[1].text).not.toContain("B Merchant");
    const again = ok();
    expect(await run(again, MONDAY_NOON_NY)).toEqual({ users: 2, sent: 0, skipped: 2, failed: 0 });
    expect(again).not.toHaveBeenCalled();
    expect(
      (await rows("select count(*)::int n from reminders_sent where kind = 'weekly'"))[0].n,
    ).toBe(2);
  });

  it("does nothing on any other day, or on Monday before their morning hour", async () => {
    await t.pool.query("delete from reminders_sent where kind = 'weekly'");
    const send = ok();
    expect(await run(send, TUESDAY_NY)).toMatchObject({ sent: 0, skipped: 2 });
    expect(await run(send, MONDAY_EARLY_NY)).toMatchObject({ sent: 0, skipped: 2 });
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed send rolls the claim back so the next hourly run retries", async () => {
    await t.pool.query("delete from reminders_sent where kind = 'weekly'");
    const boom = vi.fn(async () => {
      throw new Error("Resend down");
    }) as unknown as DigestSender;
    expect(await run(boom, MONDAY_NOON_NY)).toMatchObject({ sent: 0, failed: 2 });
    expect((await rows("select 1 from reminders_sent where kind = 'weekly'")).length).toBe(0);
    expect(await run(ok(), MONDAY_NOON_NY)).toMatchObject({ sent: 2, failed: 0 });
  });

  it("respects the reminder switch", async () => {
    await t.pool.query("delete from reminders_sent where kind = 'weekly'");
    await t.pool.query("update app_users set digest_enabled = false where id = $1", [b]);
    const send = ok();
    expect(await run(send, MONDAY_NOON_NY)).toMatchObject({ users: 1, sent: 1 });
    expect(send.mock.calls.map(([to]) => to)).toEqual(["isaac@x.com"]);
  });
});
