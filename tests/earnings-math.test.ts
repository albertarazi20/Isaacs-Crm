import { describe, expect, it } from "vitest";
import {
  averagePoints,
  centsFromPoints,
  commissionNote,
  estimateCommission,
  expectedCommission,
  formatPoints,
  pointsOf,
  sumCommission,
  type CommissionContext,
} from "@/lib/earnings/commission";
import { earnedSummary, monthLabel, monthRows, shiftMonth } from "@/lib/earnings/earned";
import {
  AWAITING_WINDOW_DAYS,
  awaitingCommission,
  pipelineDeals,
  renewalForecast,
} from "@/lib/earnings/expected";
import { niceScale } from "@/components/earnings/MonthChart";
import type { AdvanceRow, DealRow, OfferRow } from "@/lib/earnings/types";

const TODAY = "2026-10-23"; // a Friday

let n = 0;
function adv(over: Partial<AdvanceRow> = {}): AdvanceRow {
  n += 1;
  return {
    id: `f${n}`,
    clientId: `c${n}`,
    businessName: `Merchant ${n}`,
    industry: "Retail",
    stage: "funded",
    contactStatus: "ok",
    fundedOn: "2026-10-01",
    funderName: "Alpha Capital",
    amountCents: 5_000_000,
    factorRate: 1.32,
    paybackCents: 6_600_000,
    paymentCents: 55_000,
    frequency: "daily",
    positionNo: 1,
    termDays: null,
    commissionCents: null,
    commissionReceivedCents: null,
    commissionReceivedOn: null,
    paidBackOverrideCents: null,
    status: "active",
    ...over,
  };
}

const NO_AVERAGE: CommissionContext = { average: null };

describe("points and commission", () => {
  it("converts between dollars and points", () => {
    expect(pointsOf(250_000, 5_000_000)).toBe(5);
    expect(pointsOf(100, 0)).toBeNull();
    expect(centsFromPoints(5, 5_000_000)).toBe(250_000);
    expect(centsFromPoints(6.5, 3_333_300)).toBe(216_665);
    expect(formatPoints(5.2)).toBe("5.2");
    expect(formatPoints(4.999)).toBe("5");
    expect(formatPoints(5.1949)).toBe("5.19");
  });

  it("averages his own points from the advances that have a commission", () => {
    const avg = averagePoints([
      adv({ commissionCents: 250_000 }), // 5 pts
      adv({ commissionCents: 300_000 }), // 6 pts
      adv({ commissionCents: null, commissionReceivedCents: 200_000 }), // 4 pts, from what he received
      adv({ commissionCents: 0 }), // an entered zero is not evidence of his price
      adv({ commissionCents: null }), // nothing
    ]);
    expect(avg).not.toBeNull();
    expect(avg?.n).toBe(3);
    expect(avg?.points).toBeCloseTo(5, 10);
  });

  it("says nothing when there is no history, instead of inventing a number", () => {
    expect(averagePoints([])).toBeNull();
    expect(averagePoints([adv(), adv()])).toBeNull();
  });

  it("prices an advance: entered, then received, then the funder's points, then his average, else unknown", () => {
    const ctx: CommissionContext = {
      average: { points: 5, n: 4 },
      funderPoints: new Map([["pearl funding", 8]]),
    };
    expect(expectedCommission(adv({ commissionCents: 111_100 }), ctx)).toEqual({
      cents: 111_100,
      basis: "entered",
    });
    expect(expectedCommission(adv({ commissionReceivedCents: 99_900 }), ctx)).toEqual({
      cents: 99_900,
      basis: "entered",
    });
    expect(expectedCommission(adv({ funderName: " Pearl Funding " }), ctx)).toEqual({
      cents: 400_000,
      basis: "funder",
      points: 8,
    });
    expect(expectedCommission(adv({ funderName: "Somebody Else" }), ctx)).toEqual({
      cents: 250_000,
      basis: "estimate",
      points: 5,
    });
    expect(expectedCommission(adv(), NO_AVERAGE)).toBeNull();
  });

  it("an advance with an entered $0 commission is $0, not unknown", () => {
    expect(expectedCommission(adv({ commissionCents: 0 }), NO_AVERAGE)).toEqual({
      cents: 0,
      basis: "entered",
    });
  });

  it("estimateCommission refuses an amount that is not positive", () => {
    expect(estimateCommission(0, "x", { average: { points: 5, n: 3 } })).toBeNull();
  });

  it("sums known figures and counts the unknown ones instead of treating them as $0", () => {
    const sum = sumCommission([
      { cents: 1000, basis: "entered" },
      { cents: 500, basis: "estimate" },
      null,
    ]);
    expect(sum).toEqual({ cents: 1500, known: 2, unknown: 1, estimated: 1 });
    expect(sumCommission([])).toEqual({ cents: 0, known: 0, unknown: 0, estimated: 0 });
  });

  it("explains every estimate in a sentence", () => {
    const avg = { points: 5.2, n: 7 };
    expect(commissionNote({ cents: 1, basis: "entered" }, avg)).toMatch(/entered/);
    expect(commissionNote({ cents: 260_000, basis: "estimate", points: 5.2 }, avg, 5_000_000)).toBe(
      "Estimate: your average 5.2 points (the average of 7 advances with a commission on record) × $50,000.",
    );
    expect(commissionNote({ cents: 1, basis: "funder", points: 8 }, null)).toContain(
      "funder's 8 points",
    );
  });
});

describe("what he has earned", () => {
  const received = (cents: number, on: string, over: Partial<AdvanceRow> = {}) =>
    adv({ commissionReceivedCents: cents, commissionReceivedOn: on, ...over });

  it("sums this month, last month and the year by the day the commission arrived", () => {
    const s = earnedSummary(
      [
        received(250_000, "2026-10-02"),
        received(100_000, "2026-10-22"),
        received(300_000, "2026-09-30"),
        received(400_000, "2026-03-15"),
        received(900_000, "2025-12-31"), // last year: not in YTD
        adv({ commissionCents: 999_999 }), // expected, never received: not earned
      ],
      TODAY,
    );
    expect(s.thisMonthCents).toBe(350_000);
    expect(s.thisMonthCount).toBe(2);
    expect(s.lastMonthCents).toBe(300_000);
    expect(s.ytdCents).toBe(250_000 + 100_000 + 300_000 + 400_000);
    expect(s.ytdCount).toBe(4);
    expect(s.entries).toBe(5);
  });

  it("last month in January is December of the year before, and YTD starts over", () => {
    const s = earnedSummary(
      [received(500_000, "2025-12-20"), received(100_000, "2026-01-02")],
      "2026-01-05",
    );
    expect(s.lastMonthCents).toBe(500_000);
    expect(s.thisMonthCents).toBe(100_000);
    expect(s.ytdCents).toBe(100_000);
  });

  it("is all zeros with nothing recorded", () => {
    expect(earnedSummary([], TODAY)).toEqual({
      thisMonthCents: 0,
      lastMonthCents: 0,
      ytdCents: 0,
      thisMonthCount: 0,
      lastMonthCount: 0,
      ytdCount: 0,
      entries: 0,
    });
  });

  it("walks the calendar months, including quiet ones, oldest first", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-10", -11)).toBe("2025-11");
    expect(monthLabel("2026-10")).toBe("Oct 2026");
    expect(monthLabel("2026-10", true)).toBe("Oct");
    const rows = monthRows(
      [
        received(250_000, "2026-10-02", { fundedOn: "2026-10-01", amountCents: 3_000_000 }),
        received(100_000, "2026-08-20", { fundedOn: "2026-08-10" }),
        adv({ fundedOn: "2026-08-12" }),
        adv({ fundedOn: "2024-01-01" }), // outside the 12 months: dropped, not mis-bucketed
      ],
      TODAY,
    );
    expect(rows).toHaveLength(12);
    expect(rows[0]?.key).toBe("2025-11");
    expect(rows[11]?.key).toBe("2026-10");
    expect(rows[11]).toMatchObject({
      fundedCount: 1,
      fundedCents: 3_000_000,
      commissionCents: 250_000,
    });
    const aug = rows.find((r) => r.key === "2026-08");
    expect(aug).toMatchObject({
      fundedCount: 2,
      fundedCents: 10_000_000,
      commissionCents: 100_000,
    });
    expect(rows.find((r) => r.key === "2026-09")).toMatchObject({
      fundedCount: 0,
      commissionCents: 0,
    });
    expect(monthRows([], TODAY).every((r) => r.fundedCount === 0 && r.commissionCents === 0)).toBe(
      true,
    );
  });

  it("puts the gridlines on round numbers", () => {
    expect(niceScale(3000)).toEqual({ step: 1000, max: 3000 });
    expect(niceScale(2750)).toEqual({ step: 1000, max: 3000 });
    expect(niceScale(490_000)).toEqual({ step: 200_000, max: 600_000 });
    expect(niceScale(0)).toEqual({ step: 1, max: 1 });
    for (const v of [4, 7, 99, 1234, 80_000, 1_234_567]) {
      const { step, max } = niceScale(v);
      expect(max).toBeGreaterThanOrEqual(v);
      expect(max / step).toBeLessThanOrEqual(5);
      expect(String(step)).toMatch(/^[125]0*$/);
    }
  });
});

describe("what is on its way: funded, not yet received", () => {
  const ctx: CommissionContext = { average: { points: 5, n: 3 } };

  it("counts recent advances with nothing received, and sets older ones aside", () => {
    const a = awaitingCommission(
      [
        adv({ fundedOn: "2026-10-10", commissionCents: 260_000 }),
        adv({ fundedOn: "2026-09-01" }), // 52 days, no commission entered: an estimate
        adv({ fundedOn: "2026-06-01", commissionCents: 999_000 }), // older than 90 days
        adv({ fundedOn: "2026-10-05", commissionReceivedCents: 1, commissionReceivedOn: TODAY }),
        adv({ fundedOn: "2026-10-05", status: "defaulted" }),
      ],
      TODAY,
      ctx,
    );
    expect(a.recent).toHaveLength(2);
    expect(a.older).toHaveLength(1);
    expect(a.totalCents).toBe(260_000 + 250_000);
    expect(a.estimated).toBe(1);
    expect(a.recent[0]?.daysSinceFunded).toBe(13);
    expect(a.older[0]?.daysSinceFunded).toBeGreaterThan(AWAITING_WINDOW_DAYS);
  });

  it("is empty, and honest about unpriced ones, with no history", () => {
    expect(awaitingCommission([], TODAY, NO_AVERAGE)).toMatchObject({ totalCents: 0, unknown: 0 });
    const a = awaitingCommission([adv({ fundedOn: "2026-10-10" })], TODAY, NO_AVERAGE);
    expect(a.totalCents).toBe(0);
    expect(a.unknown).toBe(1);
  });
});

describe("what is on its way: deals close to funding", () => {
  const deal = (over: Partial<DealRow> = {}): DealRow => ({
    id: `d${(n += 1)}`,
    businessName: `Deal ${n}`,
    stage: "offers_in",
    estApprovalCents: null,
    ...over,
  });
  const offer = (clientId: string, over: Partial<OfferRow> = {}): OfferRow => ({
    id: `o${(n += 1)}`,
    clientId,
    funderName: "Alpha Capital",
    amountCents: 4_000_000,
    factorRate: 1.3,
    positionNo: 1,
    status: "open",
    receivedOn: TODAY,
    ...over,
  });
  const ctx: CommissionContext = {
    average: { points: 5, n: 4 },
    funderPoints: new Map([["pearl funding", 8]]),
  };

  it("prices a deal by its best offer, using the funder's own points when it has them", () => {
    const d = deal();
    const p = pipelineDeals(
      [d],
      [
        offer(d.id, { amountCents: 6_000_000 }), // 5% of 60k = 3,000
        offer(d.id, { amountCents: 4_000_000, funderName: "Pearl Funding" }), // 8% of 40k = 3,200: best
      ],
      ctx,
    );
    expect(p.deals[0]).toMatchObject({
      amountFrom: "offer",
      amountCents: 4_000_000,
      funderName: "Pearl Funding",
      expected: { cents: 320_000, basis: "funder" },
    });
    expect(p.totalCents).toBe(320_000);
  });

  it("falls back to the approval estimate × his average points, and says it is an estimate", () => {
    const d = deal({ stage: "contract_out", estApprovalCents: 4_800_000 });
    const p = pipelineDeals([d], [], ctx);
    expect(p.deals[0]).toMatchObject({
      amountFrom: "estimate",
      amountCents: 4_800_000,
      expected: { cents: 240_000, basis: "estimate" },
    });
  });

  it("ignores declined and expired offers, and deals outside the three stages", () => {
    const d = deal({ estApprovalCents: 1_000_000 });
    const p = pipelineDeals(
      [d, deal({ stage: "submitted", estApprovalCents: 9_000_000 }), deal({ stage: "funded" })],
      [offer(d.id, { status: "declined", amountCents: 9_900_000 })],
      ctx,
    );
    expect(p.deals).toHaveLength(1);
    expect(p.deals[0]?.amountFrom).toBe("estimate");
  });

  it("does not guess when there is neither an offer nor an estimate, or no history", () => {
    const bare = deal();
    const p = pipelineDeals([bare, deal({ estApprovalCents: 2_000_000 })], [], NO_AVERAGE);
    expect(p.deals.every((x) => x.expected === null)).toBe(true);
    expect(p.totalCents).toBe(0);
    expect(p.unknown).toBe(2);
    expect(p.deals.find((x) => x.deal.id === bare.id)?.amountCents).toBeNull();
  });
});

describe("what is on its way: renewals still to come", () => {
  const ctx: CommissionContext = { average: { points: 5, n: 4 } };
  // $50,000 at 1.32, $550 a business day: 50% on the 60th business day after funding
  it("renews each active advance at the same terms the day it crosses 50%", () => {
    const rows = [
      adv({ fundedOn: "2026-01-05", commissionCents: 250_000 }), // crossed 2026-03-30
      adv({ fundedOn: "2026-09-01" }), // 60 business days on: 2026-11-24 — within 90 days, estimated
      adv({ fundedOn: "2026-10-22", paymentCents: 25_000 }), // 132 business days to 50%: spring 2027, later
      adv({ fundedOn: "2026-10-01", status: "paid_off" }), // not active: not a renewal to come
    ];
    const f = renewalForecast(rows, TODAY, ctx);
    expect(f.rows).toHaveLength(3);
    expect(f.rows[0]).toMatchObject({ horizon: "now", renewalOn: TODAY });
    expect(f.rows[1]).toMatchObject({ horizon: "90", renewalOn: "2026-11-24" });
    expect(f.rows[2]?.horizon).toBe("later");
    expect(f.byHorizon.now).toEqual({ count: 1, cents: 250_000 });
    expect(f.byHorizon["90"]).toEqual({ count: 1, cents: 250_000 });
    expect(f.totalCents).toBe(750_000);
  });

  it("honours a funder's own renewal line and an explicit minimum", () => {
    const a = adv({ fundedOn: "2026-09-01", funderName: "Pearl Funding", commissionCents: 1 });
    const own = renewalForecast([a], TODAY, ctx, new Map([["pearl funding", 70]]));
    const plain = renewalForecast([a], TODAY, ctx);
    expect((own.rows[0]?.renewalOn ?? "") > (plain.rows[0]?.renewalOn ?? "~")).toBe(true);
    const forced = renewalForecast([a], TODAY, ctx, new Map([["pearl funding", 70]]), 50);
    expect(forced.rows[0]?.renewalOn).toBe(plain.rows[0]?.renewalOn);
  });

  it("is empty when nothing is active", () => {
    expect(renewalForecast([], TODAY, ctx)).toMatchObject({ rows: [], totalCents: 0, unknown: 0 });
  });
});
