import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyCompact, parseMoney } from "@/lib/money";
import {
  OUTCOMES_BY_KIND,
  outcomeLabel,
  suggestAfterEmail,
  suggestNextFollowUp,
} from "@/lib/mca/touch";

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
});

describe("suggested next follow-up", () => {
  // 2026-10-23 is a Friday.
  it("retries quickly when he did not reach anyone — on business days", () => {
    expect(suggestNextFollowUp("no_answer", "2026-10-23")).toBe("2026-10-26");
    expect(suggestNextFollowUp("left_message", "2026-10-23")).toBe("2026-10-27");
    expect(suggestNextFollowUp("bad_number", "2026-10-23")).toBe("2026-10-30");
    expect(suggestNextFollowUp("reached", "2026-10-23")).toBe("2026-11-06");
  });
  it("keeps a hot stage's own pace instead of drifting to two weeks", () => {
    expect(suggestNextFollowUp("reached", "2026-10-23", "contract_out")).toBe("2026-10-26");
    expect(suggestNextFollowUp("reached", "2026-10-23", "offers_in")).toBe("2026-10-26");
    expect(suggestNextFollowUp("reached", "2026-10-23", "interested")).toBe("2026-10-27");
  });
  it("caps slow stages at two weeks — exits don't wait a month or a year", () => {
    expect(suggestNextFollowUp("reached", "2026-10-23", "dead")).toBe("2026-11-06");
    expect(suggestNextFollowUp("reached", "2026-10-23", "not_interested")).toBe("2026-11-06");
  });
  it("after an email: three business days, or the stage's pace if sooner", () => {
    expect(suggestAfterEmail("2026-10-23")).toBe("2026-10-28");
    expect(suggestAfterEmail("2026-10-23", "contract_out")).toBe("2026-10-26");
    expect(suggestAfterEmail("2026-10-23", "dead")).toBe("2026-10-28");
  });
});

describe("outcome wording", () => {
  it("a text is 'they replied' or 'sent', never 'left a message'", () => {
    expect(OUTCOMES_BY_KIND.text).toEqual(["reached", "left_message", "bad_number"]);
    expect(outcomeLabel("text", "reached")).toBe("They replied");
    expect(outcomeLabel("text", "left_message")).toBe("Sent — no reply yet");
    expect(outcomeLabel("call", "left_message")).toBe("Left message");
    expect(OUTCOMES_BY_KIND.email).toEqual([]);
    expect(OUTCOMES_BY_KIND.call).toHaveLength(4);
  });
});
