import { describe, expect, it } from "vitest";
import { buildSubmissionPackage } from "@/lib/funders/package";
import { compareOffers } from "@/lib/funders/offers";
import { chaseText, inBusinessHours, quietSince } from "@/lib/inbox/chase";
import { mapStipRequests, statementMonthsIn, stipKindOf } from "@/lib/inbox/stips";
import type { ClientCard } from "@/lib/data/types";

describe("S2-1: a lender's stips list becomes checklist rows, by code", () => {
  const today = "2026-11-16";
  it("knows the document kinds from the lender's words", () => {
    expect(stipKindOf("voided check")).toBe("voided_check");
    expect(stipKindOf("Copy of DL")).toBe("drivers_license");
    expect(stipKindOf("photo ID")).toBe("drivers_license");
    expect(stipKindOf("signed application")).toBe("signed_application");
    expect(stipKindOf("last 3 months bank statements")).toBe("bank_statement");
    expect(stipKindOf("processing statements")).toBe("processing_statement");
    expect(stipKindOf("2025 tax return")).toBe("tax_return");
    expect(stipKindOf("landlord letter")).toBe("lease_letter");
    expect(stipKindOf("articles of incorporation")).toBe("proof_of_ownership");
    expect(stipKindOf("a selfie holding the check")).toBe("other");
  });
  it("reads statement months: named, counted, newest, MTD", () => {
    expect(statementMonthsIn("October statement", today)).toEqual(["2026-10-01"]);
    expect(statementMonthsIn("Sept and Oct statements", today)).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(statementMonthsIn("December statement", today)).toEqual(["2025-12-01"]);
    expect(statementMonthsIn("last 3 months statements", today)).toEqual([
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(statementMonthsIn("newest statement", today)).toEqual(["2026-10-01"]);
    // before the 5th the newest month lenders expect is the one before last
    expect(statementMonthsIn("most recent bank statement", "2026-11-03")).toEqual(["2026-09-01"]);
    expect(statementMonthsIn("MTD", today)).toEqual(["2026-11-01"]);
  });
  it("maps a whole list, de-duplicated, keeping the lender's words for 'other'", () => {
    const rows = mapStipRequests(
      [
        "voided check",
        "Voided check",
        "last 2 months statements",
        "October statement",
        "a selfie",
        "proof of a thing",
      ],
      today,
    );
    expect(rows).toEqual([
      { kind: "voided_check", period: null, label: "voided check" },
      { kind: "bank_statement", period: "2026-09-01", label: "last 2 months statements" },
      { kind: "bank_statement", period: "2026-10-01", label: "last 2 months statements" },
      { kind: "other", period: null, label: "a selfie; proof of a thing" },
    ]);
  });
});

describe("S2-6: the chase clock counts business days and only fires in business hours", () => {
  it("skips weekends unless the shop sends on them", () => {
    const monday10 = new Date("2026-11-16T15:00:00Z"); // 10:00 New York
    const since = quietSince(monday10, { days: 3, weekends: false }, "America/New_York");
    expect(since.toISOString()).toBe("2026-11-11T15:00:00.000Z"); // Wed: Thu, Fri, Mon
    const sinceAll = quietSince(monday10, { days: 3, weekends: true }, "America/New_York");
    expect(sinceAll.toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
  it("knows office hours in the rep's zone", () => {
    expect(inBusinessHours(new Date("2026-11-16T15:00:00Z"), "America/New_York", false)).toBe(true);
    expect(inBusinessHours(new Date("2026-11-17T02:00:00Z"), "America/New_York", false)).toBe(
      false,
    ); // 21:00 Mon
    expect(inBusinessHours(new Date("2026-11-14T15:00:00Z"), "America/New_York", false)).toBe(
      false,
    ); // Saturday
    expect(inBusinessHours(new Date("2026-11-14T15:00:00Z"), "America/New_York", true)).toBe(true);
    expect(inBusinessHours(new Date("2026-11-16T15:00:00Z"), "America/Los_Angeles", false)).toBe(
      false,
    ); // 07:00 LA
  });
  it("the nudge is short and names the deal", () => {
    expect(
      chaseText({
        funderName: "Pearl",
        businessName: "Pizza Palace",
        dealNumber: 12,
        senderName: "Josh",
      }),
    ).toBe(
      "Hi Pearl team,\n\nAny update on Pizza Palace (D-12)? Happy to send anything else you need.\n\nThanks,\nJosh",
    );
  });
});

describe("S2-11: offer compare maths", () => {
  const base = {
    submission_id: "s",
    client_id: "c",
    position_no: null,
    note: "",
    received_on: "2026-11-16",
    status: "open" as const,
  };
  it("payback, payment count, net to merchant and commission on each offer; lowest factor is best", () => {
    const rows = compareOffers([
      {
        ...base,
        id: "a",
        funder_name: "Pearl",
        amount_cents: 4_500_000,
        factor_rate: 1.35,
        payment_cents: 50_625,
        frequency: "daily",
        term_days: 120,
        fees_cents: 150_000,
        commission_points: 8,
      },
      {
        ...base,
        id: "b",
        funder_name: "Fora",
        amount_cents: 5_000_000,
        factor_rate: 1.28,
        payment_cents: null,
        frequency: "weekly",
        term_days: 182,
        fees_cents: null,
        commission_points: null,
      },
    ]);
    expect(rows.map((r) => r.offerId)).toEqual(["b", "a"]);
    const a = rows.find((r) => r.offerId === "a")!;
    expect(a).toMatchObject({
      paybackCents: 6_075_000,
      costCents: 1_575_000,
      paymentCount: 120,
      netToMerchantCents: 4_350_000,
      commissionCents: 360_000,
      best: false,
    });
    const b = rows.find((r) => r.offerId === "b")!;
    expect(b).toMatchObject({
      paybackCents: 6_400_000,
      paymentCount: 26,
      netToMerchantCents: 5_000_000,
      commissionCents: null,
      best: true,
    });
  });
  it("a single offer is not 'best'; no payment and no term means no count", () => {
    const [only] = compareOffers([
      {
        ...base,
        id: "x",
        funder_name: "Pearl",
        amount_cents: 1_000_000,
        factor_rate: 1.3,
        payment_cents: null,
        frequency: null,
        term_days: null,
        fees_cents: null,
        commission_points: 10,
      },
    ]);
    expect(only).toMatchObject({ best: false, paymentCount: null, commissionCents: 100_000 });
  });
});

describe("S2-7: the submission package lists the document links", () => {
  it("one line per document, with how long the links last", () => {
    const card = {
      business_name: "Pizza Palace",
      dba: "",
      contact_name: "Mike",
      phone: "3055550100",
      email: "mike@pizza.com",
      industry: "Restaurant",
      state: "FL",
      monthly_revenue_cents: 4_000_000,
      time_in_business_months: 30,
      wanted_amount_cents: 5_000_000,
      wanted_terms: null,
    } as unknown as ClientCard;
    const pkg = buildSubmissionPackage({
      card,
      positions: [],
      stips: [],
      senderName: "Boss",
      documents: [
        { label: "Signed application", url: "https://crm.test/d/abc" },
        { label: "Oct 2026 bank statement", url: "https://crm.test/d/def" },
      ],
      linksGoodFor: "7 days",
    });
    expect(pkg.body).toContain(
      "Documents:\n  Signed application: https://crm.test/d/abc\n  Oct 2026 bank statement: https://crm.test/d/def",
    );
    expect(pkg.body).toContain("Each link is good for 7 days and the copies carry your name.");
    expect(
      buildSubmissionPackage({ card, positions: [], stips: [], senderName: "Boss" }).body,
    ).not.toContain("Documents:");
  });
});
