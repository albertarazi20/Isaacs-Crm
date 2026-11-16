import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nowItems, repScorecard } from "@/lib/dashboard/queries";
import { speedNumbers } from "@/lib/dashboard/speed";
import { closeMonth } from "@/lib/money/close";
import { changeLines, signedMoney } from "@/lib/money/correctionLines";
import {
  confirmFunding,
  correctFunding,
  correctionSchema,
  fundSchema,
  proposeFunding,
} from "@/lib/money/fund";
import {
  correctionsFor,
  fundedExtras,
  monthsToClose,
  statementMonths,
  statementsForPeriod,
} from "@/lib/money/fundedExtras";
import { startRenewal } from "@/lib/money/renewals";
import { OPENER_REVIEW_HOURS } from "@/lib/money/winback";
import { draftedOpeners, memberExtras, openerMode } from "@/lib/money/winbackExtras";
import { templateLabel } from "@/lib/money/winbackLabels";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let manager: string;
let rep: string;
let rep2: string;
let pearl: string;
let phones = 0;
let prevMonth: string; // YYYY-MM-01
let month: string; // YYYY-MM of the database's today
let first: string; // YYYY-MM-01 of the database's today

const at = (day: number, hour = 12) =>
  `${first.slice(0, 8)}${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const on = (day: number) => `${first.slice(0, 8)}${String(day).padStart(2, "0")}`;

const fund = (clientId: string, over: Record<string, unknown> = {}) =>
  fundSchema.parse({
    clientId,
    funderId: pearl,
    amount: "50000",
    sellRate: "1.35",
    buyRate: "1.28",
    psf: "2500",
    payment: "506.25",
    frequency: "daily",
    termDays: 120,
    ...over,
  });

/** A merchant with its own phone and email: stream 2's double-submission guard treats one phone as one owner. */
async function merchant(owner: string, name: string): Promise<string> {
  const id = await insertClient(t.db, owner, name);
  phones += 1;
  await t.pool.query("update clients set state = 'NY', email = $2, phone = $3 where id = $1", [
    id,
    `m${phones}@x.com`,
    `555${String(2_000_000 + phones)}`,
  ]);
  return id;
}

async function deal(owner: string, clientId: string, opsStatus = "queued"): Promise<string> {
  return (
    await t.pool.query<{ id: string }>(
      "insert into deals (user_id, client_id, kind, ops_status) values ($1, $2, 'new', $3) returning id",
      [owner, clientId, opsStatus],
    )
  ).rows[0]!.id;
}

async function funded(owner: string, clientId: string, over: Record<string, unknown> = {}) {
  const id = await t.db.withUser(owner, (q) => proposeFunding(q, fund(clientId, over), t.today));
  await t.db.withUser(manager, (q) => confirmFunding(q, id));
  return id;
}

async function member(
  owner: string,
  clientId: string,
  fields: Partial<{
    pool: string;
    status: string;
    dealId: string;
    openerStatus: string;
    opener: string;
    nextStep: number;
    stepsSent: number;
  }> = {},
): Promise<string> {
  return (
    await t.pool.query<{ id: string }>(
      `insert into winback_members (user_id, client_id, pool, reason, workable_on, status, next_due_on, deal_id,
                                    opener, opener_status, opener_drafted_at, next_step, steps_sent)
       values ($1, $2, $3, 'Test', current_date - 3, $4, current_date, $5, $6, $7, $8, $9, $10) returning id`,
      [
        owner,
        clientId,
        fields.pool ?? "cold",
        fields.status ?? "active",
        fields.dealId ?? null,
        fields.opener ?? "",
        fields.openerStatus ?? "none",
        fields.openerStatus === "drafted" ? new Date().toISOString() : null,
        fields.nextStep ?? 1,
        fields.stepsSent ?? 0,
      ],
    )
  ).rows[0]!.id;
}

beforeAll(async () => {
  t = await createTestDb();
  manager = await insertUser(t.pool, "boss@x.com", "UTC");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  rep = await insertUser(t.pool, "rep@x.com", "UTC");
  await t.pool.query("update app_users set name = 'Josh', invited_by = $2 where id = $1", [
    rep,
    manager,
  ]);
  rep2 = await insertUser(t.pool, "rep2@x.com", "UTC");
  await t.pool.query("update app_users set name = 'Sue' where id = $1", [rep2]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, clawback_days, commission_paid_after_days) values ($1, 'Pearl', 'subs@pearl.com', 45, 10) returning id",
      [manager],
    )
  ).rows[0]!.id;
  await t.pool.query(
    "update commission_plans set manager_override_pct = 10, effective_from = '2000-01-01' where user_id is null",
  );
  const d = await t.pool.query<{ prev: string; cur: string }>(
    "select (date_trunc('month', current_date) - interval '1 month')::date::text as prev, date_trunc('month', current_date)::date::text as cur",
  );
  prevMonth = d.rows[0]!.prev;
  first = d.rows[0]!.cur;
  month = first.slice(0, 7);
});
afterAll(async () => {
  await t.drop();
});

describe("pure helpers", () => {
  it("names the email that went before the money came back", () => {
    expect(templateLabel("winback:approved_unfunded:2")).toBe("Step 2 email");
    expect(templateLabel("winback:cold:1")).toBe("Step 1 email");
    expect(templateLabel(null)).toBe("Funded before any email");
    expect(templateLabel("rescue:abc:20")).toBe("rescue:abc:20");
  });

  it("lists only what a correction changed, in reading order, with signed money", () => {
    expect(
      changeLines({
        old_values: { amount_cents: 5_000_000, buy_rate: 1.28, points: 7, funder_name: "Pearl" },
        new_values: { amount_cents: 5_500_000, buy_rate: 1.29, points: 7, funder_name: "Pearl" },
      }),
    ).toEqual(["Amount $50,000 → $55,000", "Buy rate 1.28 → 1.29"]);
    expect(changeLines({ old_values: { term_days: null }, new_values: { term_days: 90 } })).toEqual(
      ["Term — → 90"],
    );
    expect(changeLines({ old_values: {}, new_values: {} })).toEqual([]);
    expect(signedMoney(35_000)).toBe("+$350");
    expect(signedMoney(-50_000)).toBe("−$500");
    expect(signedMoney(null)).toBe("—");
  });
});

describe("winback: the rescue nudges, the reshop flag and the opener tray", () => {
  it("memberExtras reads the nudges sent on the member's deal and whether a reshop is open", async () => {
    const a = await merchant(rep, "Rescue Co");
    const dealA = await deal(rep, a, "sent");
    await t.pool.query("update deals set outcome = 'open' where id = $1", [dealA]);
    const mA = await member(rep, a, { pool: "approved_unfunded", dealId: dealA });
    for (const day of [25, 20])
      await t.pool.query(
        "insert into rescue_nudges (deal_id, user_id, client_id, day) values ($1, $2, $3, $4)",
        [dealA, rep, a, day],
      );
    // a deal every lender declined: reshop is open; the same merchant with a lender still pending: it is not
    const b = await merchant(rep, "Declined Co");
    const dealB = await deal(rep, b, "sent");
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 30, 'declined')",
      [rep, b, pearl, dealB],
    );
    const mB = await member(rep, b, { pool: "declined_curable", status: "replied", dealId: dealB });
    const c = await merchant(rep, "Pending Co");
    const dealC = await deal(rep, c, "sent");
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 3, 'sent')",
      [rep, c, pearl, dealC],
    );
    const mC = await member(rep, c, { pool: "declined_curable", dealId: dealC });
    const other = await merchant(rep2, "Sue's Co");
    const mO = await member(rep2, other);

    const x = await t.db.withUser(rep, (q) => memberExtras(q));
    expect(x[mA]).toEqual({ rescue_days: [20, 25], can_reshop: false });
    expect(x[mB]).toEqual({ rescue_days: [], can_reshop: true });
    expect(x[mC]).toEqual({ rescue_days: [], can_reshop: false });
    expect(x[mO]).toBeUndefined(); // RLS: another rep's member is not here
    expect((await t.db.withUser(manager, (q) => memberExtras(q)))[mO]).toBeDefined();
  });

  it("draftedOpeners holds only lines a manager has not released and step 1 has not sent", async () => {
    const mk = (name: string) => merchant(rep, name);
    const drafted = await member(rep, await mk("Draft A"), {
      openerStatus: "drafted",
      opener: "Line A",
    });
    await member(rep, await mk("Draft B"), { openerStatus: "approved", opener: "Line B" });
    await member(rep, await mk("Draft C"), { openerStatus: "rejected", opener: "Line C" });
    await member(rep, await mk("Draft D"), {
      openerStatus: "drafted",
      opener: "Line D",
      nextStep: 2,
      stepsSent: 1,
    });
    await member(rep, await mk("Draft E"), {
      openerStatus: "drafted",
      opener: "Line E",
      status: "stopped",
    });
    const rows = await t.db.withUser(manager, (q) => draftedOpeners(q));
    expect(rows.map((r) => r.id)).toEqual([drafted]);
    expect(rows[0]).toMatchObject({ opener: "Line A", business_name: "Draft A", pool: "cold" });
    const held = await t.pool.query<{ h: number }>(
      "select extract(epoch from ($1::timestamptz - $2::timestamptz)) / 3600 as h",
      [rows[0]!.hold_until, rows[0]!.drafted_at],
    );
    expect(Number(held.rows[0]!.h)).toBe(OPENER_REVIEW_HOURS);
  });

  it("openerMode reads the shop setting", async () => {
    expect(await t.db.withUser(manager, (q) => openerMode(q))).toBe("review");
    await t.pool.query("update shop_settings set winback_opener_mode = 'auto'");
    expect(await t.db.withUser(manager, (q) => openerMode(q))).toBe("auto");
    await t.pool.query("update shop_settings set winback_opener_mode = 'review'");
  });
});

describe("funded: late payouts, eligible for more funds, corrections, statements", () => {
  let late: string;
  let paid: string;
  let eligible: string;
  let plain: string;
  let eligibleClient: string;

  it("fundedExtras flags the lender who is late, clears the one who paid, marks the eligible advance", async () => {
    const m1 = await merchant(rep, "Late Co");
    late = await funded(rep, m1);
    await t.pool.query(
      "update fundings set commission_expected_on = current_date - 12 where id = $1",
      [late],
    );
    const m2 = await merchant(rep, "Paid Co");
    paid = await funded(rep, m2);
    await t.pool.query(
      "update fundings set commission_expected_on = current_date - 12, commission_received_cents = commission_cents, commission_received_on = current_date where id = $1",
      [paid],
    );
    eligibleClient = await merchant(rep, "Eligible Co");
    eligible = await funded(rep, eligibleClient);
    await t.pool.query("update fundings set renewal_eligible_on = current_date - 1 where id = $1", [
      eligible,
    ]);
    await t.pool.query("update deals set outcome = 'funded' where client_id = $1", [
      eligibleClient,
    ]);
    plain = await funded(rep, await merchant(rep, "Plain Co"));

    const x = await t.db.withUser(rep, (q) =>
      fundedExtras(q, t.today, [late, paid, eligible, plain]),
    );
    expect(x[late]).toMatchObject({ late_days: 12, owed_cents: 600_000, eligible_more: false });
    expect(x[paid]).toMatchObject({ late_days: null, owed_cents: 0 });
    expect(x[eligible]).toMatchObject({ eligible_more: true, open_deal_id: null });
    // not late yet: ten days to go (negative), still owed
    expect(x[plain]).toMatchObject({ late_days: -10, eligible_more: false });
    expect(x[plain]!.expected_on).not.toBeNull();
  });

  it("an open renewal shows as the open deal on the eligible advance", async () => {
    const d = await t.db.withUser(rep, (q) => startRenewal(q, eligible));
    const x = await t.db.withUser(rep, (q) => fundedExtras(q, t.today, [eligible]));
    expect(x[eligible]).toMatchObject({
      eligible_more: true,
      open_deal_id: d.id,
      open_deal_number: d.number,
    });
  });

  it("a rep sees nothing for fundings that are not theirs", async () => {
    const x = await t.db.withUser(rep2, (q) => fundedExtras(q, t.today, [late, eligible]));
    expect(x).toEqual({});
    expect(await t.db.withUser(rep2, (q) => fundedExtras(q, t.today, []))).toEqual({});
  });

  it("corrections come back as dated ledger lines with who and why", async () => {
    await t.db.withUser(manager, (q) =>
      correctFunding(
        q,
        correctionSchema.parse({
          fundingId: late,
          reason: "the lender paid on 6 points",
          changes: { buyRate: "1.29" },
        }),
      ),
    );
    const lines = await t.db.withUser(rep, (q) => correctionsFor(q, [late, paid]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      funding_id: late,
      corrected_by_name: "Boss",
      reason: "the lender paid on 6 points",
      line_period: first,
      gross_cents: -50_000,
      rep_cents: -25_000,
    });
    expect(lines[0]!.line_on).toBe(t.today);
    expect(changeLines(lines[0]!)).toContain("Buy rate 1.28 → 1.29");
    expect(changeLines(lines[0]!)).toContain("Commission $6,000 → $5,500");
    const x = await t.db.withUser(rep, (q) => fundedExtras(q, t.today, [late]));
    expect(x[late]!.corrections).toHaveLength(1);
  });

  it("a past month with open lines is offered for closing; closing builds the statements each person may see", async () => {
    const old = await merchant(rep, "Old Month Co");
    const oldFunding = await funded(rep, old, {
      psf: "0",
      fundedOn: `${prevMonth.slice(0, 8)}15`,
    });
    expect(oldFunding).toBeTruthy();
    expect(await t.db.withUser(manager, (q) => monthsToClose(q))).toEqual([prevMonth]);
    expect(await t.db.withUser(manager, (q) => statementMonths(q))).toEqual([]);

    await t.db.withUser(manager, (q) => closeMonth(q, prevMonth));
    expect(await t.db.withUser(manager, (q) => monthsToClose(q))).toEqual([]);

    // the rep's own statement; the manager's override is its own line on the manager's statement
    const mine = await t.db.withUser(rep, (q) => statementMonths(q));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      period: prevMonth,
      statements: 1,
      line_count: 1,
      gross_cents: 350_000,
      rep_cents: 175_000,
    });
    expect(mine[0]!.closed_at).not.toBeNull();
    const all = await t.db.withUser(manager, (q) => statementMonths(q));
    expect(all[0]).toMatchObject({ statements: 2, line_count: 2, gross_cents: 350_000 });

    const period = prevMonth.slice(0, 7);
    const repView = await t.db.withUser(rep, (q) => statementsForPeriod(q, period));
    expect(repView?.statements.map((s) => s.name)).toEqual(["Josh"]);
    expect(repView?.statements[0]).toMatchObject({ gross_cents: 350_000, rep_cents: 175_000 });
    expect(repView?.statements[0]?.lines[0]).toMatchObject({
      kind: "expected",
      business: "Old Month Co",
      funder: "Pearl",
    });
    const boss = await t.db.withUser(manager, (q) => statementsForPeriod(q, period));
    expect(boss?.statements.map((s) => s.name).sort()).toEqual(["Boss", "Josh"]);
    expect(await t.db.withUser(manager, (q) => statementsForPeriod(q, "2001-01"))).toBeNull();
  });
});

describe("dashboard: speed numbers and the alert kinds in Do this now", () => {
  async function journey(
    owner: string,
    name: string,
    o: { created: number; sent: number; offer?: number; funded?: number; kicked?: boolean },
  ) {
    const id = await merchant(owner, name);
    await t.pool.query("update clients set created_at = $2 where id = $1", [id, at(o.created, 9)]);
    const d = (
      await t.pool.query<{ id: string }>(
        `insert into deals (user_id, client_id, kind, ops_status, queued_at, sent_at, kickback_count)
         values ($1, $2, 'new', 'sent', $3, $4, $5) returning id`,
        [owner, id, at(o.created, 10), at(o.sent, 9), o.kicked ? 1 : 0],
      )
    ).rows[0]!.id;
    const sub = (
      await t.pool.query<{ id: string }>(
        "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on) values ($1, $2, $3, $4, $5) returning id",
        [owner, id, pearl, d, on(o.sent)],
      )
    ).rows[0]!.id;
    if (o.offer !== undefined) {
      await t.pool.query(
        "insert into offers (user_id, client_id, submission_id, deal_id, amount_cents, factor_rate, received_on) values ($1, $2, $3, $4, 5000000, 1.3, $5)",
        [owner, id, sub, d, on(o.offer)],
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
        [owner, id, d, on(o.funded), at(o.funded, 15), manager],
      );
    }
    return id;
  }

  it("speedNumbers: medians in days for one person and for the shop, agreeing with the team scorecard", async () => {
    expect(await t.db.withUser(rep, (q) => speedNumbers(q, month, rep))).toMatchObject({
      lead_to_sub_days: null,
      sample: { lead_to_sub: 0, sub_to_offer: 0, approval_to_funded: 0 },
    });
    // rep: 4 and 2 days lead → sub; 2 and 1 days sub → offer; 4 and 2 days approval → funded
    await journey(rep, "Speed A", { created: 2, sent: 6, offer: 8, funded: 12, kicked: true });
    await journey(rep, "Speed B", { created: 3, sent: 5, offer: 6, funded: 8 });
    // rep2: ten days lead → sub, nothing after
    await journey(rep2, "Speed C", { created: 1, sent: 11 });

    const mine = await t.db.withUser(rep, (q) => speedNumbers(q, month, rep));
    expect(mine).toEqual({
      lead_to_sub_days: 3,
      sub_to_offer_days: 1.5,
      approval_to_funded_days: 3,
      sample: { lead_to_sub: 2, sub_to_offer: 2, approval_to_funded: 2 },
    });
    // the rep's own view without naming themselves is the same (RLS keeps it to their book)
    expect(await t.db.withUser(rep, (q) => speedNumbers(q, month))).toEqual(mine);
    // the shop: lead → sub over [4, 2, 10] is 4; the others are the rep's alone
    const shop = await t.db.withUser(manager, (q) => speedNumbers(q, month));
    expect(shop).toMatchObject({
      lead_to_sub_days: 4,
      sub_to_offer_days: 1.5,
      approval_to_funded_days: 3,
      sample: { lead_to_sub: 3 },
    });
    expect(
      (await t.db.withUser(manager, (q) => speedNumbers(q, month, rep2))).lead_to_sub_days,
    ).toBe(10);
    // the same numbers sit in the team scorecard row
    const row = (await t.db.withUser(manager, (q) => repScorecard(q, month, t.today))).find(
      (r) => r.user_id === rep,
    );
    expect(row).toMatchObject({
      lead_to_sub_days: mine.lead_to_sub_days,
      sub_to_offer_days: mine.sub_to_offer_days,
      approval_to_funded_days: mine.approval_to_funded_days,
      kickbacks: 1,
    });
    await expect(t.db.withUser(rep, (q) => speedNumbers(q, "November"))).rejects.toThrow(
      /bad month/,
    );
  });

  it("Do this now lists a lender that is late paying until it pays, and carries the funded month in its link", async () => {
    const now = await t.db.withUser(rep, (q) => nowItems(q, t.today, { manager: false }));
    const lateItems = now.filter((n) => n.kind === "late_payout");
    // the correction changed the late funding's commission to $5,500; the paid one is not listed
    expect(lateItems.map((n) => n.business_name)).toContain("Late Co");
    expect(lateItems.map((n) => n.business_name)).not.toContain("Paid Co");
    const item = lateItems.find((n) => n.business_name === "Late Co")!;
    expect(item).toMatchObject({
      label: "Chase Pearl for the commission",
      age_days: 12,
      cents: 550_000,
      href: `/funded?m=${month}`,
    });
    expect(item.detail).toMatch(/^\$5,500 was expected /);
    await t.pool.query(
      "update fundings set commission_received_cents = commission_cents, commission_received_on = current_date where id = $1",
      [
        (
          await t.pool.query<{ id: string }>("select id from fundings where client_id = $1", [
            item.client_id,
          ])
        ).rows[0]!.id,
      ],
    );
    const after = await t.db.withUser(rep, (q) => nowItems(q, t.today, { manager: false }));
    expect(after.some((n) => n.kind === "late_payout" && n.business_name === "Late Co")).toBe(
      false,
    );
    // a rep never sees another rep's late lender
    expect(
      (await t.db.withUser(rep2, (q) => nowItems(q, t.today, { manager: false }))).some(
        (n) => n.kind === "late_payout",
      ),
    ).toBe(false);
  });

  it("Do this now lists the person's own unread alerts of the kinds stream 3 added, and drops them once read", async () => {
    const ins = (user: string, kind: string, title: string, href: string, deal: string | null) =>
      t.pool.query<{ id: string }>(
        "insert into user_alerts (user_id, kind, title, body, href, deal_id) values ($1, $2, $3, 'Why', $4, $5) returning id",
        [user, kind, title, href, deal],
      );
    const trust = (await ins(manager, "trust", "Josh copied contact details 31 times", "", null))
      .rows[0]!.id;
    await ins(
      manager,
      "registration",
      "NY broker registration renews on Dec 01 (15 days)",
      "/settings",
      null,
    );
    await ins(manager, "kickback", "Ops kicked back something", "/deals/x", null);
    await ins(rep2, "trust", "Someone else's alert", "", null);
    // each person sees their own alerts only
    const other = await t.db.withUser(rep2, (q) => nowItems(q, t.today, { manager: false }));
    expect(other.filter((n) => n.kind === "trust").map((n) => n.label)).toEqual([
      "Someone else's alert",
    ]);

    const mgr = await t.db.withUser(manager, (q) => nowItems(q, t.today, { manager: true }));
    const kinds = mgr.map((n) => n.kind);
    expect(kinds).toContain("trust");
    expect(kinds).toContain("registration");
    expect(kinds).not.toContain("stale_deal");
    const trustItem = mgr.find((n) => n.kind === "trust" && n.label.startsWith("Josh copied"))!;
    expect(trustItem).toMatchObject({
      client_id: null,
      business_name: "",
      href: "/alerts",
      detail: "Why",
    });
    expect(mgr.find((n) => n.kind === "registration")?.href).toBe("/settings");
    // trust outranks everything a manager is shown
    expect(mgr[0]?.kind).toBe("trust");

    await t.pool.query("update user_alerts set read_at = now() where id = $1", [trust]);
    const read = await t.db.withUser(manager, (q) => nowItems(q, t.today, { manager: true }));
    expect(read.some((n) => n.label.startsWith("Josh copied"))).toBe(false);
    expect(read.some((n) => n.kind === "registration")).toBe(true);

    const lonely = await merchant(rep, "Sitting Co");
    const sitting = await deal(rep, lonely, "sent");
    await t.pool.query(
      "insert into submissions (user_id, client_id, funder_id, deal_id, sent_on, status) values ($1, $2, $3, $4, current_date - 1, 'sent')",
      [rep, lonely, pearl, sitting],
    );
    await ins(
      rep,
      "stale_deal",
      "Sitting Co has sat pending lenders for 5 days",
      `/deals/${sitting}`,
      sitting,
    );
    const mine = await t.db.withUser(rep, (q) => nowItems(q, t.today, { manager: false }));
    const stuck = mine.find((n) => n.kind === "stale_deal");
    expect(stuck).toMatchObject({ deal_id: sitting, href: `/deals/${sitting}` });
    // the same deal arriving through a live source (a submission with no answer in 3+ days) drops the alert
    await t.pool.query("update submissions set sent_on = current_date - 5 where deal_id = $1", [
      sitting,
    ]);
    const dup = await t.db.withUser(rep, (q) => nowItems(q, t.today, { manager: false }));
    expect(dup.filter((n) => n.deal_id === sitting).map((n) => n.kind)).toEqual([
      "stale_submission",
    ]);
  });
});
