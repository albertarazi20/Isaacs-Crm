import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLE,
  fromSource,
  funderSlice,
  groupFactors,
  industrySlice,
  lossGap,
  lostDeals,
  meanFactor,
  observations,
  positionOrder,
  positionSlice,
  type PriceObservation,
} from "@/lib/earnings/pricebook";
import type { AdvanceRow, CompetingOfferRow, OfferRow } from "@/lib/earnings/types";

let merchantSeq = 0;
/** Every observation is a different merchant unless a test says otherwise. */
const obs = (over: Partial<PriceObservation> = {}): PriceObservation => ({
  source: "funded",
  clientId: `m${(merchantSeq += 1)}`,
  factor: 1.3,
  positionNo: 1,
  industry: "Restaurant",
  funder: "Alpha",
  amountCents: 5_000_000,
  ...over,
});

describe("averages", () => {
  it("averages factor rates without float drift", () => {
    expect(meanFactor([1.1, 1.2, 1.3])).toBe(1.2);
    expect(meanFactor([1.35, 1.35, 1.36])).toBe(1.353);
    expect(meanFactor([])).toBeNull();
  });

  it("shows no average — only the count and range — below three prices", () => {
    const g = groupFactors([obs({ factor: 1.3 }), obs({ factor: 1.4 })], industrySlice);
    expect(MIN_SAMPLE).toBe(3);
    expect(g).toEqual([
      {
        key: "restaurant",
        label: "Restaurant",
        n: 2,
        merchants: 2,
        average: null,
        low: 1.3,
        high: 1.4,
      },
    ]);
    const three = groupFactors(
      [obs({ factor: 1.3 }), obs({ factor: 1.4 }), obs({ factor: 1.5 })],
      industrySlice,
    );
    expect(three[0]).toMatchObject({ n: 3, average: 1.4 });
  });

  it("groups industries and funders ignoring case, spacing and blanks", () => {
    const g = groupFactors(
      [
        obs({ industry: "Auto repair" }),
        obs({ industry: " auto  REPAIR " }),
        obs({ industry: "" }),
        obs({ industry: "   " }),
      ],
      industrySlice,
    );
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ label: "Auto repair", n: 2 });
    const f = groupFactors(
      [obs({ funder: "Pearl" }), obs({ funder: "pearl " }), obs({ funder: "" })],
      funderSlice,
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.n).toBe(2);
  });

  it("groups by position, 4th and beyond together, unknown positions left out", () => {
    const g = positionOrder(
      groupFactors(
        [
          obs({ positionNo: 1 }),
          obs({ positionNo: 3 }),
          obs({ positionNo: 4 }),
          obs({ positionNo: 7 }),
          obs({ positionNo: null }),
        ],
        positionSlice,
      ),
    );
    expect(g.map((x) => [x.label, x.n])).toEqual([
      ["1st", 1],
      ["3rd", 1],
      ["4th+", 2],
    ]);
  });

  it("filters by where the price came from", () => {
    const all = [
      obs({ source: "funded" }),
      obs({ source: "offer" }),
      obs({ source: "competitor" }),
    ];
    expect(fromSource(all, new Set(["offer"]))).toHaveLength(1);
    expect(fromSource(all, new Set())).toHaveLength(0);
    expect(fromSource(all, new Set(["funded", "offer", "competitor"]))).toHaveLength(3);
  });
});

const advance = (over: Partial<AdvanceRow> = {}): AdvanceRow => ({
  id: "f",
  clientId: "c",
  businessName: "M",
  industry: "Retail",
  stage: "funded",
  contactStatus: "ok",
  fundedOn: "2026-01-05",
  funderName: "Alpha",
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
});
const offer = (
  clientId: string,
  factor: number,
  over: Partial<OfferRow> = {},
): OfferRow & { industry: string } => ({
  id: `o${factor}`,
  clientId,
  funderName: "Pearl",
  amountCents: 4_000_000,
  factorRate: factor,
  positionNo: 2,
  status: "open",
  receivedOn: "2026-10-01",
  industry: "Retail",
  ...over,
});
const competing = (
  clientId: string,
  factor: number | null,
  over: Partial<CompetingOfferRow> = {},
): CompetingOfferRow => ({
  id: `x${clientId}${factor}`,
  clientId,
  businessName: `Biz ${clientId}`,
  industry: "Retail",
  funderName: "Rival",
  amountCents: 5_000_000,
  factorRate: factor,
  positionNo: 1,
  won: true,
  ...over,
});

describe("review-3A A-6: one deal is one price, and a sample is merchants", () => {
  it("an offer he took and then funded is counted once, as the advance", () => {
    const o = observations({
      advances: [advance({ clientId: "e", amountCents: 4_000_000, factorRate: 1.35 })],
      offers: [
        offer("e", 1.35, { amountCents: 4_000_000, status: "accepted" }),
        offer("e", 1.38, { amountCents: 4_000_000, funderName: "Other" }),
      ],
      competing: [],
    });
    expect(o.map((x) => [x.source, x.factor])).toEqual([
      ["funded", 1.35],
      ["offer", 1.38],
    ]);
  });

  it("three prices from ONE merchant show no average", () => {
    const g = groupFactors(
      [1.3, 1.35, 1.4].map((factor) => obs({ factor, clientId: "same" })),
      industrySlice,
    );
    expect(g[0]).toMatchObject({ n: 3, merchants: 1, average: null });
  });

  it("three merchants are enough, even when one of them has two prices", () => {
    const g = groupFactors(
      [
        obs({ factor: 1.3, clientId: "a" }),
        obs({ factor: 1.4, clientId: "a" }),
        obs({ factor: 1.3, clientId: "b" }),
        obs({ factor: 1.5, clientId: "c" }),
      ],
      industrySlice,
    );
    expect(g[0]).toMatchObject({ n: 4, merchants: 3, average: 1.375 });
  });
});

describe("the observations behind the price book", () => {
  it("pools his funded advances, his funders' offers and competing offers, tagged by source", () => {
    const o = observations({
      advances: [advance()],
      offers: [offer("c1", 1.3)],
      competing: [competing("c2", 1.4), competing("c3", null)],
    });
    expect(o.map((x) => x.source)).toEqual(["funded", "offer", "competitor"]);
    expect(o[1]).toMatchObject({ factor: 1.3, positionNo: 2, funder: "Pearl" });
  });

  it("is empty with no data, and works without any offers (Funders not installed)", () => {
    expect(observations({ advances: [], offers: [], competing: [] })).toEqual([]);
    expect(observations({ advances: [advance()], offers: [], competing: [] })).toHaveLength(1);
  });
});

describe("deals he lost: how far off was his price?", () => {
  it("compares the winner with his own best (lowest) offer on each deal", () => {
    const deals = lostDeals(
      [
        competing("a", 1.42),
        competing("a", 1.5),
        competing("b", 1.3),
        competing("c", 1.4, { won: false }),
      ],
      [offer("a", 1.38), offer("a", 1.45), offer("b", 1.36)],
    );
    expect(deals.map((d) => [d.clientId, d.competitorFactor, d.ourBestFactor])).toEqual([
      ["a", 1.42, 1.38],
      ["b", 1.3, 1.36],
    ]);
  });

  it("signs the gap: positive when the winner was dearer than his best offer, negative when cheaper", () => {
    const g = lossGap(
      lostDeals(
        [competing("a", 1.42), competing("b", 1.3), competing("c", 1.35), competing("d", 1.4)],
        [offer("a", 1.38), offer("b", 1.36), offer("c", 1.35)],
      ),
    );
    expect(g.compared).toBe(3);
    expect(g.withoutOurOffer).toBe(1);
    expect(g.deals.map((d) => d.gap)).toEqual([0.04, -0.06, 0, null]);
    expect(g.cheaper).toBe(1);
    expect(g.pricier).toBe(1);
    expect(g.same).toBe(1);
    expect(g.averageGap).toBe(-0.007);
  });

  it("draws no conclusion from fewer than three comparisons", () => {
    const g = lossGap(
      lostDeals([competing("a", 1.42), competing("b", 1.3)], [offer("a", 1.38), offer("b", 1.36)]),
    );
    expect(g.compared).toBe(2);
    expect(g.averageGap).toBeNull();
  });

  it("is empty with no lost deals", () => {
    expect(lossGap([])).toMatchObject({ deals: [], compared: 0, averageGap: null });
    expect(lostDeals([], [])).toEqual([]);
  });
});
