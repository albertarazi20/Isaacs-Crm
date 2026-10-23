import { describe, expect, it } from "vitest";
import type { FundingRow } from "@/lib/data/types";
import { termsUpdateSchema, commissionReceivedSchema } from "@/lib/earnings/schemas";
import {
  checkTerms,
  factorInput,
  moneyInput,
  renewalMove,
  switchCommissionMode,
  termsForm,
  termsPayload,
  termsPreview,
  type EditableFunding,
  type TermsForm,
} from "@/lib/earnings/terms";
import { renewalDate } from "@/lib/mca/funding";
import { parseMoney } from "@/lib/money";

const TODAY = "2026-10-23";

function funding(over: Partial<EditableFunding> = {}): EditableFunding {
  const base: FundingRow = {
    id: "11111111-1111-4111-8111-111111111111",
    funded_on: "2026-10-01",
    funder_name: "Alpha Capital",
    amount_cents: 5_000_000,
    factor_rate: 1.32,
    payback_cents: 6_600_000,
    payment_cents: 55_000,
    frequency: "daily",
    position_no: 1,
    term_days: null,
    commission_cents: null,
    paid_back_override_cents: null,
    status: "active",
    defaulted_on: null,
    last_payment_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    note: "",
  };
  return { ...base, ...over };
}
const form = (over: Partial<TermsForm> = {}): TermsForm => ({
  ...termsForm(funding(), "America/New_York"),
  ...over,
});

describe("the dialog starts from what is stored", () => {
  it("fills every box, and money parses back to the same cents", () => {
    const f = termsForm(
      funding({
        commission_cents: 250_050,
        commission_received_cents: 250_050,
        commission_received_on: "2026-10-12",
        paid_back_override_cents: 1_000_000,
        last_payment_on: "2026-10-20",
        promise_to_pay_at: "2026-10-27T18:30:00Z",
        promise_amount_cents: 150_000,
        term_days: 180,
        note: "hello",
      }),
      "America/New_York",
    );
    expect(f).toMatchObject({
      fundedOn: "2026-10-01",
      funderName: "Alpha Capital",
      amount: "50000",
      factorRate: "1.32",
      payment: "550",
      frequency: "daily",
      positionNo: "1",
      termDays: "180",
      commissionMode: "dollars",
      commission: "2500.50",
      commissionReceived: "2500.50",
      commissionReceivedOn: "2026-10-12",
      paidBackOverride: "10000",
      lastPaymentOn: "2026-10-20",
      promiseToPayAt: "2026-10-27T14:30",
      promiseAmount: "1500",
      note: "hello",
    });
    for (const cents of [0, 1, 99, 100, 5_012_345, 6_600_000]) {
      expect(parseMoney(moneyInput(cents))).toBe(cents);
    }
    expect(moneyInput(null)).toBe("");
    expect(factorInput(1.3)).toBe("1.30");
    expect(factorInput(1.315)).toBe("1.315");
  });

  it("a form built from a stored advance is valid as it stands", () => {
    const { errors, terms } = checkTerms(form(), TODAY);
    expect(errors).toEqual({});
    expect(terms).toMatchObject({ amountCents: 5_000_000, factorRate: 1.32, paymentCents: 55_000 });
  });
});

describe("plain-words validation", () => {
  it("explains each problem", () => {
    const e = (over: Partial<TermsForm>) => checkTerms(form(over), TODAY).errors;
    expect(e({ fundedOn: "" }).fundedOn).toBe("Pick the funded date");
    expect(e({ fundedOn: "2026-10-24" }).fundedOn).toMatch(/future/);
    expect(e({ amount: "" }).amount).toMatch(/Enter the advance amount/);
    expect(e({ amount: "abc" }).amount).toMatch(/Use an amount/);
    expect(e({ amount: "0" }).amount).toMatch(/more than \$0/);
    expect(e({ factorRate: "0.9" }).factorRate).toMatch(/between 1.00 and 3.00/);
    expect(e({ factorRate: "" }).factorRate).toMatch(/between 1.00 and 3.00/);
    expect(e({ payment: "" }).payment).toMatch(/Enter the remittance/);
    expect(e({ payment: "70k" }).payment).toBe(
      "One remittance can't be more than the whole payback",
    );
    expect(e({ payment: "1" }).payment).toMatch(/more than 5 years/);
    expect(e({ positionNo: "0" }).positionNo).toMatch(/1 to 20/);
    expect(e({ positionNo: "" }).positionNo).toMatch(/1 to 20/);
    expect(e({ termDays: "ten" }).termDays).toMatch(/whole number of days/);
    expect(e({ lastPaymentOn: "2026-09-01" }).lastPaymentOn).toMatch(/before the funded date/);
    expect(e({ lastPaymentOn: "2026-10-30" }).lastPaymentOn).toMatch(/future/);
    expect(e({ promiseToPayAt: "tomorrow" }).promiseToPayAt).toBeDefined();
    expect(e({ promiseAmount: "-5" }).promiseAmount).toBeDefined();
    expect(e({ paidBackOverride: "lots" }).paidBackOverride).toMatch(/Use an amount/);
  });

  it("commission received needs both the amount and the day", () => {
    const e = (over: Partial<TermsForm>) => checkTerms(form(over), TODAY).errors;
    expect(e({ commissionReceived: "2500" }).commissionReceivedOn).toMatch(
      /day the commission arrived/,
    );
    expect(e({ commissionReceivedOn: "2026-10-12" }).commissionReceived).toMatch(/amount received/);
    expect(
      e({ commissionReceived: "2500", commissionReceivedOn: "2026-11-01" }).commissionReceivedOn,
    ).toMatch(/future/);
    expect(e({ commissionReceived: "2500", commissionReceivedOn: "2026-10-12" })).toEqual({});
  });

  it("the preview keeps working while an optional field is wrong", () => {
    const c = checkTerms(form({ termDays: "ten", note: "x" }), TODAY);
    expect(c.errors.termDays).toBeDefined();
    expect(c.terms).not.toBeNull();
    expect(checkTerms(form({ amount: "" }), TODAY).terms).toBeNull();
  });
});

describe("commission in points or dollars", () => {
  it("reads points as a share of the advance", () => {
    const c = checkTerms(form({ commissionMode: "points", commission: "5.2" }), TODAY);
    expect(c.commissionCents).toBe(260_000);
    expect(
      checkTerms(form({ commissionMode: "points", commission: "120" }), TODAY).errors.commission,
    ).toMatch(/between 0 and 100/);
    expect(
      checkTerms(form({ commissionMode: "points", commission: "5%" }), TODAY).commissionCents,
    ).toBe(250_000);
  });

  it("reads dollars as dollars, and refuses more than the advance", () => {
    expect(checkTerms(form({ commission: "2,500" }), TODAY).commissionCents).toBe(250_000);
    const over = checkTerms(form({ commission: "60k" }), TODAY);
    expect(over.errors.commission).toMatch(/more than the advance/);
    expect(over.commissionCents).toBeNull();
    expect(checkTerms(form({ commission: "" }), TODAY).commissionCents).toBeNull();
  });

  it("switching between them keeps the meaning", () => {
    const dollars = form({ commission: "2600" });
    const pts = switchCommissionMode(dollars, "points");
    expect(pts).toMatchObject({ commissionMode: "points", commission: "5.2" });
    expect(switchCommissionMode(pts, "dollars")).toMatchObject({
      commissionMode: "dollars",
      commission: "2600",
    });
    expect(switchCommissionMode(dollars, "dollars")).toBe(dollars);
    expect(switchCommissionMode(form({ commission: "" }), "points").commission).toBe("");
  });
});

describe("live preview and the renewal move", () => {
  it("shows payback, remittances to pay off, payoff date and renewal call from the terms", () => {
    const { terms } = checkTerms(
      form({ fundedOn: "2026-01-05", payment: "550", amount: "50000", factorRate: "1.32" }),
      TODAY,
    );
    if (!terms) throw new Error("terms");
    const p = termsPreview(terms, 250_000, TODAY);
    expect(p).toMatchObject({
      paybackCents: 6_600_000,
      remittances: 120,
      payoffOn: "2026-06-22",
      renewalOn: TODAY, // past 50% already: today
      pctPaid: 100,
      commissionPoints: 5,
    });
    expect(renewalDate(terms, TODAY)).toBe(p.renewalOn);
  });

  it("says when saving would move the renewal call, and not when it wouldn't", () => {
    const before = checkTerms(form(), TODAY).terms;
    const after = checkTerms(form({ payment: "600" }), TODAY).terms;
    if (!before || !after) throw new Error("terms");
    expect(renewalMove(before, after)).toEqual({ from: "2026-12-24", to: "2026-12-17" });
    expect(renewalMove(before, { ...before, paidBackOverrideCents: 123 })).toBeNull();
  });
});

describe("what the form sends", () => {
  it("round-trips through the server schema to cents the database stores", () => {
    const f = form({
      amount: "$52,000",
      factorRate: "1.35",
      payment: "600",
      commissionMode: "points",
      commission: "5",
      commissionReceived: "2,600",
      commissionReceivedOn: "2026-10-12",
      lastPaymentOn: "2026-10-20",
      promiseToPayAt: "2026-10-27T14:30",
      promiseAmount: "1,500",
      termDays: "180",
      positionNo: "2",
      paidBackOverride: "10k",
    });
    const checked = checkTerms(f, TODAY);
    expect(checked.errors).toEqual({});
    const parsed = termsUpdateSchema.parse(
      termsPayload("11111111-1111-4111-8111-111111111111", f, checked.commissionCents),
    );
    expect(parsed).toMatchObject({
      amount: 5_200_000,
      factorRate: 1.35,
      payment: 60_000,
      frequency: "daily",
      positionNo: 2,
      termDays: 180,
      commission: 260_000,
      commissionReceived: 260_000,
      commissionReceivedOn: "2026-10-12",
      lastPaymentOn: "2026-10-20",
      promiseToPayAt: "2026-10-27T14:30",
      promiseAmount: 150_000,
      paidBackOverride: 1_000_000,
    });
  });

  it("blank optional boxes become null, not empty strings or zero", () => {
    const parsed = termsUpdateSchema.parse(
      termsPayload("11111111-1111-4111-8111-111111111111", form(), null),
    );
    expect(parsed).toMatchObject({
      termDays: null,
      commission: null,
      commissionReceived: null,
      commissionReceivedOn: null,
      paidBackOverride: null,
      lastPaymentOn: null,
      promiseToPayAt: null,
      promiseAmount: null,
    });
  });

  it("the server refuses what the form would also refuse, and what it must never store", () => {
    const base = termsPayload("11111111-1111-4111-8111-111111111111", form(), null);
    expect(() => termsUpdateSchema.parse({ ...base, factorRate: "0.5" })).toThrow(
      /between 1.00 and 3.00/,
    );
    expect(() => termsUpdateSchema.parse({ ...base, positionNo: "0" })).toThrow(/Position/);
    expect(() => termsUpdateSchema.parse({ ...base, frequency: "hourly" })).toThrow();
    expect(() => termsUpdateSchema.parse({ ...base, funderName: "Alpha\nCapital" })).toThrow(
      /line breaks/,
    );
    expect(() => termsUpdateSchema.parse({ ...base, note: "ssn 123-45-6789" })).toThrow();
    expect(() => termsUpdateSchema.parse({ ...base, fundingId: "nope" })).toThrow();
    expect(() =>
      commissionReceivedSchema.parse({
        fundingId: base.fundingId,
        amount: "x",
        receivedOn: "2026-10-12",
      }),
    ).toThrow();
    expect(
      commissionReceivedSchema.parse({
        fundingId: base.fundingId,
        amount: "2,500",
        receivedOn: "2026-10-12",
      }),
    ).toEqual({
      fundingId: base.fundingId,
      amount: 250_000,
      receivedOn: "2026-10-12",
    });
  });
});
