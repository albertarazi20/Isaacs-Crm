import { describe, expect, it } from "vitest";
import {
  balanceCents,
  dateAtPaydown,
  paybackCents,
  paidToDateCents,
  paydownPct,
  payoffDate,
  remittancesElapsed,
  renewalDate,
  renewalDateFromTerm,
  type FundingTerms,
} from "@/lib/mca/funding";

// $50,000 at 1.32 = $66,000 back, $550/business day => 120 remittances. 2026-01-05 is a Monday.
const daily: FundingTerms = {
  fundedOn: "2026-01-05",
  amountCents: 5_000_000,
  factorRate: 1.32,
  paymentCents: 55_000,
  frequency: "daily",
};

describe("payback", () => {
  it("is amount × factor, rounded to the cent", () => {
    expect(paybackCents(5_000_000, 1.32)).toBe(6_600_000);
    expect(paybackCents(1_234_567, 1.29)).toBe(1_592_591);
  });
});

describe("remittances elapsed", () => {
  it("counts business days for daily", () => {
    expect(remittancesElapsed("2026-01-05", "2026-01-12", "daily")).toBe(5);
  });
  it("counts whole weeks and fortnights", () => {
    expect(remittancesElapsed("2026-01-05", "2026-01-26", "weekly")).toBe(3);
    expect(remittancesElapsed("2026-01-05", "2026-01-25", "weekly")).toBe(2);
    expect(remittancesElapsed("2026-01-05", "2026-02-02", "biweekly")).toBe(2);
  });
  it("counts whole months, respecting month-end clamping", () => {
    expect(remittancesElapsed("2026-01-31", "2026-02-28", "monthly")).toBe(1);
    expect(remittancesElapsed("2026-01-31", "2026-02-27", "monthly")).toBe(0);
  });
  it("is zero on or before the funding date", () => {
    expect(remittancesElapsed("2026-01-05", "2026-01-05", "daily")).toBe(0);
    expect(remittancesElapsed("2026-01-05", "2025-12-01", "daily")).toBe(0);
  });
});

describe("paydown", () => {
  it("is 50% after 60 of 120 remittances", () => {
    expect(paydownPct(daily, "2026-03-30")).toBe(50);
    expect(paidToDateCents(daily, "2026-03-30")).toBe(3_300_000);
    expect(balanceCents(daily, "2026-03-30")).toBe(3_300_000);
  });
  it("never exceeds payback", () => {
    expect(paidToDateCents(daily, "2030-01-01")).toBe(6_600_000);
    expect(paydownPct(daily, "2030-01-01")).toBe(100);
  });
  it("trusts a manual collected figure over the estimate", () => {
    expect(paidToDateCents({ ...daily, paidBackOverrideCents: 1_000_000 }, "2026-03-30")).toBe(
      1_000_000,
    );
    expect(paidToDateCents({ ...daily, paidBackOverrideCents: 99_000_000 }, "2026-03-30")).toBe(
      6_600_000,
    );
  });
});

describe("renewal date", () => {
  it("lands the day the merchant crosses 50% paid down", () => {
    expect(dateAtPaydown(daily, 50)).toBe("2026-03-30");
    expect(renewalDate(daily, "2026-02-01")).toBe("2026-03-30");
  });
  it("is today when the merchant is already past 50%", () => {
    expect(renewalDate(daily, "2026-05-01")).toBe("2026-05-01");
  });
  it("finds the payoff date", () => {
    expect(payoffDate(daily)).toBe("2026-06-22");
  });
  it("works for weekly payers", () => {
    const weekly: FundingTerms = { ...daily, paymentCents: 275_000, frequency: "weekly" };
    expect(dateAtPaydown(weekly, 50)).toBe("2026-03-30");
  });
  it("refuses to guess when there is no usable payment", () => {
    expect(dateAtPaydown({ ...daily, paymentCents: 0 }, 50)).toBeNull();
    expect(renewalDate({ ...daily, paymentCents: 0 }, "2026-02-01")).toBeNull();
  });
  it("calls back at half a competitor's term", () => {
    expect(renewalDateFromTerm("2026-10-23", 180)).toBe("2027-01-21");
  });
});
