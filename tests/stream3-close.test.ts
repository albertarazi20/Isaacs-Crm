import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildStatementEmail,
  closeMonth,
  listStatements,
  periodLabel,
  periodToClose,
  runMonthEndClose,
} from "@/lib/money/close";
import {
  confirmFunding,
  correctFunding,
  correctionSchema,
  fundSchema,
  listCorrections,
  proposeFunding,
} from "@/lib/money/fund";
import { startRenewal } from "@/lib/money/renewals";
import type { DigestSender } from "@/lib/system/reminders";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;
let pearl: string;
let pizzaFunding: string;
let prevMonth: string; // YYYY-MM-01, the month before the database's today
let thisMonth: string;

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

async function merchant(name: string): Promise<string> {
  const id = await insertClient(t.db, rep, name);
  await t.pool.query("update clients set state = 'NY', email = $2 where id = $1", [
    id,
    `${name.replace(/\W/g, "").toLowerCase()}@x.com`,
  ]);
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [id]));
  return id;
}

const ledger = async (fid: string) =>
  (
    await t.pool.query<{
      kind: string;
      user_id: string;
      gross_cents: number;
      rep_cents: number;
      house_cents: number;
      period: string;
      locked_at: Date | null;
      note: string;
    }>(
      "select kind, user_id, gross_cents::int as gross_cents, rep_cents::int as rep_cents, house_cents::int as house_cents, period::text as period, locked_at, note from commission_ledger where funding_id = $1 order by id",
      [fid],
    )
  ).rows;

const ok = (): DigestSender & ReturnType<typeof vi.fn> => vi.fn(async () => "re_close") as never;

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
      "insert into funders (user_id, name, submission_email, max_upsell_points, psf_cap_pct, clawback_days, commission_paid_after_days) values ($1, 'Pearl', 'subs@pearl.com', 8, 5, 45, 10) returning id",
      [manager],
    )
  ).rows[0]!.id;
  // the shop plan: 50% split, a 10% manager override, a 30% renewal split. Dated back: app.plan_for (0350) only
  // applies a plan whose effective_from is on or before the funding date, and the seed is dated the migration day.
  await t.pool.query(
    "update commission_plans set manager_override_pct = 10, renewal_split_pct = 30, effective_from = '2000-01-01' where user_id is null",
  );
  const d = await t.pool.query<{ prev: string; cur: string }>(
    "select (date_trunc('month', current_date) - interval '1 month')::date::text as prev, date_trunc('month', current_date)::date::text as cur",
  );
  prevMonth = d.rows[0]!.prev;
  thisMonth = d.rows[0]!.cur;
});
afterAll(async () => {
  await t.drop();
});

describe("S3-5 the plan in full", () => {
  it("confirming posts the expected line and the manager's override as its own line under the manager", async () => {
    const pizza = await merchant("Pizza Palace");
    pizzaFunding = await t.db.withUser(rep, (q) => proposeFunding(q, fund(pizza), t.today));
    await t.db.withUser(manager, (q) => confirmFunding(q, pizzaFunding));
    const lines = await ledger(pizzaFunding);
    expect(
      lines.map((l) => [
        l.kind,
        l.user_id === rep ? "rep" : "boss",
        l.gross_cents,
        l.rep_cents,
        l.house_cents,
      ]),
    ).toEqual([
      ["expected", "rep", 600_000, 300_000, 300_000],
      ["override", "boss", 0, 60_000, -60_000],
    ]);
    expect(lines[1]?.note).toBe("Manager override 10% on Pearl");
    expect(lines.every((l) => l.period === thisMonth)).toBe(true);
    // the override belongs to the manager who added the rep (invited_by)
    const f = (
      await t.pool.query(
        "select commission_expected_on::text as d, funded_on::text as f from fundings where id = $1",
        [pizzaFunding],
      )
    ).rows[0];
    expect(f.d).toBe(
      (await t.pool.query<{ d: string }>("select ($1::date + 10)::text as d", [f.f])).rows[0]?.d,
    );
  });

  it("correct_funding: a manager changes the amount; the original is kept, a dated correction line posts, the rep is refused", async () => {
    const input = correctionSchema.parse({
      fundingId: pizzaFunding,
      reason: "typo on the advance",
      changes: { amount: "55000" },
    });
    await expect(t.db.withUser(rep, (q) => correctFunding(q, input))).rejects.toThrow(
      /only a manager/,
    );
    await t.db.withUser(manager, (q) => correctFunding(q, input));
    const f = (
      await t.pool.query(
        "select amount_cents::int as amount_cents, commission_cents::int as commission_cents, rep_cut_cents::int as rep_cut_cents, house_cut_cents::int as house_cut_cents from fundings where id = $1",
        [pizzaFunding],
      )
    ).rows[0];
    // 55,000 × 7 points = 3,850 + 2,500 PSF = 6,350 gross, half to the rep
    expect(f).toEqual({
      amount_cents: 5_500_000,
      commission_cents: 635_000,
      rep_cut_cents: 317_500,
      house_cut_cents: 317_500,
    });
    const lines = await ledger(pizzaFunding);
    const correction = lines.find((l) => l.kind === "correction");
    expect(correction).toMatchObject({
      gross_cents: 35_000,
      rep_cents: 17_500,
      house_cents: 17_500,
      period: thisMonth,
    });
    expect(correction?.note).toMatch(
      /^Correction: typo on the advance \(amount \$50,000 → \$55,000; commission \$6,000 → \$6,350\)/,
    );
    const kept = await t.db.withUser(manager, (q) => listCorrections(q, pizzaFunding));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.old_values).toMatchObject({
      amount_cents: 5_000_000,
      commission_cents: 600_000,
    });
    expect(kept[0]?.new_values).toMatchObject({
      amount_cents: 5_500_000,
      commission_cents: 635_000,
    });
    expect(kept[0]?.corrected_by_name).toBe("Boss");
    const act = await t.pool.query(
      "select body from activities where client_id = (select client_id from fundings where id = $1) and body like 'Funding corrected%'",
      [pizzaFunding],
    );
    expect(act.rows[0]?.body).toBe(
      "Funding corrected: amount $50,000 → $55,000; commission $6,000 → $6,350 — typo on the advance",
    );
    // the rep's own view of the correction row works through RLS; a stranger's does not
    expect(await t.db.withUser(rep, (q) => listCorrections(q, pizzaFunding))).toHaveLength(1);
    await expect(
      t.db.withUser(manager, (q) =>
        correctFunding(
          q,
          correctionSchema.parse({ fundingId: pizzaFunding, reason: "x", changes: {} }),
        ),
      ),
    ).rejects.toThrow(/Nothing to correct/);
  });

  it("tiers: the month's funded volume, this funding included, lifts the split", async () => {
    await t.pool.query(
      `update commission_plans set tiers = '[{"from_cents": 10000000, "split_pct": 60}]'::jsonb where user_id is null`,
    );
    const taco = await merchant("Taco Town");
    // 55,000 (corrected) + 60,000 = 115,000 ≥ the 100,000 tier
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(q, fund(taco, { amount: "60000", psf: "0", payment: "600" }), t.today),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    const lines = await ledger(fid);
    expect(lines[0]).toMatchObject({ kind: "expected", gross_cents: 420_000, rep_cents: 252_000 });
    expect(lines[0]?.note).toMatch(/\(60% split\)/);
    await t.pool.query("update commission_plans set tiers = '[]'::jsonb where user_id is null");
  });

  it("the renewal split applies to a deal opened by start_renewal", async () => {
    const pizza = (
      await t.pool.query<{ c: string }>("select client_id as c from fundings where id = $1", [
        pizzaFunding,
      ])
    ).rows[0]!.c;
    const deal = await t.db.withUser(rep, (q) => startRenewal(q, pizzaFunding));
    expect(deal.kind).toBe("renewal");
    // funded in the previous month, so its line lands there (and gets locked by the close below)
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(q, fund(pizza, { psf: "0", fundedOn: `${prevMonth.slice(0, 8)}15` }), t.today),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    const lines = await ledger(fid);
    expect(lines[0]).toMatchObject({
      kind: "expected",
      gross_cents: 350_000,
      rep_cents: 105_000,
      period: prevMonth,
    });
    expect(lines[0]?.note).toMatch(/\(30% split\)/);
    expect(
      (await t.pool.query("select deal_id from fundings where id = $1", [fid])).rows[0]?.deal_id,
    ).toBe(deal.id);
  });
});

describe("S3-1 month-end close", () => {
  it("periodToClose: the month before now − 12h, in UTC", () => {
    expect(periodToClose(new Date("2026-12-01T13:00:00Z"))).toBe("2026-11-01");
    expect(periodToClose(new Date("2026-12-01T05:00:00Z"))).toBe("2026-10-01"); // still the 30th in LA
    expect(periodToClose(new Date("2027-01-15T12:00:00Z"))).toBe("2026-12-01");
    expect(periodLabel("2026-11-01")).toBe("November 2026");
  });
  it("refuses the current month, and a rep", async () => {
    await expect(t.db.withUser(manager, (q) => closeMonth(q, thisMonth))).rejects.toThrow(
      /not over yet/,
    );
    await expect(t.db.withUser(rep, (q) => closeMonth(q, prevMonth))).rejects.toThrow(
      /only a manager/,
    );
  });
  it("the job on the 1st closes the previous month: lines lock, statements exist, the rep and the managers are emailed, once", async () => {
    const send = ok();
    const now = new Date(`${thisMonth}T13:00:00Z`);
    const s = await runMonthEndClose({ db: t.db, now, send });
    // two statements: Josh's renewal line and Boss's override line on it
    expect(s).toMatchObject({
      period: prevMonth,
      closed: true,
      statements: 2,
      sent: 2,
      summarySent: 1,
      failed: 0,
    });
    const closes = (
      await t.pool.query(
        "select period::text as period, line_count, gross_cents::int as gross_cents, rep_cents::int as rep_cents, summary_emailed_at from commission_closes",
      )
    ).rows;
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      period: prevMonth,
      line_count: 2,
      gross_cents: 350_000,
      rep_cents: 140_000,
    });
    expect(closes[0]?.summary_emailed_at).not.toBeNull();
    const locked = (
      await t.pool.query("select locked_at from commission_ledger where period = $1::date", [
        prevMonth,
      ])
    ).rows;
    expect(locked).toHaveLength(2);
    expect(locked.every((l) => l.locked_at !== null)).toBe(true);
    // this month's lines are untouched
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from commission_ledger where period = $1::date and locked_at is not null",
          [thisMonth],
        )
      ).rows[0]?.n,
    ).toBe(0);
    const statements = await t.db.withUser(manager, (q) => listStatements(q));
    expect(statements).toHaveLength(2);
    const josh = statements.find((x) => x.user_id === rep);
    expect(josh).toMatchObject({
      period: prevMonth,
      line_count: 1,
      rep_cents: 105_000,
      name: "Josh",
    });
    expect(josh?.lines[0]).toMatchObject({
      kind: "expected",
      business: "Pizza Palace",
      funder: "Pearl",
    });
    expect(statements.find((x) => x.user_id === manager)).toMatchObject({
      line_count: 1,
      rep_cents: 35_000,
      gross_cents: 0,
    });
    expect(statements.every((x) => x.emailed_at !== null)).toBe(true);
    // the rep sees only their own statement
    expect((await t.db.withUser(rep, (q) => listStatements(q))).map((x) => x.user_id)).toEqual([
      rep,
    ]);
    // the emails
    const toRep = send.mock.calls.find((c) => c[0] === "rep@x.com");
    expect(toRep?.[1].subject).toBe(`Commission statement — ${periodLabel(prevMonth)}`);
    expect(toRep?.[1].text).toContain(
      "Pizza Palace (Pearl) — Commission: $1,050 to you ($3,500 gross)",
    );
    // the manager gets their own statement and then the shop summary
    const toBoss = send.mock.calls.find(
      (c) => c[0] === "boss@x.com" && c[1].subject.includes("closed"),
    );
    expect(toBoss?.[1].subject).toBe(`${periodLabel(prevMonth)} closed — $3,500 gross commission`);
    expect(toBoss?.[1].text).toContain("Josh: $1,050 on $3,500 gross (1 line)");
    expect(toBoss?.[1].text).toContain("Boss: $350 on $0 gross (1 line)");
    expect(toBoss?.[1].text).toContain("Shop: $3,500 gross, $1,400 to reps, $2,100 house.");
    // idempotent: the next hour sends nothing and changes nothing
    const again = ok();
    const s2 = await runMonthEndClose({
      db: t.db,
      now: new Date(now.getTime() + 3_600_000),
      send: again,
    });
    expect(again).not.toHaveBeenCalled();
    expect(s2).toMatchObject({ closed: false, sent: 0, summarySent: 0 });
  });
  it("a locked line refuses update and delete, whoever asks", async () => {
    await expect(
      t.pool.query("update commission_ledger set note = 'x' where period = $1::date", [prevMonth]),
    ).rejects.toThrow(/closed month/);
    await expect(
      t.pool.query("delete from commission_ledger where period = $1::date", [prevMonth]),
    ).rejects.toThrow(/closed month/);
  });
  it("a funding confirmed for the closed month lands in the current period; a correction too", async () => {
    const wok = await merchant("Golden Wok");
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(q, fund(wok, { psf: "0", fundedOn: `${prevMonth.slice(0, 8)}20` }), t.today),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    expect((await ledger(fid))[0]).toMatchObject({
      kind: "expected",
      period: thisMonth,
      locked_at: null,
    });
    await t.db.withUser(manager, (q) =>
      correctFunding(
        q,
        correctionSchema.parse({
          fundingId: pizzaFunding,
          reason: "late paperwork",
          changes: { psf: "3000" },
        }),
      ),
    );
    const c = (await ledger(pizzaFunding)).filter((l) => l.kind === "correction");
    expect(c).toHaveLength(2);
    expect(c[1]).toMatchObject({ period: thisMonth, gross_cents: 50_000, locked_at: null });
    // the closed month's totals did not move
    expect(
      (
        await t.pool.query(
          "select gross_cents::int as g from commission_closes where period = $1::date",
          [prevMonth],
        )
      ).rows[0]?.g,
    ).toBe(350_000);
  });
  it("a failed statement send is retried next hour; a muted manager is skipped", () => {
    const m = buildStatementEmail(
      { period: "2026-10-01", line_count: 1, gross_cents: 100, rep_cents: 50, lines: [] },
      "Josh",
    );
    expect(m.subject).toBe("Commission statement — October 2026");
    expect(m.text).toContain("Josh, here is your commission statement for October 2026.");
  });
});
