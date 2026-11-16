import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBucketSteps } from "@/lib/buckets/engine";
import { runDealClocks } from "@/lib/deals/clocks";
import { listDeals } from "@/lib/deals/queries";
import { reshopCandidates, startReshop } from "@/lib/deals/reshop";
import { askManager } from "@/lib/deals/mutations";
import { autoChase, type Sender } from "@/lib/inbox/submit";
import { mailboxSyncStatus } from "@/lib/inbox/sync";
import { fundSchema, proposeFunding } from "@/lib/money/fund";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 2, the deal side: every effect proved in the database.
 *   S2-2  approval expiry (shop default, lender override, the nightly expiry, the rep's alert) and the month-turn
 *         statement request that re-buckets the merchant and sends the reminder
 *   S2-6  chase modes, business days and hours, no_response after the final chase
 *   S2-8  the double-submission guard across reps by phone or email
 *   S2-10 reshop candidates and one-click reshop
 *   S2-14 ask a manager
 *   S2-16 eligible for more funds as a flag and a filter
 *   S2-18 last synced per mailbox
 */
let t: TestDb;
let rep: string;
let rep2: string;
let ops: string;
let manager: string;
let manager2: string;
let pearl: string; // no validity of its own → the shop's
let fora: string; // 10 days
let seq = 0;

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const bucketOf = async (clientId: string) =>
  (
    await t.pool.query<{ key: string | null }>(
      "select b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
      [clientId],
    )
  ).rows[0]?.key ?? null;
/** A merchant of the rep's with its own phone and email (the guard matches on those), an open deal, lender rows. */
async function merchant(owner: string, name: string, lenders: string[] = []) {
  seq += 1;
  const id = await insertClient(t.db, owner, name);
  await t.pool.query(
    "update clients set phone = $2, email = $3, state = 'FL', industry = 'Restaurant', monthly_revenue_cents = 4000000, time_in_business_months = 30 where id = $1",
    [id, `305555${String(1000 + seq).slice(-4)}`, `owner${seq}@biz.com`],
  );
  const deal = (await t.db.withUser(
    owner,
    async (q) =>
      (
        await q.query<{ id: string }>("select id from submit_to_ops($1, 'new', 5000000, 'stock')", [
          id,
        ])
      ).rows[0],
  ))!.id;
  const subs: string[] = [];
  if (lenders.length) {
    const rows = await t.db.withUser(
      manager,
      async (q) =>
        (
          await q.query<{ id: string }>("select id from create_submissions($1, $2::uuid[])", [
            id,
            lenders,
          ])
        ).rows,
    );
    subs.push(...rows.map((r) => r.id));
  }
  return { id, deal, subs };
}
const sub = async (id: string) =>
  (
    await t.pool.query<{ status: string; approval_expires_on: string | null; chase_count: number }>(
      "select status, approval_expires_on::text as approval_expires_on, chase_count from submissions where id = $1",
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  ops = await insertUser(t.pool, "ops@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  manager2 = await insertUser(t.pool, "boss2@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set role = 'manager', name = 'Boss Two' where id = $1", [
    manager2,
  ]);
  await t.pool.query("update app_users set role = 'ops', name = 'Olive' where id = $1", [ops]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
  await t.pool.query("update app_users set name = 'Mike' where id = $1", [rep2]);
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, approval_valid_days) values ($1, 'Pearl', 'subs@pearl.com', null) returning id",
      [manager],
    )
  ).rows[0]!.id;
  fora = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, approval_valid_days, statement_fresh_day) values ($1, 'Fora', 'subs@fora.com', 10, 5) returning id",
      [manager],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("S2-2: the approval clock", () => {
  let m: Awaited<ReturnType<typeof merchant>>;
  let pearlSub: string;
  let foraSub: string;
  beforeAll(async () => {
    m = await merchant(rep, "Clock Co", [pearl, fora]);
    const byFunder = async (f: string) =>
      (
        await t.pool.query<{ id: string }>(
          "select id from submissions where client_id = $1 and funder_id = $2",
          [m.id, f],
        )
      ).rows[0]!.id;
    pearlSub = await byFunder(pearl);
    foraSub = await byFunder(fora);
  });
  it("an approval without a stated date expires after the lender's days, or the shop's when the lender has none", async () => {
    await t.db.withUser(manager, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        pearlSub,
        JSON.stringify({ amount_cents: 4_000_000, factor_rate: 1.3 }),
      ]),
    );
    await t.db.withUser(manager, (q) =>
      q.query("select set_submission_status($1, 'approved')", [foraSub]),
    );
    expect((await sub(pearlSub)).approval_expires_on).toBe(addDays(t.today, 30));
    expect((await sub(foraSub)).approval_expires_on).toBe(addDays(t.today, 10));
    const offer = await t.pool.query<{ expires_on: string }>(
      "select expires_on::text as expires_on from offers where submission_id = $1",
      [pearlSub],
    );
    expect(offer.rows[0]?.expires_on).toBe(addDays(t.today, 30));
    // the shop default is a setting
    await t.pool.query("update shop_settings set approval_valid_days = 14");
    await t.db.withUser(manager, (q) =>
      q.query("select set_submission_status($1, 'sent')", [pearlSub]),
    );
    expect((await sub(pearlSub)).approval_expires_on).toBeNull();
    await t.db.withUser(manager, (q) =>
      q.query("select set_submission_status($1, 'approved')", [pearlSub]),
    );
    expect((await sub(pearlSub)).approval_expires_on).toBe(addDays(t.today, 14));
    // a stated date wins
    await t.db.withUser(manager, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        pearlSub,
        JSON.stringify({
          amount_cents: 4_000_000,
          factor_rate: 1.3,
          expires_on: addDays(t.today, 3),
        }),
      ]),
    );
    expect((await sub(pearlSub)).approval_expires_on).toBe(addDays(t.today, 3));
  });
  it("the nightly clock moves past-date approvals to expired with a timeline line and the rep's alert", async () => {
    const r = await t.db.withSystem((q) => runDealClocks(q, { today: addDays(t.today, 4) }));
    expect(r.expired).toBe(1);
    expect((await sub(pearlSub)).status).toBe("expired");
    expect((await sub(foraSub)).status).toBe("approved");
    const offers = await t.pool.query<{ status: string }>(
      "select status from offers where submission_id = $1",
      [pearlSub],
    );
    expect(offers.rows.every((o) => o.status === "expired")).toBe(true);
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Pearl: approval expired%'",
      [m.id],
    );
    expect(act.rows[0]?.body).toMatch(
      /^Pearl: approval expired — it was good through \w{3} \d{1,2}$/,
    );
    const alert = await t.pool.query<{ user_id: string; title: string; href: string }>(
      "select user_id, title, href from user_alerts where kind = 'approval_expired'",
    );
    expect(alert.rows).toEqual([
      { user_id: rep, title: "Pearl's approval of Clock Co expired", href: `/deals/${m.deal}` },
    ]);
    // running again changes nothing
    expect(
      (await t.db.withSystem((q) => runDealClocks(q, { today: addDays(t.today, 4) }))).expired,
    ).toBe(0);
    await t.pool.query("update shop_settings set approval_valid_days = 30");
  });
});

describe("S2-2: the month turned", () => {
  it("merchants with an open deal get the newest statement month on the checklist, land in the newest-statement bucket, and the reminder goes out", async () => {
    const m = await merchant(rep, "Month Co", [fora]);
    // a complete file as of the 16th of November: app, Jul–Oct statements, ID, check — all in
    const today = "2026-11-16";
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        m.id,
        JSON.stringify([
          { kind: "signed_application", period: null, required: true },
          { kind: "bank_statement", period: "2026-07-01", required: true },
          { kind: "bank_statement", period: "2026-08-01", required: true },
          { kind: "bank_statement", period: "2026-09-01", required: true },
          { kind: "bank_statement", period: "2026-10-01", required: true },
          { kind: "drivers_license", period: null, required: true },
          { kind: "voided_check", period: null, required: true },
        ]),
      ]),
    );
    await t.pool.query("update stips set received_at = now() where client_id = $1", [m.id]);
    await t.pool.query(
      "update enrollments set stopped_at = now(), stop_reason = 'deal_submitted' where client_id = $1 and stopped_at is null",
      [m.id],
    );
    // December 6th: November's statement is out and lenders expect it
    const r = await t.db.withSystem((q) => runDealClocks(q, { today: "2026-12-06" }));
    expect(r.statementsRequested).toBe(1);
    const row = await t.pool.query<{
      period: string;
      required: boolean;
      received_at: string | null;
    }>(
      "select period::text as period, required, received_at from stips where client_id = $1 and kind = 'bank_statement' and period = '2026-11-01'",
      [m.id],
    );
    expect(row.rows[0]).toEqual({ period: "2026-11-01", required: true, received_at: null });
    expect(await bucketOf(m.id)).toBe("missing_newest");
    const act = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body = 'The month turned: asked for the November 2026 statement'",
      [m.id],
    );
    expect(act.rows[0]?.n).toBe(1);
    await runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
    const ob = await t.pool.query<{ text_body: string; subject: string }>(
      "select text_body, subject from outbox where client_id = $1 order by created_at desc limit 1",
      [m.id],
    );
    expect(ob.rows[0]?.subject).toBe("One more statement for Month Co");
    expect(ob.rows[0]?.text_body).toContain(
      "The month turned, so lenders will ask for your newest bank statement",
    );
    expect(ob.rows[0]?.text_body).toMatch(/https:\/\/crm\.test\/upload\/[0-9a-f]+/);
    // the same day again adds nothing; before the ready day the previous month is not expected yet
    expect(
      (await t.db.withSystem((q) => runDealClocks(q, { today: "2026-12-06" }))).statementsRequested,
    ).toBe(0);
    expect(
      (await t.db.withSystem((q) => runDealClocks(q, { today: "2026-12-03" }))).statementsRequested,
    ).toBe(0);
    expect(today).toBe("2026-11-16");
  });
});

describe("S2-6: the lender chase", () => {
  let m: Awaited<ReturnType<typeof merchant>>;
  const sentMail: { userId: string; to: string }[] = [];
  const sendFor =
    (userId: string): Sender =>
    async (mail) => {
      sentMail.push({ userId, to: mail.to });
      return { id: "g", threadId: mail.threadId ?? "new" };
    };
  /** The next weekday at 10:00 New York on or after now, so the clock counts from a real business morning. */
  const businessMorning = (from = new Date()): Date => {
    const d = new Date(from.getTime());
    d.setUTCHours(15, 0, 0, 0);
    if (d < from) d.setUTCDate(d.getUTCDate() + 1);
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  };
  beforeAll(async () => {
    m = await merchant(rep, "Chase Co", [pearl]);
    await t.pool.query(
      "update submissions set sent_via = 'crm', gmail_thread_id = 'thr', gmail_message_id = '<m@x>', created_at = now() - interval '7 days' where id = $1",
      [m.subs[0]],
    );
  });
  it("nothing goes out on a weekend or at night; in draft mode ops get the nudge as an alert and the clock counts it", async () => {
    const morning = businessMorning();
    const saturday = new Date(morning.getTime());
    while (saturday.getUTCDay() !== 6) saturday.setUTCDate(saturday.getUTCDate() + 1);
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: saturday }))).toMatchObject({
      chased: 0,
      drafted: 0,
      skipped: 1,
    });
    const night = new Date(morning.getTime());
    night.setUTCHours(3); // 22:00 the evening before, New York
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: night }))).toMatchObject({
      chased: 0,
      drafted: 0,
      skipped: 1,
    });
    await t.pool.query("update shop_settings set lender_chase_mode = 'draft'");
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: morning }))).toMatchObject({
      chased: 0,
      drafted: 1,
      skipped: 0,
      flipped: 0,
    });
    expect(sentMail).toHaveLength(0);
    const alert = await t.pool.query<{
      user_id: string;
      title: string;
      body: string;
      href: string;
    }>("select user_id, title, body, href from user_alerts where kind = 'chase_draft'");
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0]).toMatchObject({
      user_id: ops,
      title: `Chase Pearl on D-${(await t.pool.query<{ n: number }>("select number as n from deals where id = $1", [m.deal])).rows[0]?.n} Chase Co`,
      href: `/deals/${m.deal}`,
    });
    expect(alert.rows[0]?.body).toContain("To: subs@pearl.com");
    expect(alert.rows[0]?.body).toContain("Any update on Chase Co");
    expect((await sub(m.subs[0]!)).chase_count).toBe(1);
    const act = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body = 'Chase drafted for ops: Pearl'",
      [m.id],
    );
    expect(act.rows[0]?.n).toBe(1);
    // just chased: quiet for less than a window → nothing
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: morning }))).toMatchObject({
      drafted: 0,
      chased: 0,
    });
  });
  it("send mode emails from the rep's mailbox; after the final chase has had its window the row flips to no_response", async () => {
    const morning = businessMorning();
    await t.pool.query("update shop_settings set lender_chase_mode = 'send'");
    await t.pool.query(
      "update submissions set last_chased_at = now() - interval '7 days' where id = $1",
      [m.subs[0]],
    );
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: morning }))).toMatchObject({
      chased: 1,
      drafted: 0,
    });
    expect(sentMail).toEqual([{ userId: rep, to: "subs@pearl.com" }]);
    expect((await sub(m.subs[0]!)).chase_count).toBe(2);
    // the shop's cap is 2: once this chase has been quiet for a whole window, the lender is not answering
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: morning }))).toMatchObject({
      chased: 0,
      flipped: 0,
    });
    await t.pool.query(
      "update submissions set last_chased_at = now() - interval '7 days' where id = $1",
      [m.subs[0]],
    );
    expect(await t.db.withSystem((q) => autoChase(q, { sendFor, now: morning }))).toMatchObject({
      chased: 0,
      flipped: 1,
    });
    expect((await sub(m.subs[0]!)).status).toBe("no_response");
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [m.id],
    );
    expect(act.rows[0]?.body).toBe("Pearl: no response — no answer after 2 chases");
    expect(sentMail).toHaveLength(1);
  });
});

describe("S2-8: the double-submission guard across reps", () => {
  it("the same owner under another rep's merchant row (same phone) is refused, naming the lender, the date and whose file; email matches too; force logs it", async () => {
    const mine = await merchant(rep, "Twin Pizza", [pearl]);
    const phone = (
      await t.pool.query<{ phone: string }>("select phone from clients where id = $1", [mine.id])
    ).rows[0]!.phone;
    // rep 2's row: a different name, the same phone
    const twin = await insertClient(t.db, rep2, "Twin Pizza LLC");
    await t.pool.query("update clients set phone = $2, email = 'other@biz.com' where id = $1", [
      twin,
      phone,
    ]);
    await t.db.withUser(rep2, (q) => q.query("select submit_to_ops($1)", [twin]));
    await expect(
      t.db.withUser(rep2, (q) =>
        q.query("select create_submissions($1, $2::uuid[])", [twin, [pearl]]),
      ),
    ).rejects.toThrow(
      new RegExp(
        `Twin Pizza LLC already went to Pearl on \\w{3} \\d{1,2} \\(Josh's file: Twin Pizza\\) — the shop waits 30 days`,
      ),
    );
    expect(
      (await t.pool.query("select 1 from submissions where client_id = $1", [twin])).rowCount,
    ).toBe(0);
    // a different lender is fine
    await t.db.withUser(rep2, (q) =>
      q.query("select create_submissions($1, $2::uuid[])", [twin, [fora]]),
    );
    // the same email, a different phone, is the same owner too
    const mail = (
      await t.pool.query<{ email: string }>("select email from clients where id = $1", [mine.id])
    ).rows[0]!.email;
    const byMail = await insertClient(t.db, rep2, "Pizza By Mail");
    await t.pool.query("update clients set phone = '3055559999', email = $2 where id = $1", [
      byMail,
      mail,
    ]);
    await t.db.withUser(rep2, (q) => q.query("select submit_to_ops($1)", [byMail]));
    await expect(
      t.db.withUser(rep2, (q) =>
        q.query("select create_submissions($1, $2::uuid[])", [byMail, [pearl]]),
      ),
    ).rejects.toThrow(/already went to Pearl/);
    // sending anyway, on purpose, is written on the timeline
    await t.db.withUser(rep2, (q) =>
      q.query("select create_submissions($1, $2::uuid[], null, '', true)", [byMail, [pearl]]),
    );
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Resubmission override%'",
      [byMail],
    );
    expect(act.rows[0]?.body).toMatch(
      /^Resubmission override: Pearl saw this merchant on \w{3} \d{1,2} \(Josh's file\)$/,
    );
    // the window is the shop's; 0 switches the guard off
    const third = await insertClient(t.db, rep2, "Pizza Three");
    await t.pool.query("update clients set phone = $2, email = '' where id = $1", [third, phone]);
    await t.db.withUser(rep2, (q) => q.query("select submit_to_ops($1)", [third]));
    await t.pool.query("update shop_settings set resubmit_block_days = 0");
    await t.db.withUser(rep2, (q) =>
      q.query("select create_submissions($1, $2::uuid[])", [third, [pearl]]),
    );
    await t.pool.query("update shop_settings set resubmit_block_days = 30");
  });
});

describe("S2-10: reshop", () => {
  let m: Awaited<ReturnType<typeof merchant>>;
  let picky: string;
  let fresh: string;
  beforeAll(async () => {
    picky = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email, excluded_states) values ($1, 'Picky', 'subs@picky.com', '{FL}') returning id",
        [manager],
      )
    ).rows[0]!.id;
    fresh = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email, min_monthly_revenue_cents) values ($1, 'Fresh Fund', 'subs@fresh.com', 1000000) returning id",
        [manager],
      )
    ).rows[0]!.id;
    m = await merchant(rep, "Reshop Co", [pearl, fora]);
  });
  it("candidates are lenders whose rules fit and who have not seen the merchant; reshop needs every lender to have declined", async () => {
    await expect(t.db.withUser(rep, (q) => startReshop(q, m.id))).rejects.toThrow(
      /every lender declined — this one is pending lenders/,
    );
    for (const s of m.subs)
      await t.db.withUser(manager, (q) =>
        q.query("select set_submission_status($1, 'declined', 'nsfs')", [s]),
      );
    const cands = await t.db.withUser(rep, (q) => reshopCandidates(q, m.id));
    expect(cands.map((c) => c.name)).toEqual(["Fresh Fund"]);
    expect(cands[0]).toMatchObject({ funderId: fresh, fit: { level: "fits" } });
    expect(
      cands.some((c) => c.funderId === picky || c.funderId === pearl || c.funderId === fora),
    ).toBe(false);
  });
  it("one click closes the declined deal, opens a reshop pre-filled, and asks for the newest statement", async () => {
    await expect(t.db.withUser(rep2, (q) => startReshop(q, m.id))).rejects.toThrow(
      /not in your book/,
    );
    const d = await t.db.withUser(rep, (q) => startReshop(q, m.id));
    expect(d).toMatchObject({
      kind: "reshop",
      client_id: m.id,
      requested_cents: 5_000_000,
      use_of_funds: "stock",
      outcome: "open",
      ops_status: "queued",
    });
    expect(d.blocker).toBe("Reshop: waiting on the newest statement before lenders see it");
    const old = await t.pool.query<{ outcome: string; outcome_reason: string; ops_status: string }>(
      "select outcome, outcome_reason, ops_status from deals where id = $1",
      [m.deal],
    );
    expect(old.rows[0]).toEqual({
      outcome: "declined",
      outcome_reason: "Reshopped as a new deal",
      ops_status: "closed",
    });
    const want = (
      await t.pool.query<{ d: string }>(
        "select app.expected_statement_month(current_date, 5)::text as d",
      )
    ).rows[0]!.d;
    const stip = await t.pool.query<{ required: boolean; received_at: string | null }>(
      "select required, received_at from stips where client_id = $1 and kind = 'bank_statement' and period = $2::date",
      [m.id, want],
    );
    expect(stip.rows[0]).toEqual({ required: true, received_at: null });
    expect(await bucketOf(m.id)).toBe("missing_newest");
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Reshop:%'",
      [m.id],
    );
    expect(act.rows[0]?.body).toMatch(/^Reshop: deal D-\d+ opened from D-\d+ with the same ask$/);
    // the new deal has no lender rows: every candidate is open to it
    expect(
      (await t.pool.query("select 1 from submissions where deal_id = $1", [d.id])).rowCount,
    ).toBe(0);
  });
});

describe("S2-14: ask a manager", () => {
  it("one action alerts every manager with the question and the deal's context, and writes the timeline line", async () => {
    const m = await merchant(rep, "Ask Co", [pearl]);
    const n = await t.db.withUser(rep, (q) =>
      askManager(q, {
        dealId: m.deal,
        question: "Can I present at 1.40 if Pearl comes back lower?",
      }),
    );
    expect(n).toBe(2);
    const rows = await t.pool.query<{ user_id: string; title: string; body: string; href: string }>(
      "select user_id, title, body, href from user_alerts where kind = 'ask_manager' order by user_id",
    );
    expect(rows.rows.map((r) => r.user_id).sort()).toEqual([manager, manager2].sort());
    expect(rows.rows[0]?.title).toBe("Josh asks about Ask Co");
    expect(rows.rows[0]?.body).toMatch(
      /^Can I present at 1\.40 if Pearl comes back lower\?\n\nAsk Co \(D-\d+, pending lenders\) — lenders: Pearl sent$/,
    );
    expect(rows.rows[0]?.href).toBe(`/deals/${m.deal}`);
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at desc limit 1",
      [m.id],
    );
    expect(act.rows[0]?.body).toBe(
      "Josh asked a manager: Can I present at 1.40 if Pearl comes back lower?",
    );
    await expect(
      t.db.withUser(rep2, (q) => askManager(q, { dealId: m.deal, question: "whose is this?" })),
    ).rejects.toThrow(/not in your view/);
    await expect(
      t.db.withUser(rep, (q) => askManager(q, { dealId: m.deal, question: "   " })),
    ).rejects.toThrow(/say what you want to ask/);
  });
});

describe("S2-16: eligible for more funds", () => {
  it("is a flag on the deal card and a My Deals filter, from the funding's renewal line", async () => {
    const m = await merchant(rep, "Renew Co", [pearl]);
    await t.db.withUser(manager, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        m.subs[0],
        JSON.stringify({
          amount_cents: 4_000_000,
          factor_rate: 1.3,
          payment_cents: 40_000,
          frequency: "daily",
        }),
      ]),
    );
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(
        q,
        fundSchema.parse({
          clientId: m.id,
          funderId: pearl,
          amount: 40000,
          sellRate: 1.3,
          payment: 400,
          frequency: "daily",
        }),
        t.today,
      ),
    );
    await t.db.withUser(manager, (q) => q.query("select confirm_funding($1)", [fid]));
    await t.pool.query("update fundings set renewal_eligible_on = current_date + 1 where id = $1", [
      fid,
    ]);
    const not = await t.db.withUser(rep, (q) => listDeals(q, "more_funds"));
    expect(not.some((d) => d.id === m.deal)).toBe(false);
    expect(
      (await t.db.withUser(rep, (q) => listDeals(q, "funded"))).find((d) => d.id === m.deal)
        ?.eligible_for_more_funds,
    ).toBe(false);
    await t.pool.query("update fundings set renewal_eligible_on = current_date - 1 where id = $1", [
      fid,
    ]);
    const yes = await t.db.withUser(rep, (q) => listDeals(q, "more_funds"));
    expect(yes.map((d) => d.id)).toEqual([m.deal]);
    expect(yes[0]?.eligible_for_more_funds).toBe(true);
    // a rep sees only their own
    expect(await t.db.withUser(rep2, (q) => listDeals(q, "more_funds"))).toEqual([]);
  });
});

describe("S2-18: last synced per mailbox", () => {
  it("lists each connected mailbox with its last sync, its cursor and its last error; a rep sees their own", async () => {
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true), ($2, 'josh@gmail.com', 'enc', false)",
      [manager, rep],
    );
    await t.pool.query(
      "insert into mail_sync_state (user_id, history_id, last_synced_at, messages_seen) values ($1, '123', now() - interval '5 minutes', 42)",
      [manager],
    );
    await t.pool.query(
      "insert into mail_sync_state (user_id, last_error) values ($1, 'Gmail needs to be reconnected')",
      [rep],
    );
    const rows = await t.db.withUser(manager, mailboxSyncStatus);
    expect(
      rows.map((r) => [
        r.name,
        r.can_read_mail,
        r.has_cursor,
        r.messages_seen,
        r.last_error,
        r.last_synced_at !== null,
      ]),
    ).toEqual([
      ["Boss", true, true, 42, null, true],
      ["Josh", false, false, 0, "Gmail needs to be reconnected", false],
    ]);
    const mine = await t.db.withUser(rep, mailboxSyncStatus);
    expect(mine.map((r) => r.name)).toEqual(["Josh"]);
  });
});
