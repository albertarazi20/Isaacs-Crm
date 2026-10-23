import { describe, expect, it } from "vitest";
import type { ClientCard } from "@/lib/data/types";
import type { CommissionContext } from "@/lib/earnings/commission";
import { advanceProgress, renewalThreshold } from "@/lib/earnings/progress";
import { buildRadar, contactOf, HOT_DAYS } from "@/lib/earnings/radar";
import type { AdvanceRow } from "@/lib/earnings/types";

const TODAY = "2026-10-23";
const TZ = "America/New_York";
const CTX: CommissionContext = { average: { points: 5, n: 4 } };

let n = 0;
function card(over: Partial<ClientCard> = {}): ClientCard {
  n += 1;
  return {
    id: `c${n}`,
    business_name: `Merchant ${n}`,
    dba: "",
    contact_name: "Owner",
    phone: "3055550100",
    email: "",
    industry: "Retail",
    state: "FL",
    source: "",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "funded",
    stage_changed_at: "2026-09-01T12:00:00Z",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-01-01T00:00:00Z",
    next_due_on: null,
    next_due_kind: null,
    last_call_at: null,
    last_touch_at: null,
    last_call_note: null,
    wanted_amount_cents: null,
    wanted_terms: null,
    est_approval_cents: null,
    est_approval_note: null,
    position_count: 0,
    position_balance_cents: 0,
    stips_required: 0,
    stips_received: 0,
    funding_id: null,
    funded_on: null,
    funding_amount_cents: null,
    factor_rate: null,
    funding_payback_cents: null,
    funding_payment_cents: null,
    funding_frequency: null,
    paid_back_override_cents: null,
    funding_status: null,
    defaulted_on: null,
    last_payment_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    ...over,
  };
}

function adv(c: ClientCard, over: Partial<AdvanceRow> = {}): AdvanceRow {
  n += 1;
  return {
    id: `f${n}`,
    clientId: c.id,
    businessName: c.business_name,
    industry: c.industry,
    stage: c.stage,
    contactStatus: c.contact_status,
    fundedOn: "2026-01-05", // $50,000 × 1.32 at $550 a business day: 50% on 2026-03-30, paid off 2026-06-22
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

const radar = (
  cards: ClientCard[],
  advances: AdvanceRow[],
  extra: Partial<Parameters<typeof buildRadar>[0]> = {},
) =>
  buildRadar({
    cards,
    advances,
    today: TODAY,
    timezone: TZ,
    minPct: null,
    thresholds: new Map(),
    commission: CTX,
    ...extra,
  });

describe("progress against a renewal line", () => {
  it("is judged on cents, so 49.96% is not 50%", () => {
    const c = card();
    // 120 remittances of $550 = $66,000. One remittance short of 60 is 49.17%.
    const a = adv(c, { fundedOn: "2026-01-05" });
    expect(advanceProgress(a, 50, "2026-03-27").eligible).toBe(false);
    const hit = advanceProgress(a, 50, "2026-03-30");
    expect(hit.eligible).toBe(true);
    expect(hit.crossesOn).toBe("2026-03-30");
    const later = advanceProgress(a, 50, TODAY);
    expect(later.crossesOn).toBe("2026-03-30");
    expect(later.paidInFull).toBe(true);
    expect(later.payoffOn).toBe("2026-06-22");
  });

  it("a collected figure he typed can put a merchant ahead of the schedule — never 'eligible in the future'", () => {
    const c = card();
    const a = adv(c, { fundedOn: "2026-10-01", paidBackOverrideCents: 4_000_000 });
    const p = advanceProgress(a, 50, TODAY);
    expect(p.eligible).toBe(true);
    expect(p.crossesOn).toBe(TODAY);
  });

  it("uses an explicit minimum, else the funder's, else 50", () => {
    const a = { funderName: "Pearl Funding" };
    const funders = new Map([["pearl funding", 65]]);
    expect(renewalThreshold(a, funders, 80)).toBe(80);
    expect(renewalThreshold(a, funders, null)).toBe(65);
    expect(renewalThreshold({ funderName: "Other" }, funders, null)).toBe(50);
  });
});

describe("contact", () => {
  it("turns the last touch into a calendar day in his time zone", () => {
    // 01:30 UTC on Oct 22 is still the evening of Oct 21 in New York
    const c = contactOf({ last_touch_at: "2026-10-22T01:30:00Z" }, TODAY, TZ);
    expect(c).toEqual({ lastContactOn: "2026-10-21", daysSinceContact: 2 });
    expect(contactOf({ last_touch_at: null }, TODAY, TZ)).toEqual({
      lastContactOn: null,
      daysSinceContact: null,
    });
  });
});

describe("renewal radar", () => {
  it("lists active advances at the line, hottest first: eligible days × expected commission", () => {
    const old = card({ business_name: "Old and small" });
    const fresh = card({ business_name: "Fresh and big" });
    const mid = card({ business_name: "Middle" });
    const notYet = card({ business_name: "Not yet" });
    const r = radar(
      [fresh, old, notYet, mid],
      [
        adv(old, { fundedOn: "2026-01-05", commissionCents: 100_000 }), // eligible 207 days × $1,000
        adv(fresh, { fundedOn: "2026-08-03", commissionCents: 900_000 }), // crosses 50% in late October
        adv(mid, { fundedOn: "2026-04-01", commissionCents: 200_000 }),
        adv(notYet, { fundedOn: "2026-10-20" }),
      ],
    );
    expect(r.ready.map((x) => x.card.business_name)).toEqual(
      [...r.ready].sort((a, b) => b.score - a.score).map((x) => x.card.business_name),
    );
    expect(r.ready.find((x) => x.card.business_name === "Old and small")?.eligibleDays).toBe(207);
    expect(r.ready.some((x) => x.card.business_name === "Not yet")).toBe(false);
    // score really is days × commission
    const m = r.ready.find((x) => x.card.business_name === "Middle");
    expect(m?.score).toBe((m?.eligibleDays ?? 0) * 200_000);
  });

  it("orders the day-zero ties by commission, and unpriced advances last", () => {
    const a = card({ business_name: "A" });
    const b = card({ business_name: "B" });
    const c = card({ business_name: "C" });
    const r = radar(
      [a, b, c],
      [
        adv(a, {
          paidBackOverrideCents: 4_000_000,
          fundedOn: "2026-10-01",
          commissionCents: 100_000,
        }),
        adv(b, {
          paidBackOverrideCents: 4_000_000,
          fundedOn: "2026-10-01",
          commissionCents: 300_000,
        }),
        adv(c, { paidBackOverrideCents: 4_000_000, fundedOn: "2026-10-01" }),
      ],
      { commission: { average: null } },
    );
    expect(r.ready.map((x) => x.card.business_name)).toEqual(["B", "A", "C"]);
    expect(r.ready.map((x) => x.score)).toEqual([0, 0, 0]);
    expect(r.totals.expectedUnknown).toBe(1);
    expect(r.totals.expectedCents).toBe(400_000);
  });

  it("flags a merchant nobody has contacted since the day they became eligible", () => {
    const never = card({ business_name: "Never" });
    const before = card({ business_name: "Before", last_touch_at: "2026-03-01T15:00:00Z" });
    const after = card({ business_name: "After", last_touch_at: "2026-10-20T15:00:00Z" });
    const same = card({ business_name: "SameDay", last_touch_at: "2026-03-30T15:00:00Z" });
    const r = radar(
      [never, before, after, same],
      [never, before, after, same].map((c) => adv(c, { commissionCents: 100_000 })),
    );
    const by = (name: string) => r.ready.find((x) => x.card.business_name === name);
    expect(by("Never")).toMatchObject({ notContactedSinceEligible: true, lastContactOn: null });
    expect(by("Before")?.notContactedSinceEligible).toBe(true);
    expect(by("After")?.notContactedSinceEligible).toBe(false);
    expect(by("After")?.daysSinceContact).toBe(3);
    expect(by("SameDay")?.notContactedSinceEligible).toBe(false);
    expect(r.totals.neverContacted).toBe(2);
  });

  it("uses ?min= for everyone, and a funder's own line when there is no ?min=", () => {
    const c = card();
    const a = adv(c, { fundedOn: "2026-07-01", funderName: "Pearl Funding" });
    // 2026-07-01 + 23 weeks of business days: well past 50, short of 90
    const p = advanceProgress(a, 50, TODAY).pct;
    expect(p).toBeGreaterThan(50);
    expect(p).toBeLessThan(90);
    expect(radar([c], [a], { minPct: 50 }).ready).toHaveLength(1);
    expect(radar([c], [a], { minPct: 90 }).ready).toHaveLength(0);
    const strict = new Map([["pearl funding", 95]]);
    expect(radar([c], [a], { thresholds: strict }).ready).toHaveLength(0);
    expect(radar([c], [a], { thresholds: strict, minPct: 50 }).ready).toHaveLength(1);
  });

  it("lists paid-in-full merchants with days since paid off — hot inside 30 days — newest first", () => {
    const hot = card({
      business_name: "Hot",
      stage: "paid_in_full",
      stage_changed_at: "2026-10-10T16:00:00Z",
    });
    const edge = card({
      business_name: "Edge",
      stage: "paid_in_full",
      stage_changed_at: "2026-09-23T16:00:00Z",
    });
    const cold = card({
      business_name: "Cold",
      stage: "paid_in_full",
      stage_changed_at: "2026-06-01T16:00:00Z",
      contact_status: "dnc",
    });
    const r = radar(
      [cold, edge, hot],
      [
        adv(hot, { status: "paid_off", commissionCents: 250_000 }),
        adv(edge, { status: "paid_off" }),
        adv(cold, { status: "paid_off" }),
      ],
    );
    expect(r.paidInFull.map((p) => p.card.business_name)).toEqual(["Hot", "Edge", "Cold"]);
    expect(r.paidInFull.map((p) => p.daysSincePaidOff)).toEqual([13, 30, 144]);
    expect(r.paidInFull.map((p) => p.hot)).toEqual([true, true, false]);
    expect(HOT_DAYS).toBe(30);
    expect(r.paidInFull[0]?.expected).toEqual({ cents: 250_000, basis: "entered" });
    // a do-not-contact merchant is still listed — the buttons are what's disabled
    expect(r.paidInFull[2]?.card.contact_status).toBe("dnc");
  });

  it("is empty with no data", () => {
    const r = radar([], []);
    expect(r).toMatchObject({ ready: [], paidInFull: [], pastPayoff: [] });
    expect(r.totals).toEqual({
      outstandingCents: 0,
      expectedCents: 0,
      expectedUnknown: 0,
      neverContacted: 0,
    });
  });
});

describe("advances past their estimated payoff", () => {
  it("finds active advances whose last remittance is behind us, by schedule and by a collected figure", () => {
    const bySchedule = card({ business_name: "Schedule" });
    const byFigure = card({ business_name: "Figure" });
    const notYet = card({ business_name: "NotYet" });
    const r = radar(
      [bySchedule, byFigure, notYet],
      [
        adv(bySchedule), // paid off 2026-06-22
        adv(byFigure, { fundedOn: "2026-10-01", paidBackOverrideCents: 6_600_000 }),
        adv(notYet, { fundedOn: "2026-09-01" }),
      ],
    );
    expect(r.pastPayoff.map((p) => p.card.business_name)).toEqual(["Schedule", "Figure"]);
    expect(r.pastPayoff[0]).toMatchObject({ payoffOn: "2026-06-22", daysPast: 123 });
    expect(r.pastPayoff[1]).toMatchObject({ payoffOn: null, daysPast: null });
  });

  it("is today's payoff, not tomorrow's", () => {
    const c = card();
    const a = adv(c);
    const p = advanceProgress(a, 100, "2026-06-22");
    expect(p.paidInFull).toBe(true);
    expect(advanceProgress(a, 100, "2026-06-19").paidInFull).toBe(false); // the Friday before: 119 of 120
  });

  it("leaves out merchants already moved, in default, or on another stage, and advances that are not active", () => {
    const paid = card({ stage: "paid_in_full" });
    const def = card({ stage: "default_workable" });
    const done = card({ stage: "funded" });
    const soon = card({ stage: "paying_off_soon" });
    const r = radar(
      [paid, def, done, soon],
      [
        adv(paid, { status: "active" }),
        adv(def, { status: "defaulted" }),
        adv(done, { status: "paid_off" }),
        adv(soon),
      ],
    );
    expect(r.pastPayoff.map((p) => p.card.id)).toEqual([soon.id]);
  });
});
