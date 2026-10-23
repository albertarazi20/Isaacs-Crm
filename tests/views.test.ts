import { describe, expect, it } from "vitest";
import { buildRenewals, buildToday, cardFundingTerms, groupLongGame } from "@/lib/data/views";
import type { ClientCard } from "@/lib/data/types";
import { addDays, addMonths } from "@/lib/mca/dates";

const TODAY = "2026-10-23";

function card(over: Partial<ClientCard> & { business_name: string }): ClientCard {
  return {
    id: over.business_name,
    dba: "",
    contact_name: "",
    phone: "",
    email: "",
    industry: "",
    state: "",
    source: "",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "interested",
    stage_changed_at: "2026-10-01T00:00:00Z",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-10-01T00:00:00Z",
    next_due_on: TODAY,
    next_due_kind: "follow_up",
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

// $50k at 1.32 = $66k back at $550 per business day => 50% on 2026-03-30 when funded 2026-01-05.
const funded = (name: string, fundedOn: string, extra: Partial<ClientCard> = {}) =>
  card({
    business_name: name,
    stage: "funded",
    funding_id: name,
    funded_on: fundedOn,
    funding_amount_cents: 5_000_000,
    factor_rate: 1.32,
    funding_payment_cents: 55_000,
    funding_frequency: "daily",
    funding_status: "active",
    next_due_on: addDays(TODAY, 30),
    ...extra,
  });

describe("today view", () => {
  const cards = [
    card({ business_name: "Late Old", next_due_on: "2026-10-10" }),
    card({ business_name: "Late New", next_due_on: "2026-10-21" }),
    card({ business_name: "Today Prospect", next_due_on: TODAY, stage: "name_in" }),
    card({ business_name: "Today Closing", next_due_on: TODAY, stage: "contract_out" }),
    card({
      business_name: "Today Renewal",
      next_due_on: TODAY,
      next_due_kind: "renewal",
      stage: "funded",
    }),
    card({
      business_name: "Call 3pm",
      next_due_on: TODAY,
      next_due_kind: "scheduled_call",
      scheduled_call_at: "2026-10-23T19:00:00Z",
    }),
    card({
      business_name: "Call 10am",
      next_due_on: TODAY,
      next_due_kind: "scheduled_call",
      scheduled_call_at: "2026-10-23T14:00:00Z",
    }),
    card({ business_name: "Tomorrow", next_due_on: "2026-10-24" }),
    card({ business_name: "Day 7", next_due_on: "2026-10-30" }),
    card({ business_name: "Day 8", next_due_on: "2026-10-31" }),
  ];
  const view = buildToday(cards, TODAY);

  it("puts the oldest overdue first", () => {
    expect(view.overdue.map((c) => c.business_name)).toEqual(["Late Old", "Late New"]);
  });
  it("lists booked calls separately, earliest first", () => {
    expect(view.scheduled.map((c) => c.business_name)).toEqual(["Call 10am", "Call 3pm"]);
  });
  it("ranks today's work: renewals, then deals near funding, then prospects", () => {
    expect(view.dueToday.map((c) => c.business_name)).toEqual([
      "Today Renewal",
      "Today Closing",
      "Today Prospect",
    ]);
  });
  it("shows the next 7 days and not day 8", () => {
    expect(view.upcoming.map((c) => c.business_name)).toEqual(["Tomorrow", "Day 7"]);
  });
  it("counts calls booked today in 'due today'", () => {
    expect(view.kpis).toMatchObject({ overdue: 2, dueToday: 5, next7: 2 });
  });
  it("ignores clients with no timer rather than crashing", () => {
    expect(
      buildToday([card({ business_name: "X", next_due_on: null, next_due_kind: null })], TODAY).kpis
        .overdue,
    ).toBe(0);
  });
});

describe("funded book", () => {
  it("counts active advances, outstanding balance and renewal-ready clients", () => {
    const v = buildToday(
      [
        funded("Half Paid", "2026-01-05"), // exactly 50% on 2026-03-30; long past by TODAY
        funded("Brand New", TODAY),
        funded("Defaulted", "2026-01-05", { funding_status: "defaulted" }),
      ],
      TODAY,
    );
    expect(v.kpis.fundedActive).toBe(2);
    expect(v.kpis.renewalReady).toBe(1);
    expect(v.kpis.outstandingCents).toBe(6_600_000 /* Brand New, nothing paid */);
  });
  it("returns null terms when a number is missing instead of guessing", () => {
    expect(cardFundingTerms(card({ business_name: "None" }))).toBeNull();
    expect(cardFundingTerms(funded("Ok", "2026-01-05"))).toMatchObject({
      amountCents: 5_000_000,
      paymentCents: 55_000,
    });
  });
});

describe("renewals", () => {
  const cards = [
    funded("A 100%", "2026-01-05"),
    funded("B 50%", "2026-05-18"), // 2026-05-18 + 12 weeks = 2026-08-10; by Oct 23 well over, use a custom mid case below
    funded("C fresh", TODAY),
    card({ business_name: "Done", stage: "paid_in_full", next_due_on: "2026-11-01" }),
    card({ business_name: "Done Soon", stage: "paid_in_full", next_due_on: "2026-10-25" }),
  ];
  it("lists advances at or above the threshold, most paid down first", () => {
    const r = buildRenewals(cards, TODAY, 50);
    expect(r.ready.map((x) => x.card.business_name)).toEqual(["A 100%", "B 50%"]);
    expect(r.ready[0]?.pct).toBe(100);
  });
  it("a higher threshold narrows the list", () => {
    expect(buildRenewals(cards, TODAY, 100).ready.map((x) => x.card.business_name)).toEqual([
      "A 100%",
    ]);
  });
  it("always lists paid-in-full clients, soonest follow-up first", () => {
    expect(buildRenewals(cards, TODAY, 50).paidOff.map((c) => c.business_name)).toEqual([
      "Done Soon",
      "Done",
    ]);
  });
});

describe("long game", () => {
  it("groups clients parked beyond a year by the month they return", () => {
    const g = groupLongGame(
      [
        card({ business_name: "In 11 mo", next_due_on: addMonths(TODAY, 11) }),
        card({ business_name: "In 13 mo", next_due_on: "2027-11-30" }),
        card({ business_name: "In 13 mo b", next_due_on: "2027-11-02" }),
        card({ business_name: "In 3 yrs", next_due_on: "2029-10-23" }),
      ],
      TODAY,
    );
    expect(g.map((x) => x.key)).toEqual(["2027-11", "2029-10"]);
    expect(g[0]?.label).toBe("Nov 2027");
    expect(g[0]?.cards.map((c) => c.business_name)).toEqual(["In 13 mo b", "In 13 mo"]);
  });
});
