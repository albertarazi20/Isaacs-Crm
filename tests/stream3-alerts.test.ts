import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { confirmFunding, fundSchema, proposeFunding, recordCommissionPaid } from "@/lib/money/fund";
import { latePayouts, listPayouts } from "@/lib/money/payouts";
import {
  buildAlertEmail,
  COPY_BURST_PER_HOUR,
  generateBehindPace,
  generateLatePayouts,
  generateRegistrationRenewals,
  generateStaleDeals,
  generateTrustAlerts,
  runUserAlerts,
} from "@/lib/system/alerts";
import type { DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let rep2: string;
let ops: string;
let manager: string;
let pizza: string;
let pearl: string;

// A Monday mid-month: November 2026 has 21 weekdays and the 16th is the 11th of them (dashboard.test agrees).
const NOW = new Date("2026-11-16T15:00:00Z");
const ok = (): DigestSender & ReturnType<typeof vi.fn> => vi.fn(async () => "re_alert") as never;

const alerts = async (userId: string, kind?: string) =>
  (
    await t.pool.query<{
      kind: string;
      title: string;
      body: string;
      dedupe_key: string | null;
      emailed_at: Date | null;
      client_id: string | null;
      deal_id: string | null;
    }>(
      "select kind, title, body, dedupe_key, emailed_at, client_id, deal_id from user_alerts where user_id = $1 and ($2::text is null or kind = $2) order by id",
      [userId, kind ?? null],
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  ops = await insertUser(t.pool, "ops@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'ops' where id = $1", [ops]);
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  await t.pool.query("update app_users set name = 'Sam' where id = $1", [rep2]);
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query("update clients set state = 'NY', email = 'mike@pizza.com' where id = $1", [
    pizza,
  ]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, commission_paid_after_days) values ($1, 'Pearl', 'subs@pearl.com', 7) returning id",
      [manager],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("S3-2 generators", () => {
  it("ops kicking a file back writes the rep's alert through the trigger, once per kickback", async () => {
    const deal = (await t.db.withUser(
      rep,
      async (q) =>
        (await q.query<{ id: string }>("select id from submit_to_ops($1)", [pizza])).rows[0],
    ))!.id;
    await t.db.withUser(ops, (q) =>
      q.query("select kick_back_deal($1, 'missing_statement_month', 'October is missing')", [deal]),
    );
    const a = await alerts(rep, "kickback");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      title: "Ops kicked back Pizza Palace: missing statement month",
      body: "October is missing",
      dedupe_key: `kickback:${deal}:1`,
      deal_id: deal,
      client_id: pizza,
      emailed_at: null,
    });
    // the rep fixes it and resubmits; a second kickback is a second alert, not a swallowed duplicate
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
    await t.db.withUser(ops, (q) =>
      q.query("select kick_back_deal($1, 'illegible_id', '')", [deal]),
    );
    expect((await alerts(rep, "kickback")).map((x) => x.dedupe_key)).toEqual([
      `kickback:${deal}:1`,
      `kickback:${deal}:2`,
    ]);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
  });

  it("a deal sitting with lenders longer than the shop's stale days alerts the rep once per status", async () => {
    await t.db.withUser(manager, (q) =>
      q.query("select create_submissions($1, $2::uuid[])", [pizza, [pearl]]),
    );
    await t.pool.query(
      "update deals set sent_at = now() - interval '5 days' where client_id = $1 and outcome = 'open'",
      [pizza],
    );
    await t.pool.query("update submissions set sent_on = current_date - 5 where client_id = $1", [
      pizza,
    ]);
    expect(await t.db.withSystem((q) => generateStaleDeals(q))).toBe(1);
    expect(await t.db.withSystem((q) => generateStaleDeals(q))).toBe(0);
    const a = await alerts(rep, "stale_deal");
    expect(a).toHaveLength(1);
    expect(a[0]?.title).toMatch(/Pizza Palace has sat pending lenders for 5 days/);
    expect(a[0]?.body).toMatch(/No lender has answered/);
    // a shop that allows 10 days would not have alerted
    await t.pool.query("update shop_settings set stale_deal_days = 10");
    await t.pool.query("delete from user_alerts where kind = 'stale_deal'");
    expect(await t.db.withSystem((q) => generateStaleDeals(q))).toBe(0);
    await t.pool.query("update shop_settings set stale_deal_days = 3");
  });

  it("behind pace: the shop goal alerts the managers, a rep's goal alerts the rep, once a day", async () => {
    await t.pool.query(
      "insert into goals (user_id, month, funded_cents) values (null, '2026-11-01', 21000000), ($1, '2026-11-01', 5000000) on conflict (user_id, month) do update set funded_cents = excluded.funded_cents",
      [rep],
    );
    expect(await t.db.withSystem((q) => generateBehindPace(q, NOW))).toBe(2);
    expect(await t.db.withSystem((q) => generateBehindPace(q, NOW))).toBe(0);
    const m = await alerts(manager, "behind_pace");
    expect(m).toHaveLength(1);
    expect(m[0]?.title).toBe("The shop is behind pace: $0 funded of $210,000");
    expect(m[0]?.body).toMatch(
      /Expected \$110,000 by now\. \$21,000 a day has to fund on the 10 weekdays left/,
    );
    expect(m[0]?.dedupe_key).toBe("behind_pace:2026-11:2026-11-16");
    expect((await alerts(rep, "behind_pace"))[0]?.title).toBe(
      "You are behind pace: $0 funded of $50,000",
    );
    // the next day is a new alert; a day with no goal problem (a rep who funded) is silent
    expect(
      await t.db.withSystem((q) => generateBehindPace(q, new Date("2026-11-17T15:00:00Z"))),
    ).toBe(2);
  });

  it("S3-7: a registration renewing within 30 days (or lapsed) alerts the managers once per date", async () => {
    await t.pool.query(
      "insert into shop_registrations (state, registration_no, status, renews_on) values ('TX', 'OCCC-1', 'registered', current_date + 10), ('VA', '', 'registered', current_date - 2), ('CT', '', 'registered', current_date + 200)",
    );
    expect(await t.db.withSystem((q) => generateRegistrationRenewals(q))).toBe(2);
    expect(await t.db.withSystem((q) => generateRegistrationRenewals(q))).toBe(0);
    const a = await alerts(manager, "registration");
    expect(a.map((x) => x.title.slice(0, 2)).sort()).toEqual(["TX", "VA"]);
    expect(a.find((x) => x.title.startsWith("TX"))?.title).toMatch(/renews on .* \(10 days\)/);
    expect(a.find((x) => x.title.startsWith("VA"))?.title).toMatch(/lapsed on/);
  });

  it("S3-6: a lender past its pay-after days with commission owed is late — query and alert", async () => {
    const taco = await insertClient(t.db, rep, "Taco Town");
    await t.pool.query("update clients set state = 'NY', email = 't@t.com' where id = $1", [taco]);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [taco]));
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: taco,
          funderId: pearl,
          amount: "50000",
          sellRate: "1.35",
          buyRate: "1.28",
          psf: "0",
          payment: "506.25",
          frequency: "daily",
          termDays: 120,
        }),
        "2026-11-01",
      ),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    const expected = (
      await t.pool.query<{ d: string }>(
        "select commission_expected_on::text as d from fundings where id = $1",
        [fid],
      )
    ).rows[0]?.d;
    expect(expected).toBe("2026-11-08"); // funded_on + Pearl's 7 days
    const late = await t.db.withUser(manager, (q) => latePayouts(q, "2026-11-11"));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      funding_id: fid,
      business_name: "Taco Town",
      owed_cents: 350_000,
      days_late: 3,
    });
    expect(await t.db.withUser(manager, (q) => latePayouts(q, "2026-11-05"))).toEqual([]);
    expect(await t.db.withSystem((q) => generateLatePayouts(q))).toBe(2); // the rep and the one manager
    expect(await t.db.withSystem((q) => generateLatePayouts(q))).toBe(0);
    const a = await alerts(rep, "late_payout");
    expect(a[0]?.title).toBe("Pearl is late paying commission on Taco Town");
    expect(a[0]?.body).toMatch(/\$3,500 was expected by Nov 08/);
    expect((await alerts(manager, "late_payout"))[0]?.dedupe_key).toBe(`late_payout:${fid}`);
    // paid in full: no longer owed
    await t.db.withUser(manager, (q) =>
      recordCommissionPaid(q, { fundingId: fid, cents: 350_000 }),
    );
    expect(await t.db.withUser(manager, (q) => listPayouts(q, t.today))).toEqual([]);
  });

  it("S3-9: a copy burst, after-hours copies, another rep's lead and a canary each alert the managers once", async () => {
    // 1. the burst: COPY_BURST_PER_HOUR copies by Sam in the last hour
    const burst = Array.from({ length: COPY_BURST_PER_HOUR }, (_, i) => i);
    for (const i of burst) {
      await t.pool.query(
        "insert into access_log (user_id, action, client_id, at) values ($1, 'copy_phone', $2, $3::timestamptz - make_interval(mins => $4))",
        [rep2, pizza, NOW.toISOString(), i],
      );
    }
    // 2. after hours: Josh copying at 23:30 New York (04:30 UTC) earlier today
    await t.pool.query(
      "insert into access_log (user_id, action, client_id, at) values ($1, 'copy_email', $2, '2026-11-16T04:30:00Z')",
      [rep, pizza],
    );
    // 3. Sam opening Josh's merchant (rows 1 above already are, under Josh's Pizza Palace)
    // 4. a canary in Sam's book, touched by Sam
    const canary = await t.db.withUser(
      manager,
      async (q) =>
        (
          await q.query<{ id: string }>(
            "select create_canary($1, 'Canary Cafe', 'Nobody', '5550001111', 'canary@x.com') as id",
            [rep2],
          )
        ).rows[0]!.id,
    );
    await t.pool.query(
      "insert into access_log (user_id, action, client_id, at) values ($1, 'view_contact', $2, $3)",
      [rep2, canary, NOW.toISOString()],
    );
    expect(await t.db.withSystem((q) => generateTrustAlerts(q, NOW))).toBe(4);
    expect(await t.db.withSystem((q) => generateTrustAlerts(q, NOW))).toBe(0);
    const a = await alerts(manager, "trust");
    const keys = a.map((x) => x.dedupe_key).sort();
    expect(keys).toEqual(
      [
        `trust:after_hours:${rep}:2026-11-15`,
        `trust:canary:${canary}:${rep2}`,
        `trust:copies:${rep2}:2026-11-16-15`,
        `trust:others:${rep2}:${pizza}`,
      ].sort(),
    );
    expect(a.find((x) => x.dedupe_key?.startsWith("trust:copies"))?.title).toBe(
      `Sam copied contact details ${COPY_BURST_PER_HOUR} times in the last hour`,
    );
    expect(a.find((x) => x.dedupe_key?.startsWith("trust:others"))?.title).toBe(
      "Sam opened Pizza Palace, which is Josh's lead",
    );
    expect(a.find((x) => x.dedupe_key?.startsWith("trust:canary"))?.title).toBe(
      "Canary touched: Sam opened Canary Cafe",
    );
    // the manager's own view of a rep's lead is their job, not a pattern
    expect(keys.some((k) => k?.includes(`trust:others:${manager}`))).toBe(false);
  });

  it("S3-9: policy acceptance is recorded once per person", async () => {
    const accept = () =>
      t.db.withUser(
        rep,
        async (q) =>
          (await q.query<{ at: string }>("select extract(epoch from accept_policy())::text as at"))
            .rows[0]!.at,
      );
    const first = await accept();
    expect(first).not.toBe("");
    await new Promise((r) => setTimeout(r, 20));
    expect(await accept()).toBe(first);
    const { rows } = await t.pool.query(
      "select extract(epoch from policy_accepted_at)::text as at from app_users where id = $1",
      [rep],
    );
    expect(rows[0]?.at).toBe(first);
    expect(
      (await t.pool.query("select policy_accepted_at from app_users where id = $1", [rep2])).rows[0]
        ?.policy_accepted_at,
    ).toBeNull();
  });
});

describe("S3-2 the drain", () => {
  it("bundles every unsent alert for a person into one email and stamps emailed_at", async () => {
    const send = ok();
    const before = (await alerts(manager)).filter((a) => a.emailed_at === null).length;
    expect(before).toBeGreaterThan(3);
    const s = await runUserAlerts({ db: t.db, now: NOW, appUrl: "https://crm.test", send });
    // the manager, Josh (kickbacks, stale, pace, late payout) and Sam? Sam has no alerts of his own.
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(0);
    const toBoss = send.mock.calls.find((c) => c[0] === "boss@x.com");
    expect(toBoss).toBeDefined();
    const digest = toBoss![1];
    expect(digest.subject).toMatch(new RegExp(`^${before} things need you — `));
    expect(digest.text).toContain("The shop is behind pace");
    expect(digest.text).toContain("Canary touched: Sam opened Canary Cafe");
    expect(digest.text).toContain("https://crm.test/clients/");
    expect((await alerts(manager)).every((a) => a.emailed_at !== null)).toBe(true);
    expect((await alerts(rep)).every((a) => a.emailed_at !== null)).toBe(true);
  });
  it("sends at most one email per person per hour, then the next bundle", async () => {
    await t.pool.query(
      "select app.alert($1, 'test', null, null, 'Ten minutes later', '', '/', 'later:1')",
      [manager],
    );
    const soon = ok();
    const s1 = await runUserAlerts({
      db: t.db,
      now: new Date(NOW.getTime() + 10 * 60_000),
      appUrl: "https://crm.test",
      send: soon,
    });
    expect(soon).not.toHaveBeenCalled();
    expect(s1.skipped).toBeGreaterThanOrEqual(1);
    expect((await alerts(manager, "test"))[0]?.emailed_at).toBeNull();
    const later = ok();
    const s2 = await runUserAlerts({
      db: t.db,
      now: new Date(NOW.getTime() + 61 * 60_000),
      appUrl: "https://crm.test",
      send: later,
    });
    expect(s2.sent).toBe(1);
    expect(later.mock.calls[0]?.[0]).toBe("boss@x.com");
    expect(later.mock.calls[0]?.[1].subject).toBe("Ten minutes later");
    expect((await alerts(manager, "test"))[0]?.emailed_at).not.toBeNull();
  });
  it("a failed send leaves the rows unsent for the next run; two overlapping runs send once", async () => {
    const at = new Date(NOW.getTime() + 3 * 3_600_000);
    await t.pool.query("select app.alert($1, 'test', null, null, 'Retry me', '', '/', 'retry:1')", [
      rep2,
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom: DigestSender = async () => {
      throw new Error("resend down");
    };
    const failed = await runUserAlerts({
      db: t.db,
      now: at,
      appUrl: "https://crm.test",
      send: boom,
    });
    errSpy.mockRestore();
    expect(failed.failed).toBe(1);
    expect((await alerts(rep2, "test"))[0]?.emailed_at).toBeNull();
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "re_slow";
    });
    await Promise.all([
      runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send: slow }),
      runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send: slow }),
    ]);
    expect(slow.mock.calls.filter((c) => (c as unknown[])[0] === "rep2@x.com")).toHaveLength(1);
    expect((await alerts(rep2, "test"))[0]?.emailed_at).not.toBeNull();
  });
  it("a person off the allowlist or with the digest muted gets no email", async () => {
    const at = new Date(NOW.getTime() + 5 * 3_600_000);
    await t.pool.query("select app.alert($1, 'test', null, null, 'Muted', '', '/', 'muted:1')", [
      ops,
    ]);
    const send = ok();
    await runUserAlerts({
      db: t.db,
      now: at,
      appUrl: "https://crm.test",
      send,
      allowed: (e) => e !== "ops@x.com",
    });
    expect(send).not.toHaveBeenCalled();
    await t.pool.query("update app_users set digest_enabled = false where id = $1", [ops]);
    await runUserAlerts({ db: t.db, now: at, appUrl: "https://crm.test", send });
    expect(send).not.toHaveBeenCalled();
    expect((await alerts(ops, "test"))[0]?.emailed_at).toBeNull();
  });
  it("the email: one thing is its own subject", () => {
    const m = buildAlertEmail(
      [
        {
          id: "1",
          kind: "kickback",
          title: "Ops kicked back Pizza",
          body: "October is missing",
          href: "/deals/x",
          created_at: NOW,
        },
      ],
      "https://crm.test",
    );
    expect(m.subject).toBe("Ops kicked back Pizza");
    expect(m.text).toContain("https://crm.test/deals/x");
    expect(m.html).toContain("October is missing");
  });
});
