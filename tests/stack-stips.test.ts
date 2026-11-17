import { describe, expect, it } from "vitest";
import { defaultStips, stipLabel, stipRollup, type StipInput } from "@/lib/mca/stips";

describe("stip checklist", () => {
  const seeds = defaultStips("2026-10-23", 4);

  it("makes one required box per complete month of statements", () => {
    const statements = seeds.filter((s) => s.kind === "bank_statement");
    expect(statements.map((s) => s.period)).toEqual([
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
    expect(statements.every((s) => s.required)).toBe(true);
  });
  it("requires app, statements, ID and voided check; the rest only when asked", () => {
    expect(seeds.filter((s) => s.required)).toHaveLength(7);
    expect(seeds.filter((s) => !s.required).map((s) => s.kind)).toEqual([
      "proof_of_ownership",
      "tax_return",
      "lease_letter",
      "processing_statement",
    ]);
  });
  it("crosses a year boundary", () => {
    expect(
      defaultStips("2026-02-10", 3)
        .filter((s) => s.period)
        .map((s) => s.period),
    ).toEqual(["2025-11-01", "2025-12-01", "2026-01-01"]);
  });
  it("names the missing month, not just 'statements: partial'", () => {
    const stips: StipInput[] = seeds.map((s) => ({ ...s, received: s.required }));
    const sep = stips.find((s) => s.period === "2026-09-01");
    if (!sep) throw new Error("Sep statement not seeded");
    sep.received = false;
    const r = stipRollup(stips);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["Sep 2026 statement"]);
    expect(r.requiredReceived).toBe(6);
  });
  it("goes ready only when every required stip is in", () => {
    const all: StipInput[] = seeds.map((s) => ({ ...s, received: s.required }));
    expect(stipRollup(all).ready).toBe(true);
    expect(stipRollup([]).ready).toBe(false);
  });
  it("labels statements by month", () => {
    expect(stipLabel({ kind: "bank_statement", period: "2026-07-01" })).toBe("Jul 2026 statement");
    expect(stipLabel({ kind: "voided_check", period: null })).toBe("Voided check");
  });
});
