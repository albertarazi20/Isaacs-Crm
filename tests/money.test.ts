import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confirmFunding,
  fundSchema,
  listFunded,
  monthTotals,
  previewFund,
  proposeFunding,
  recordCommissionPaid,
} from "@/lib/money/fund";
import { listWinback, runWinback } from "@/lib/money/winback";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;
let pizza: string;
let pearl: string;

const fund = (over: Record<string, unknown> = {}) =>
  fundSchema.parse({
    clientId: pizza,
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

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  await t.pool.query("update clients set state = 'FL', email = 'mike@pizza.com' where id = $1", [
    pizza,
  ]);
  pearl = (
    await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name, submission_email, max_upsell_points, psf_cap_pct, clawback_days, renewal_paydown_pct) values ($1, 'Pearl', 'subs@pearl.com', 8, 5, 45, 50) returning id",
      [manager],
    )
  ).rows[0]?.id as string;
  await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [pizza]));
});
afterAll(async () => {
  await t.drop();
});

describe("FUND", () => {
  it("the preview does the maths: points = sell − buy, gross = amount × points + PSF, rep cut by the plan", async () => {
    const p = await t.db.withUser(rep, (q) => previewFund(q, fund(), rep, "2026-11-16"));
    expect(p.points).toBe(7);
    expect(p.paybackCents).toBe(6_750_000);
    expect(p.grossCommissionCents).toBe(350_000 + 250_000);
    expect(p.splitPct).toBe(50);
    expect(p.repCutCents).toBe(300_000);
    expect(p.netToMerchantCents).toBe(5_000_000 - 250_000);
    expect(p.warnings).toEqual([]);
    const over = await t.db.withUser(rep, (q) =>
      previewFund(q, fund({ buyRate: "1.25" }), rep, "2026-11-16"),
    );
    expect(over.warnings[0]).toMatch(/caps points at 8/);
  });
  it("the checklist knows Florida bans a fee before closing", async () => {
    const c = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ c: { state: string; items: { key: string; required: boolean }[] } }>(
            "select fund_checklist($1) as c",
            [pizza],
          )
        ).rows[0]?.c,
    );
    expect(c?.state).toBe("FL");
    expect(c?.items.find((i) => i.key === "psf_at_closing")?.required).toBe(true);
    expect(c?.items.find((i) => i.key === "shop_registered")?.required).toBe(false);
  });
  it("the database refuses points above the lender's cap and a PSF above its cap", async () => {
    await expect(
      t.db.withUser(rep, (q) => proposeFunding(q, fund({ buyRate: "1.25" }), "2026-11-16")),
    ).rejects.toThrow(/caps points at 8/);
    await expect(
      t.db.withUser(rep, (q) => proposeFunding(q, fund({ psf: "5000" }), "2026-11-16")),
    ).rejects.toThrow(/caps the PSF/);
  });
  it("a rep proposes; nothing posts to the ledger until a manager confirms", async () => {
    const fid = await t.db.withUser(rep, (q) => proposeFunding(q, fund(), "2026-11-16"));
    const f = (
      await t.pool.query(
        "select confirmed_at, ledger_state, points::text, psf_cents, commission_cents, clawback_until::text, renewal_eligible_on::text, deal_id from fundings where id = $1",
        [fid],
      )
    ).rows[0];
    expect(f.confirmed_at).toBeNull();
    expect(f.ledger_state).toBe("expected");
    expect(f.points).toBe("7.00");
    expect(f.psf_cents).toBe(250_000);
    expect(f.commission_cents).toBe(600_000);
    expect(f.clawback_until).toBe("2026-12-31");
    expect(f.renewal_eligible_on).not.toBeNull();
    expect(f.deal_id).not.toBeNull();
    expect((await t.pool.query("select count(*)::int as n from commission_ledger")).rows[0].n).toBe(
      0,
    );
    await expect(t.db.withUser(rep, (q) => confirmFunding(q, fid))).rejects.toThrow(
      /only a manager/,
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    const after = (
      await t.pool.query(
        "select ledger_state, rep_cut_cents, house_cut_cents from fundings where id = $1",
        [fid],
      )
    ).rows[0];
    expect(after).toEqual({
      ledger_state: "at_risk",
      rep_cut_cents: 300_000,
      house_cut_cents: 300_000,
    });
    const ledger = (
      await t.pool.query(
        "select kind, gross_cents, rep_cents from commission_ledger order by created_at",
      )
    ).rows;
    expect(ledger).toEqual([{ kind: "expected", gross_cents: 600_000, rep_cents: 300_000 }]);
    // the deal closed as funded, the lender row says funded, the merchant left every chase
    const deal = (await t.pool.query("select outcome from deals where client_id = $1", [pizza]))
      .rows[0];
    expect(deal.outcome).toBe("funded");
  });
  it("a payment from the lender posts a paid line; past the window the funding clears", async () => {
    const fid = (
      await t.pool.query<{ id: string }>("select id from fundings where client_id = $1", [pizza])
    ).rows[0]?.id as string;
    await t.db.withUser(manager, (q) =>
      recordCommissionPaid(q, { fundingId: fid, cents: 600_000, on: "2026-11-25" }),
    );
    expect(
      (
        await t.pool.query(
          "select ledger_state, commission_received_cents from fundings where id = $1",
          [fid],
        )
      ).rows[0],
    ).toEqual({ ledger_state: "paid", commission_received_cents: 600_000 });
    await t.pool.query("update fundings set clawback_until = current_date - 1 where id = $1", [
      fid,
    ]);
    const r = (await t.pool.query("select * from roll_funding_clocks()")).rows[0];
    expect(r.cleared).toBe(1);
    expect(
      (await t.pool.query("select ledger_state from fundings where id = $1", [fid])).rows[0]
        .ledger_state,
    ).toBe("clear");
    const sheet = await t.db.withUser(rep, (q) => listFunded(q));
    expect(sheet).toHaveLength(1);
    expect(sheet[0]?.points).toBe(7);
    const totals = await t.db.withUser(manager, (q) => monthTotals(q));
    expect(totals[0]?.funded_cents).toBe(5_000_000);
    expect(totals[0]?.rep_cut_cents).toBe(300_000);
  });
  it("a default inside the clawback window flips the commission to clawed back with a negative ledger line", async () => {
    const taco = await insertClient(t.db, rep, "Taco Town");
    await t.pool.query("update clients set email = 't@t.com' where id = $1", [taco]);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [taco]));
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(q, fund({ clientId: taco, psf: "0" }), "2026-11-16"),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    await t.pool.query(
      "update fundings set status = 'defaulted', defaulted_on = '2026-12-01' where id = $1",
      [fid],
    );
    expect(
      (await t.pool.query("select ledger_state from fundings where id = $1", [fid])).rows[0]
        .ledger_state,
    ).toBe("clawed_back");
    const claw = (
      await t.pool.query(
        "select kind, gross_cents, rep_cents from commission_ledger where funding_id = $1 and kind = 'clawback'",
        [fid],
      )
    ).rows[0];
    expect(claw).toEqual({ kind: "clawback", gross_cents: -350_000, rep_cents: -175_000 });
  });
});

describe("Winback pools", () => {
  it("an approval older than 30 days with no funding joins the pool, becomes active, and gets its first email", async () => {
    const wok = await insertClient(t.db, rep, "Golden Wok");
    await t.pool.query("update clients set email = 'wok@x.com', state = 'NY' where id = $1", [wok]);
    await t.db.withUser(rep, (q) => q.query("select submit_to_ops($1)", [wok]));
    const sub = await t.db.withUser(
      manager,
      async (q) =>
        (
          await q.query<{ id: string }>("select id from create_submissions($1, $2::uuid[])", [
            wok,
            [pearl],
          ])
        ).rows[0],
    );
    await t.db.withUser(manager, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        sub?.id,
        JSON.stringify({ amount_cents: 8_000_000, factor_rate: 1.3 }),
      ]),
    );
    await t.pool.query(
      "update submissions set responded_at = now() - interval '40 days' where id = $1",
      [sub?.id],
    );
    const s = await runWinback({ db: t.db, appUrl: "https://crm.test" });
    expect(s.refreshed).toBeGreaterThanOrEqual(1);
    const board = await t.db.withUser(rep, listWinback);
    const row = board.find((r) => r.client_id === wok);
    expect(row?.pool).toBe("approved_unfunded");
    expect(row?.reason).toMatch(/Approved \$80,000 by Pearl/);
    expect(row?.status).toBe("active");
    const ob = (
      await t.pool.query("select source, subject from outbox where client_id = $1", [wok])
    ).rows;
    expect(ob).toHaveLength(1);
    expect(ob[0].source).toBe("winback:approved_unfunded:1");
    expect(ob[0].subject).toContain("Golden Wok");
    const m = (
      await t.pool.query(
        "select next_step, next_due_on::text, steps_sent from winback_members where client_id = $1",
        [wok],
      )
    ).rows[0];
    expect(m.next_step).toBe(2);
    expect(m.steps_sent).toBe(1);
  });
  it("funding the merchant ends their membership as recovered", async () => {
    const wok = (
      await t.pool.query<{ id: string }>(
        "select id from clients where business_name = 'Golden Wok'",
      )
    ).rows[0]?.id as string;
    const fid = await t.db.withUser(rep, (q) =>
      proposeFunding(q, fund({ clientId: wok, psf: "0" }), "2026-11-20"),
    );
    await t.db.withUser(manager, (q) => confirmFunding(q, fid));
    await runWinback({ db: t.db, appUrl: "https://crm.test" });
    const m = (
      await t.pool.query("select status, stop_reason from winback_members where client_id = $1", [
        wok,
      ])
    ).rows[0];
    expect(m).toEqual({ status: "recovered", stop_reason: "funded" });
  });
});
