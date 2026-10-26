import { describe, expect, it } from "vitest";
import {
  activityBody,
  askForm,
  centsToInput,
  clientFieldsPayload,
  clientForm,
  commissionPoints,
  countByFilter,
  dateInTz,
  dueTone,
  filterActivities,
  formatFactor,
  fundingForm,
  fundingPayload,
  fundingSnapshot,
  fundingTerms,
  lastCallSummary,
  lastTouchOf,
  nextPositionNo,
  offerForm,
  offerInsight,
  offerPayload,
  ordinal,
  positionError,
  positionForm,
  positionPaidDownPct,
  positionPayload,
  positionRollup,
  remittanceLabel,
  rollupOf,
  setStipReceived,
  splitStips,
  type TimelineFilter,
} from "@/components/client/logic";
import type {
  ActivityRow,
  ClientCard,
  FundingRow,
  OfferRow,
  PositionRow,
  StipRow,
} from "@/lib/data/types";
import { paidToDateCents, paydownPct, renewalDate } from "@/lib/mca/funding";
import { formatMoney, parseMoney } from "@/lib/money";

const TODAY = "2026-10-23";

const kinds: ActivityRow["kind"][] = [
  "note",
  "call",
  "text",
  "email",
  "stage_change",
  "timer",
  "funding",
  "system",
  "note",
];
const rows = kinds.map((kind, i) => ({ kind, id: String(i) }));

describe("timeline filters", () => {
  it("All keeps every row, in order", () => {
    expect(filterActivities(rows, "all").map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
  it("Notes is only notes", () => {
    expect(filterActivities(rows, "notes").map((r) => r.id)).toEqual(["0", "8"]);
  });
  it("Calls & texts includes emails — they are contact too", () => {
    expect(filterActivities(rows, "contact").map((r) => r.kind)).toEqual(["call", "text", "email"]);
  });
  it("Stage changes is only stage moves", () => {
    expect(filterActivities(rows, "stage").map((r) => r.kind)).toEqual(["stage_change"]);
  });
  it("counts match what each filter shows", () => {
    const counts = countByFilter(rows);
    for (const f of ["all", "notes", "contact", "stage"] as TimelineFilter[]) {
      expect(counts[f]).toBe(filterActivities(rows, f).length);
    }
  });
});

describe("activity bodies", () => {
  it("turns stip keys into the checklist's words", () => {
    expect(activityBody({ kind: "system", body: "Received: bank_statement Jul 2026" })).toBe(
      "Received: Jul 2026 statement",
    );
    expect(activityBody({ kind: "system", body: "Marked missing: voided_check" })).toBe(
      "Marked missing: Voided check",
    );
  });
  it("leaves other system and note text alone", () => {
    expect(activityBody({ kind: "system", body: "Added" })).toBe("Added");
    expect(activityBody({ kind: "note", body: "Received: bank_statement Jul 2026" })).toBe(
      "Received: bank_statement Jul 2026",
    );
  });
  it("writes the funding line with commas and the word factor", () => {
    expect(activityBody({ kind: "funding", body: "Funded $50000 at 1.310" })).toBe(
      "Funded $50,000 at 1.31 factor",
    );
    expect(activityBody({ kind: "funding", body: "something else" })).toBe("something else");
  });
  it("writes timer dates the way the page does", () => {
    expect(activityBody({ kind: "timer", body: "Follow up set for 2027-01-23" }, TODAY)).toBe(
      "Follow up set for Jan 23, 2027",
    );
    expect(activityBody({ kind: "timer", body: "Follow up set for 2026-11-02 — ask" }, TODAY)).toBe(
      "Follow up set for Nov 2 — ask",
    );
    expect(activityBody({ kind: "timer", body: "Follow up set for 2026-13-45" }, TODAY)).toBe(
      "Follow up set for 2026-13-45",
    );
  });
});

describe("last call and last follow-up", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("says so plainly when there was never a call", () => {
    expect(lastCallSummary({ last_call_at: null, last_call_note: null }, now)).toEqual({
      never: true,
    });
  });
  it("gives how long ago and the note", () => {
    const s = lastCallSummary(
      { last_call_at: "2026-10-20T12:00:00Z", last_call_note: "  Wants 60k  " },
      now,
    );
    expect(s).toMatchObject({ never: false, ago: "3 days ago", note: "Wants 60k" });
  });
  it("finds the newest touch whatever the order", () => {
    const touch = lastTouchOf([
      { kind: "note", occurred_at: "2026-10-23T10:00:00Z" },
      { kind: "text", occurred_at: "2026-10-21T10:00:00Z" },
      { kind: "call", occurred_at: "2026-10-19T10:00:00Z" },
      { kind: "email", occurred_at: "2026-10-22T10:00:00Z" },
    ]);
    expect(touch).toEqual({ kind: "email", atIso: "2026-10-22T10:00:00Z" });
    expect(lastTouchOf([{ kind: "note", occurred_at: "2026-10-23T10:00:00Z" }])).toBeNull();
  });
});

describe("dates", () => {
  it("finds the calendar day in Isaac's timezone, not UTC", () => {
    expect(dateInTz("2026-10-24T02:30:00Z", "America/New_York")).toBe("2026-10-23");
    expect(dateInTz("2026-10-24T02:30:00Z", "UTC")).toBe("2026-10-24");
  });
  it("marks overdue, today and later", () => {
    expect(dueTone("2026-10-22", TODAY)).toBe("overdue");
    expect(dueTone(TODAY, TODAY)).toBe("today");
    expect(dueTone("2026-10-24", TODAY)).toBe("later");
  });
});

describe("money in form fields", () => {
  it("prints whole dollars plainly and cents with two digits", () => {
    expect(centsToInput(5_000_000)).toBe("50000");
    expect(centsToInput(5_012_345)).toBe("50123.45");
    expect(centsToInput(5_000_005)).toBe("50000.05");
    expect(centsToInput(0)).toBe("0");
    expect(centsToInput(null)).toBe("");
    expect(centsToInput(undefined)).toBe("");
  });
  it("round-trips through parseMoney", () => {
    for (const cents of [
      0, 1, 99, 100, 101, 12_345, 5_000_000, 5_012_345, 123_456_789, 999_999_901,
    ]) {
      expect(parseMoney(centsToInput(cents))).toBe(cents);
    }
  });
  it("formats factor rates with two decimals unless a third is real", () => {
    expect(formatFactor(1.31)).toBe("1.31");
    expect(formatFactor(1.315)).toBe("1.315");
    expect(formatFactor(1.4)).toBe("1.40");
    expect(formatFactor(null)).toBe("—");
  });
  it("labels remittances with their cadence", () => {
    expect(remittanceLabel(55_000, "daily", formatMoney)).toBe("$550/day");
    expect(remittanceLabel(300_000, "weekly", formatMoney)).toBe("$3,000/week");
    expect(remittanceLabel(300_000, "biweekly", formatMoney)).toBe("$3,000 every 2 weeks");
    expect(remittanceLabel(300_000, "monthly", formatMoney)).toBe("$3,000/month");
    expect(remittanceLabel(55_000, null, formatMoney)).toBe("$550");
    expect(remittanceLabel(null, "daily", formatMoney)).toBe("—");
  });
  it("turns a commission into points of the advance", () => {
    expect(commissionPoints(250_000, 5_000_000)).toBe(5);
    expect(commissionPoints(312_500, 5_000_000)).toBe(6.3);
    expect(commissionPoints(null, 5_000_000)).toBeNull();
    expect(commissionPoints(100, 0)).toBeNull();
  });
});

const position = (over: Partial<PositionRow> = {}): PositionRow => ({
  id: "p1",
  position_no: 1,
  funder_name: "Libertas",
  funded_amount_cents: 4_000_000,
  payback_cents: 5_480_000,
  balance_cents: 2_100_000,
  payment_cents: 40_000,
  frequency: "daily",
  funded_on: "2026-08-01",
  note: "",
  ...over,
});

describe("positions", () => {
  it("defaults the next position to one past the deepest", () => {
    expect(nextPositionNo([])).toBe(1);
    expect(nextPositionNo([{ position_no: 1 }, { position_no: 2 }])).toBe(3);
    expect(nextPositionNo([{ position_no: 4 }])).toBe(5);
    expect(nextPositionNo([{ position_no: 20 }])).toBe(20);
  });
  it("says 1st 2nd 3rd 4th and handles the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ]);
  });
  it("rolls up the stack", () => {
    const r = positionRollup([
      position(),
      position({
        id: "p2",
        position_no: 2,
        funded_amount_cents: 2_500_000,
        payback_cents: 3_550_000,
        balance_cents: 3_000_000,
      }),
    ]);
    expect(r.count).toBe(2);
    expect(r.totalBalanceCents).toBe(5_100_000);
    expect(r.nextPosition).toBe(3);
    expect(r.paidDownPct).toBe(43.5);
  });
  it("does not guess a percentage without payback figures", () => {
    expect(positionRollup([position({ payback_cents: null })]).paidDownPct).toBeNull();
    expect(positionPaidDownPct({ payback_cents: null, balance_cents: 100 })).toBeNull();
    expect(positionPaidDownPct(position())).toBe(61.7);
  });
  it("starts a new form on the next position and an edit form from the row", () => {
    expect(positionForm(undefined, 3)).toMatchObject({
      positionNo: "3",
      funderName: "",
      frequency: "",
    });
    expect(positionForm(position(), 3)).toMatchObject({
      positionNo: "1",
      funderName: "Libertas",
      fundedAmount: "40000",
      payback: "54800",
      balance: "21000",
      payment: "400",
      frequency: "daily",
      fundedOn: "2026-08-01",
    });
  });
  it("sends blank frequency and date as null, and only includes an id when editing", () => {
    const blank = positionPayload("c1", positionForm(undefined, 2));
    expect(blank).toMatchObject({
      clientId: "c1",
      positionNo: "2",
      frequency: null,
      fundedOn: null,
    });
    expect("id" in blank).toBe(false);
    expect(positionPayload("c1", positionForm(position(), 2), "p1")).toMatchObject({ id: "p1" });
  });
  it("rejects a position outside 1 to 20 before it reaches the server", () => {
    expect(positionError({ ...positionForm(undefined, 3), positionNo: "" })).not.toBeNull();
    expect(positionError({ ...positionForm(undefined, 3), positionNo: "0" })).not.toBeNull();
    expect(positionError({ ...positionForm(undefined, 3), positionNo: "2.5" })).not.toBeNull();
    expect(positionError({ ...positionForm(undefined, 3), positionNo: "21" })).not.toBeNull();
    expect(positionError({ ...positionForm(undefined, 3), positionNo: "3" })).toBeNull();
  });
});

const offer = (over: Partial<OfferRow> = {}): OfferRow => ({
  id: "o1",
  funder_name: "Fox Capital",
  amount_cents: 5_000_000,
  factor_rate: 1.42,
  payment_cents: 45_000,
  frequency: "daily",
  position_no: 2,
  term_days: 120,
  offered_on: "2026-10-01",
  won: false,
  note: "",
  ...over,
});

describe("competing offers", () => {
  it("gives no insight for fewer than two offers", () => {
    expect(offerInsight([])).toBeNull();
    expect(offerInsight([offer()])).toBeNull();
  });
  it("averages the factor rate across offers that list one", () => {
    const i = offerInsight([
      offer({ factor_rate: 1.3 }),
      offer({ factor_rate: 1.42 }),
      offer({ factor_rate: null }),
    ]);
    expect(i).toEqual({ average: 1.36, low: 1.3, high: 1.42, counted: 2, total: 3 });
  });
  it("has nothing to say when no offer lists a factor", () => {
    expect(offerInsight([offer({ factor_rate: null }), offer({ factor_rate: null })])).toBeNull();
  });
  it("pre-fills an edit from the row and sends a blank date as undefined", () => {
    const f = offerForm(offer({ won: true }), TODAY);
    expect(f).toMatchObject({
      funderName: "Fox Capital",
      amount: "50000",
      factorRate: "1.42",
      payment: "450",
      positionNo: "2",
      termDays: "120",
      won: true,
    });
    expect(offerForm(undefined, TODAY)).toMatchObject({ offeredOn: TODAY, won: false });
    expect(offerPayload("c1", { ...f, offeredOn: "" }, "o1")).toMatchObject({
      id: "o1",
      offeredOn: undefined,
      won: true,
      frequency: "daily",
    });
  });
});

const stip = (over: Partial<StipRow>): StipRow => ({
  id: "s",
  kind: "bank_statement",
  period: null,
  required: true,
  received_at: null,
  ...over,
});

describe("stips", () => {
  const list = [
    stip({ id: "v", kind: "voided_check" }),
    stip({ id: "aug", period: "2026-08-01" }),
    stip({ id: "dl", kind: "drivers_license" }),
    stip({ id: "app", kind: "signed_application" }),
    stip({ id: "jul", period: "2026-07-01", received_at: "2026-10-01T00:00:00Z" }),
    stip({ id: "tax", kind: "tax_return", required: false }),
  ];
  it("orders the checklist application, statements oldest first, ID, check — required before optional", () => {
    const { required, optional } = splitStips(list);
    expect(required.map((s) => s.id)).toEqual(["app", "jul", "aug", "dl", "v"]);
    expect(optional.map((s) => s.id)).toEqual(["tax"]);
  });
  it("rolls up required items only and names what is missing", () => {
    const r = rollupOf(list);
    expect(r).toMatchObject({ requiredTotal: 5, requiredReceived: 1, ready: false });
    expect(r.missing).toEqual(
      expect.arrayContaining(["Aug 2026 statement", "Voided check", "Signed application"]),
    );
  });
  it("is ready when every required stip is in, even with optional ones open", () => {
    const done = list.map((s) => (s.required ? { ...s, received_at: "2026-10-02T00:00:00Z" } : s));
    expect(rollupOf(done)).toMatchObject({ ready: true, missing: [] });
  });
  it("flips one stip optimistically without touching the others or the input", () => {
    const next = setStipReceived(list, "aug", true, "2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "aug")?.received_at).toBe("2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "v")?.received_at).toBeNull();
    expect(list.find((s) => s.id === "aug")?.received_at).toBeNull();
    const back = setStipReceived(next, "aug", false, "x");
    expect(back.find((s) => s.id === "aug")?.received_at).toBeNull();
  });
  it("keeps the original received time when ticked twice", () => {
    const next = setStipReceived(list, "jul", true, "2026-10-23T00:00:00Z");
    expect(next.find((s) => s.id === "jul")?.received_at).toBe("2026-10-01T00:00:00Z");
  });
});

// $50,000 at 1.31 = $65,500 back, $550 per business day. 2026-07-19 is a Sunday.
const funding = (over: Partial<FundingRow> = {}): FundingRow => ({
  id: "f1",
  funded_on: "2026-07-19",
  funder_name: "Libertas",
  amount_cents: 5_000_000,
  factor_rate: 1.31,
  payback_cents: 6_550_000,
  payment_cents: 55_000,
  frequency: "daily",
  position_no: 1,
  term_days: 120,
  commission_cents: null,
  paid_back_override_cents: null,
  status: "active",
  defaulted_on: null,
  last_payment_on: null,
  promise_to_pay_at: null,
  promise_amount_cents: null,
  note: "",
  ...over,
});

describe("funding card numbers", () => {
  it("maps the row to funding terms, carrying the override", () => {
    expect(fundingTerms(funding())).toEqual({
      fundedOn: "2026-07-19",
      amountCents: 5_000_000,
      factorRate: 1.31,
      paymentCents: 55_000,
      frequency: "daily",
      paidBackOverrideCents: null,
    });
    expect(fundingTerms(funding({ paid_back_override_cents: 123_400 })).paidBackOverrideCents).toBe(
      123_400,
    );
  });
  it("estimates from remittances elapsed when nothing was entered", () => {
    const f = funding();
    const s = fundingSnapshot(f, TODAY);
    expect(s.overridden).toBe(false);
    expect(s.paidCents).toBe(paidToDateCents(fundingTerms(f), TODAY));
    expect(s.pct).toBe(paydownPct(fundingTerms(f), TODAY));
    expect(s.balanceCents).toBe(s.paybackCents - s.paidCents);
    expect(s.paybackCents).toBe(6_550_000);
    expect(s.renewalOn).toBe(renewalDate(fundingTerms(f), TODAY));
  });
  it("uses the amount Isaac entered, and says so", () => {
    const s = fundingSnapshot(funding({ paid_back_override_cents: 1_000_000 }), TODAY);
    expect(s.overridden).toBe(true);
    expect(s.paidCents).toBe(1_000_000);
    expect(s.balanceCents).toBe(5_550_000);
    expect(s.pct).toBe(15.3);
    expect(s.pastHalfway).toBe(false);
  });
  it("treats an override of zero as entered, not as missing", () => {
    const s = fundingSnapshot(funding({ paid_back_override_cents: 0 }), TODAY);
    expect(s.overridden).toBe(true);
    expect(s.paidCents).toBe(0);
  });
  it("caps paid-to-date at the payback", () => {
    const s = fundingSnapshot(funding({ paid_back_override_cents: 99_000_000 }), TODAY);
    expect(s.paidCents).toBe(6_550_000);
    expect(s.balanceCents).toBe(0);
    expect(s.pct).toBe(100);
    expect(s.pastHalfway).toBe(true);
  });
  it("puts the renewal call today once the merchant is already past 50%", () => {
    const s = fundingSnapshot(funding({ paid_back_override_cents: 4_000_000 }), TODAY);
    expect(s.pastHalfway).toBe(true);
    expect(s.renewalOn).not.toBeNull();
    expect((s.renewalOn ?? "") >= TODAY).toBe(true);
  });
  it("pre-fills the update form in Isaac's timezone and sends blanks as null", () => {
    const f = funding({
      paid_back_override_cents: 1_234_500,
      last_payment_on: "2026-10-20",
      promise_to_pay_at: "2026-10-27T18:30:00Z",
      promise_amount_cents: 250_000,
      note: "Says Friday",
    });
    const form = fundingForm(f, "America/New_York");
    expect(form).toEqual({
      paidBackOverride: "12345",
      lastPaymentOn: "2026-10-20",
      promiseToPayAt: "2026-10-27T14:30",
      promiseAmount: "2500",
      note: "Says Friday",
    });
    expect(parseMoney(form.paidBackOverride)).toBe(1_234_500);
    const blank = fundingPayload("f1", fundingForm(funding(), "America/New_York"));
    expect(blank).toMatchObject({
      fundingId: "f1",
      paidBackOverride: "",
      lastPaymentOn: null,
      promiseToPayAt: null,
    });
  });
});

describe("ask and client forms", () => {
  it("starts an ask empty, and pre-fills from the latest", () => {
    expect(askForm(undefined)).toEqual({
      wantedAmount: "",
      wantedTerms: "",
      estApproval: "",
      estApprovalNote: "",
    });
    expect(
      askForm({
        id: "a",
        wanted_amount_cents: 7_500_000,
        wanted_terms: "9 months",
        est_approval_cents: 4_500_050,
        est_approval_note: "two positions",
        created_at: "2026-10-23T00:00:00Z",
      }),
    ).toEqual({
      wantedAmount: "75000",
      wantedTerms: "9 months",
      estApproval: "45000.50",
      estApprovalNote: "two positions",
    });
  });
  it("round-trips the client details form, blank date becoming null", () => {
    const card = {
      business_name: "Rivera Auto Repair",
      dba: "",
      contact_name: "Tony Rivera",
      phone: "(305) 555-0121",
      email: "t@example.com",
      industry: "Auto",
      state: "FL",
      source: "",
      monthly_revenue_cents: 8_500_000,
      time_in_business_months: 42,
      application_received_on: null,
    } as ClientCard;
    const form = clientForm(card);
    expect(form.monthlyRevenue).toBe("85000");
    expect(form.timeInBusinessMonths).toBe("42");
    expect(form.applicationReceivedOn).toBe("");
    expect(clientFieldsPayload(form)).toMatchObject({
      businessName: "Rivera Auto Repair",
      monthlyRevenue: "85000",
      applicationReceivedOn: null,
    });
    expect(
      clientFieldsPayload({ ...form, applicationReceivedOn: "2026-10-01" }).applicationReceivedOn,
    ).toBe("2026-10-01");
  });
});
