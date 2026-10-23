import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyCompact, parseFactor, parseMoney } from "@/lib/money";
import { suggestNextFollowUp } from "@/lib/mca/touch";

describe("parseMoney", () => {
  it.each([
    ["50k", 5_000_000],
    ["50K", 5_000_000],
    ["$75,000", 7_500_000],
    ["1.2m", 120_000_000],
    ["12.5k", 1_250_000],
    ["  $ 1,234.56 ", 123_456],
    ["0", 0],
    [".5k", 50_000],
    [75000, 7_500_000],
  ])("%s → %d cents", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });
  it.each(["", "abc", "-5", "5kk", "1,2,3x", "$", "k"])("rejects %j", (input) => {
    expect(parseMoney(input)).toBeNull();
  });
  it("rejects null, undefined, negatives and NaN", () => {
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney(-1)).toBeNull();
    expect(parseMoney(Number.NaN)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats whole dollars, cents and compact", () => {
    expect(formatMoney(5_000_000)).toBe("$50,000");
    expect(formatMoney(123_456, { cents: true })).toBe("$1,234.56");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoneyCompact(750_000)).toBe("$7.5k");
    expect(formatMoneyCompact(5_000_000)).toBe("$50k");
    expect(formatMoneyCompact(120_000_000)).toBe("$1.2M");
    expect(formatMoneyCompact(40_000)).toBe("$400");
  });
  it("parses factor rates in range only", () => {
    expect(parseFactor("1.32")).toBe(1.32);
    expect(parseFactor("1.4999")).toBe(1.5);
    expect(parseFactor("0.9")).toBeNull();
    expect(parseFactor("4")).toBeNull();
    expect(parseFactor("x")).toBeNull();
  });
});

describe("suggested next follow-up", () => {
  it("retries quickly when he did not reach anyone", () => {
    expect(suggestNextFollowUp("no_answer", "2026-10-23")).toBe("2026-10-24");
    expect(suggestNextFollowUp("left_message", "2026-10-23")).toBe("2026-10-25");
    expect(suggestNextFollowUp("bad_number", "2026-10-23")).toBe("2026-10-30");
    expect(suggestNextFollowUp("reached", "2026-10-23")).toBe("2026-11-06");
  });
});
