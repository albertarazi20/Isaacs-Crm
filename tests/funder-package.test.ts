import { describe, expect, it } from "vitest";
import type { ClientCard, PositionRow, StipRow } from "@/lib/data/types";
import { buildSubmissionPackage, gmailComposeUrl } from "@/lib/funders/package";

const card = (over: Partial<ClientCard> = {}): ClientCard =>
  ({
    business_name: "Mike's Pizza",
    dba: "",
    contact_name: "Mike Ross",
    phone: "+13055550100",
    email: "mike@pizza.example",
    industry: "Restaurant",
    state: "TX",
    monthly_revenue_cents: 8_500_000,
    time_in_business_months: 36,
    wanted_amount_cents: 5_000_000,
    wanted_terms: "6 months",
    last_call_note: "INTERNAL: he hates funder Alpha",
    ...over,
  }) as ClientCard;
const position = (n: number, over: Partial<PositionRow> = {}): PositionRow => ({
  id: `p${n}`,
  position_no: n,
  funder_name: "Alpha Funding",
  funded_amount_cents: 3_000_000,
  payback_cents: 3_900_000,
  balance_cents: 1_200_000,
  payment_cents: 32_000,
  frequency: "daily",
  funded_on: "2026-06-01",
  note: "",
  ...over,
});
const stip = (
  kind: StipRow["kind"],
  period: string | null,
  received: boolean,
  required = true,
): StipRow => ({
  id: `${kind}${period}`,
  kind,
  period,
  required,
  received_at: received ? "2026-10-01T00:00:00Z" : null,
});

describe("buildSubmissionPackage", () => {
  it("states the deal in plain text a funder can act on", () => {
    const p = buildSubmissionPackage({
      card: card(),
      positions: [position(1)],
      stips: [
        stip("bank_statement", "2026-09-01", true),
        stip("bank_statement", "2026-08-01", true),
        stip("bank_statement", "2026-07-01", false),
      ],
      senderName: "Isaac",
      funderContact: "Dana",
    });
    expect(p.subject).toBe("New submission: Mike's Pizza (Restaurant, TX) — $50k requested");
    expect(p.body).toContain("Hi Dana,");
    expect(p.body).toContain("Owner / contact: Mike Ross · (305) 555-0100 · mike@pizza.example");
    expect(p.body).toContain("Time in business: 36 months");
    expect(p.body).toContain("Monthly revenue: $85,000");
    expect(p.body).toContain("Requested: $50,000 (6 months)");
    expect(p.body).toContain("Position: would be 2nd");
    expect(p.body).toContain(
      "1st: Alpha Funding — funded $30,000, balance $12,000, remitting $320 daily",
    );
    expect(p.body).toContain("Bank statements: Sep 2026, Aug 2026 (still missing: Jul 2026)");
    expect(p.body.trim().endsWith("Isaac")).toBe(true);
  });
  it("never includes internal notes", () => {
    const p = buildSubmissionPackage({
      card: card(),
      positions: [],
      stips: [],
      senderName: "Isaac",
    });
    expect(p.body).not.toContain("INTERNAL");
    expect(p.body).not.toContain("hates");
  });
  it("copes with a bare-bones merchant: no invented facts", () => {
    const p = buildSubmissionPackage({
      card: card({
        industry: "",
        state: "",
        phone: "",
        email: "",
        contact_name: "",
        monthly_revenue_cents: null,
        time_in_business_months: null,
        wanted_amount_cents: null,
        wanted_terms: null,
      }),
      positions: [],
      stips: [],
      senderName: "",
    });
    expect(p.subject).toBe("New submission: Mike's Pizza");
    expect(p.body).toContain("Hi team,");
    expect(p.body).toContain("Requested: to be discussed");
    expect(p.body).toContain("Position: would be 1st");
    expect(p.body).toContain("No other advances.");
    expect(p.body).not.toMatch(/Monthly revenue|Time in business|Industry|State:/);
  });
  it("keeps the subject on one line even with hostile names", () => {
    const p = buildSubmissionPackage({
      card: card({ business_name: "Evil\r\nBcc: x@y.z" }),
      positions: [],
      stips: [],
      senderName: "I",
    });
    expect(p.subject).not.toMatch(/[\r\n]/);
  });
  it("lists required documents that are in and still being collected", () => {
    const p = buildSubmissionPackage({
      card: card(),
      positions: [],
      stips: [
        stip("signed_application", null, true),
        stip("drivers_license", null, false),
        stip("tax_return", null, false, false),
      ],
      senderName: "Isaac",
    });
    expect(p.body).toContain("Documents attached: Signed application");
    expect(p.body).toContain("Still collecting: Driver's license / ID");
    expect(p.body).not.toContain("Tax return");
  });
  it("shows the most 6 existing advances", () => {
    const p = buildSubmissionPackage({
      card: card(),
      positions: Array.from({ length: 9 }, (_, i) => position(i + 1)),
      stips: [],
      senderName: "I",
    });
    expect(p.body.match(/ — funded /g)).toHaveLength(6);
  });
});

describe("gmailComposeUrl", () => {
  const pkg = { subject: "New submission: A & B", body: "Line one\nLine two — 50%" };
  it("builds a compose link with the address, subject and body encoded", () => {
    const url = new URL(gmailComposeUrl(" sub@funder.example ", pkg));
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("to")).toBe("sub@funder.example");
    expect(url.searchParams.get("su")).toBe("New submission: A & B");
    expect(url.searchParams.get("body")).toBe("Line one\nLine two — 50%");
  });
  it("encodes spaces as %20, never '+'", () => {
    expect(gmailComposeUrl("a@b.co", pkg)).not.toContain("+");
  });
  it("cuts a very long body instead of producing a link Gmail refuses", () => {
    const url = new URL(gmailComposeUrl("a@b.co", { subject: "s", body: "x".repeat(9000) }));
    expect((url.searchParams.get("body") ?? "").length).toBeLessThan(3600);
  });
});
