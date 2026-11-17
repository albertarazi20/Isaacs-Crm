import { describe, expect, it } from "vitest";
import { buildToday } from "@/lib/data/views";
import type { ClientCard } from "@/lib/data/types";

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
