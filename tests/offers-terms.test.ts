import { describe, expect, it } from "vitest";
import { offerEmail } from "@/lib/offers/email";
import { computeTerms, exactMoney, offerSchema, termWords, timeLeft } from "@/lib/offers/terms";

/** A merchant offer's numbers and words: what the form previews, the email says and the page shows. */

describe("the arithmetic", () => {
  it("matches the example the owner showed", () => {
    expect(computeTerms({ fundedCents: 8_085_000, factorRate: 1.5, payments: 127 })).toEqual({
      paybackCents: 12_127_500,
      paymentCents: 95_492,
      finalPaymentCents: 95_508,
      costCents: 4_042_500,
    });
  });
  it("rounds each payment down and puts the cents left over on the final one, so they add up exactly", () => {
    // 80,850 × 1.35 = 109,147.50; split 26 ways = 4,197.98…: 25 of $4,197.98 and a final $4,198.00
    const t = computeTerms({ fundedCents: 8_085_000, factorRate: 1.35, payments: 26 });
    expect(t).toMatchObject({
      paybackCents: 10_914_750,
      paymentCents: 419_798,
      finalPaymentCents: 419_800,
    });
    expect(t.paymentCents * 25 + t.finalPaymentCents).toBe(t.paybackCents);
    // the worst case for leftovers: the final payment is never below the others
    const w = computeTerms({ fundedCents: 100_000, factorRate: 1.001, payments: 1000 });
    expect(w.finalPaymentCents).toBeGreaterThanOrEqual(w.paymentCents);
    expect(w.paymentCents * 999 + w.finalPaymentCents).toBe(w.paybackCents);
    // a factor written to three places never drifts (1.499 × 100,000.01)
    expect(
      computeTerms({ fundedCents: 10_000_001, factorRate: 1.499, payments: 1 }).paybackCents,
    ).toBe(14_990_001);
  });
  it("writes money with cents only when there are some", () => {
    expect(exactMoney(419_798)).toBe("$4,197.98");
    expect(exactMoney(8_085_000)).toBe("$80,850");
  });
});

describe("the words", () => {
  it("says how long the payments run", () => {
    expect(termWords("weekly", 26)).toBe("about 6 months");
    expect(termWords("daily", 130)).toBe("about 6 months");
    expect(termWords("weekly", 4)).toBe("about 4 weeks");
    expect(termWords("monthly", 36)).toBe("about 3 years");
    expect(termWords("biweekly", 13)).toBe("about 6 months");
  });
  it("counts down to the end", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(timeLeft("2026-11-20T11:00:00Z", now)).toBe("1d 23h");
    expect(timeLeft("2026-11-18T16:12:00Z", now)).toBe("4h 12m");
    expect(timeLeft("2026-11-18T12:05:00Z", now)).toBe("5m");
    expect(timeLeft("2026-11-18T11:00:00Z", now)).toBeNull();
  });
});

describe("the form", () => {
  const ok = {
    clientId: "11111111-1111-4111-8111-111111111111",
    funded: "$80,850.00",
    factorRate: "1.35",
    frequency: "weekly",
    payments: "26",
    expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
  };
  it("reads dollars as cents and fills the defaults", () => {
    const v = offerSchema.parse(ok);
    expect(v).toMatchObject({
      funded: 8_085_000,
      factorRate: 1.35,
      payments: 26,
      docs: ["drivers_license", "voided_check"],
      send: true,
      message: "",
    });
  });
  it("refuses what an offer cannot be", () => {
    const bad = (over: Record<string, unknown>) =>
      offerSchema.safeParse({ ...ok, ...over }).success;
    expect(bad({ funded: "500" })).toBe(false);
    expect(bad({ funded: "abc" })).toBe(false);
    expect(bad({ factorRate: "0.9" })).toBe(false);
    expect(bad({ factorRate: "2.6" })).toBe(false);
    expect(bad({ factorRate: "1.3555" })).toBe(false);
    expect(bad({ payments: "0" })).toBe(false);
    expect(bad({ payments: "2.5" })).toBe(false);
    expect(bad({ frequency: "hourly" })).toBe(false);
    expect(bad({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(bad({ expiresAt: new Date(Date.now() + 70 * 86_400_000).toISOString() })).toBe(false);
    expect(bad({ docs: ["bank_statement"] })).toBe(false);
    expect(bad({ message: "x".repeat(601) })).toBe(false);
  });
});

describe("the email", () => {
  const mail = offerEmail({
    firstName: "Gayle",
    businessName: 'Winchester <Creek> "Farm"',
    shopName: "Selective Capital",
    fundedCents: 8_085_000,
    paymentCents: 95_493,
    payments: 127,
    frequency: "weekly",
    factorRate: 1.5,
    validThrough: "Thursday, November 19 at 4:32 PM EST",
    url: "https://crm.example.com/offer/abc",
    repName: "Josh Miller",
    repPhone: "(305) 555-0100",
    repEmail: "josh@example.com",
  });
  it("says the terms and links the page, in both parts", () => {
    expect(mail.subject).toBe('Your funding offer for Winchester <Creek> "Farm" is ready');
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain("$80,850");
      expect(part).toContain("$954.93");
      expect(part).toContain("1.500");
      expect(part).toContain("https://crm.example.com/offer/abc");
      expect(part).toContain("Thursday, November 19 at 4:32 PM EST");
    }
    expect(mail.text.startsWith("Hi Gayle,")).toBe(true);
    expect(mail.text).toContain("Josh Miller\nSelective Capital\n(305) 555-0100\njosh@example.com");
  });
  it("never lets a merchant's own name write HTML", () => {
    expect(mail.html).toContain("Winchester &lt;Creek&gt; &quot;Farm&quot;");
    expect(mail.html).not.toContain("<Creek>");
  });
  it("says it is a summary, not a contract", () => {
    expect(mail.html).toContain("not a contract");
  });
});
