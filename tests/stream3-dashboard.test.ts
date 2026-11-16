import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repScorecard } from "@/lib/dashboard/queries";
import { buildDigest, yesterdayLine } from "@/lib/mca/digest";
import { loadYesterday, runReminders, type DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;
let pearl: string;
let month: string; // YYYY-MM of the database's today
let first: string; // YYYY-MM-01

const at = (day: number, hour = 12) =>
  `${first.slice(0, 8)}${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const on = (day: number) => `${first.slice(0, 8)}${String(day).padStart(2, "0")}`;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "UTC");
  manager = await insertUser(t.pool, "boss@x.com", "UTC");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email) values ($1, 'Pearl', 'p@p.com') returning id",
      [manager],
    )
  ).rows[0]!.id;
  month = t.today.slice(0, 7);
  first = `${month}-01`;
});
afterAll(async () => {
  await t.drop();
});

/** A merchant with a deal sent on `sentDay`, an offer on `offerDay`, funded on `fundedDay` (all this month, as dates). */
async function journey(
  name: string,
  o: { created: number; sent: number; offer?: number; funded?: number; kickedBack?: boolean },
) {
  const id = await insertClient(t.db, rep, name);
  await t.pool.query("update clients set created_at = $2, email = 'x@x.com' where id = $1", [
    id,
    at(o.created, 9),
  ]);
  const deal = (
    await t.pool.query<{ id: string }>(
      `insert into deals (user_id, client_id, kind, ops_status, queued_at, sent_at, kickback_count)
       values ($1, $2, 'new', 'sent', $3, $4, $5) returning id`,
      [rep, id, at(o.created, 10), at(o.sent, 9), o.kickedBack ? 1 : 0],
    )
  ).rows[0]!.id;
  const sub = (
    await t.pool.query<{ id: string }>(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on) values ($1, $2, $3, $4, $5) returning id",
      [rep, id, pearl, deal, on(o.sent)],
    )
  ).rows[0]!.id;
  if (o.offer !== undefined) {
    await t.pool.query(
      "insert into offers (user_id, client_id, submission_id, deal_id, amount_cents, factor_rate, received_on) values ($1, $2, $3, $4, 5000000, 1.3, $5)",
      [rep, id, sub, deal, on(o.offer)],
    );
    await t.pool.query(
      "update submissions set status = 'approved', responded_at = $2, status_changed_at = $2 where id = $1",
      [sub, at(o.offer, 9)],
    );
  }
  if (o.funded !== undefined) {
    await t.pool.query(
      `insert into fundings (user_id, client_id, deal_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, commission_cents, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'Pearl', 5000000, 1.3, 50000, 'daily', 350000, $5, $6)`,
      [rep, id, deal, on(o.funded), at(o.funded, 15), manager],
    );
  }
  return id;
}

describe("S3-12 speed numbers and the kickback rate", () => {
  it("lead → sub, sub → first offer, approval → funded (medians in days) and kickbacks per file submitted", async () => {
    await journey("Fast Fish", { created: 1, sent: 3, offer: 5, funded: 11 }); // 2, 2, 6
    await journey("Slow Soup", { created: 2, sent: 8, offer: 16, funded: 20, kickedBack: true }); // 6, 8, 4
    await journey("Pending Pies", { created: 4, sent: 6 }); // sent only: counts for lead→sub (2) and the ops total
    const card = (await t.db.withUser(manager, (q) => repScorecard(q, month, t.today))).find(
      (r) => r.user_id === rep,
    );
    expect(card).toMatchObject({
      name: "Josh",
      submitted: 3,
      lead_to_sub_days: 2, // median of 2, 6, 2
      sub_to_offer_days: 5, // median of 2, 8
      approval_to_funded_days: 5, // median of 6, 4
      kickbacks: 1,
      submitted_to_ops: 3,
      kickback_rate_pct: 33,
    });
    // a rep with nothing this month has nulls, not zeros pretending to be speed
    const boss = (await t.db.withUser(manager, (q) => repScorecard(q, month, t.today))).find(
      (r) => r.user_id === manager,
    );
    expect(boss).toMatchObject({
      lead_to_sub_days: null,
      sub_to_offer_days: null,
      approval_to_funded_days: null,
      kickback_rate_pct: null,
    });
    // the rep sees only their own line
    expect(
      (await t.db.withUser(rep, (q) => repScorecard(q, month, t.today))).map((r) => r.user_id),
    ).toEqual([rep]);
  });
});

describe("S3-3 yesterday's numbers in the morning brief", () => {
  it("the line reads in plain words", () => {
    expect(
      yesterdayLine({
        date: "2026-11-15",
        submitted: 3,
        approvals: 2,
        funded_count: 1,
        funded_cents: 5_000_000,
        commission_cents: 350_000,
        scope: "shop",
      }),
    ).toBe(
      "Yesterday (the shop): 3 submitted · 2 approvals · 1 funded ($50,000) · $3,500 commission",
    );
    expect(
      yesterdayLine({
        date: "2026-11-15",
        submitted: 0,
        approvals: 1,
        funded_count: 0,
        funded_cents: 0,
        commission_cents: 0,
        scope: "you",
      }),
    ).toBe("Yesterday (you): 0 submitted · 1 approval · 0 funded · $0 commission");
    const d = buildDigest(
      [
        {
          timerId: "t",
          clientId: "c",
          businessName: "Due Co",
          contactName: "Mo",
          phone: "",
          stage: "interested",
          kind: "follow_up",
          dueOn: "2026-11-16",
          note: "",
        },
      ],
      "2026-11-16",
      "https://crm.test",
      {
        date: "2026-11-15",
        submitted: 1,
        approvals: 0,
        funded_count: 0,
        funded_cents: 0,
        commission_cents: 0,
        scope: "you",
      },
    );
    expect(
      d?.text.startsWith(
        "Yesterday (you): 1 submitted · 0 approvals · 0 funded · $0 commission\n\nDUE TODAY",
      ),
    ).toBe(true);
    expect(d?.html).toContain("<strong>Yesterday (you):");
  });
  it("a manager reads the shop, a rep their own; the digest carries the line above today's list", async () => {
    // yesterday, on the database's clock: a deal sent, an approval and a funding by the rep
    const yesterday = (await t.pool.query<{ d: string }>("select (current_date - 1)::text as d"))
      .rows[0]!.d;
    const other = await insertUser(t.pool, "other@x.com", "UTC");
    const id = await insertClient(t.db, rep, "Yesterday Yarns");
    const deal = (
      await t.pool.query<{ id: string }>(
        "insert into deals (user_id, client_id, kind, ops_status, queued_at, sent_at) values ($1, $2, 'new', 'sent', $3, $3) returning id",
        [rep, id, `${yesterday}T14:00:00Z`],
      )
    ).rows[0]!.id;
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status, responded_at) values ($1, $2, $3, $4, $5, 'approved', $6)",
      [rep, id, pearl, deal, yesterday, `${yesterday}T16:00:00Z`],
    );
    await t.pool.query(
      `insert into fundings (user_id, client_id, deal_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, commission_cents, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'Pearl', 5000000, 1.3, 50000, 'daily', 350000, now(), $5)`,
      [rep, id, deal, yesterday, manager],
    );
    const shop = await t.db.withSystem((q) =>
      loadYesterday(q, { id: manager, timezone: "UTC", role: "manager" }, t.today),
    );
    expect(shop).toEqual({
      date: yesterday,
      submitted: 1,
      approvals: 1,
      funded_count: 1,
      funded_cents: 5_000_000,
      commission_cents: 350_000,
      scope: "shop",
    });
    const mine = await t.db.withSystem((q) =>
      loadYesterday(q, { id: rep, timezone: "UTC", role: "rep" }, t.today),
    );
    expect(mine).toMatchObject({ submitted: 1, funded_count: 1, scope: "you" });
    const nothing = await t.db.withSystem((q) =>
      loadYesterday(q, { id: other, timezone: "UTC", role: "rep" }, t.today),
    );
    expect(nothing).toMatchObject({
      submitted: 0,
      approvals: 0,
      funded_count: 0,
      funded_cents: 0,
      scope: "you",
    });
    // the brief: a timer due today, sent at the rep's digest hour on UTC's clock
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date)",
      [rep, id],
    );
    await t.pool.query("update app_users set digest_hour = 0 where id = $1", [rep]);
    const send = vi.fn(async () => "re_brief") as unknown as DigestSender &
      ReturnType<typeof vi.fn>;
    await runReminders({
      db: t.db,
      now: new Date(),
      appUrl: "https://crm.test",
      send,
      allowed: (e) => e === "rep@x.com",
    });
    const call = send.mock.calls.find((c) => c[0] === "rep@x.com");
    expect(call?.[1].text).toMatch(
      /^Yesterday \(you\): 1 submitted · 1 approval · 1 funded \(\$50,000\) · \$3,500 commission\n\n/,
    );
    expect(call?.[1].text).toContain("Yesterday Yarns");
  });
});
