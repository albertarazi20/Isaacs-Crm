import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addDays,
  addMonths,
  bucketFor,
  dueFromPreset,
  FOLLOW_UP_PRESETS,
  parseISODate,
  todayIn,
  validateFollowUpDate,
} from "@/lib/mca/dates";

// 2026-10-23 is a Friday.
const TODAY = "2026-10-23";

describe("month math", () => {
  it("clamps to the last day instead of spilling into the next month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
  it("reaches 36 months exactly", () => {
    expect(addMonths(TODAY, 36)).toBe("2029-10-23");
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
  it("rejects impossible dates", () => {
    expect(() => parseISODate("2026-02-30")).toThrow();
    expect(() => parseISODate("nope")).toThrow();
  });
});

describe("business days", () => {
  it("skips weekends", () => {
    expect(addBusinessDays(TODAY, 1)).toBe("2026-10-26");
    expect(addBusinessDays(TODAY, 5)).toBe("2026-10-30");
  });
});

describe("timezone", () => {
  it("uses the user's calendar day, not UTC's", () => {
    expect(todayIn("America/New_York", new Date("2026-10-24T02:00:00Z"))).toBe("2026-10-23");
    expect(todayIn("UTC", new Date("2026-10-24T02:00:00Z"))).toBe("2026-10-24");
  });
});

describe("presets", () => {
  it("offers every duration up to 36 months", () => {
    expect(FOLLOW_UP_PRESETS.map((p) => p.key)).toEqual([
      "1w",
      "2w",
      "1m",
      "2m",
      "3m",
      "6m",
      "9m",
      "12m",
      "18m",
      "24m",
      "36m",
    ]);
    expect(dueFromPreset("1w", TODAY)).toBe("2026-10-30");
    expect(dueFromPreset("36m", TODAY)).toBe("2029-10-23");
  });
  it("validates custom dates against the 36 month ceiling", () => {
    expect(validateFollowUpDate("2029-10-23", TODAY)).toBeNull();
    expect(validateFollowUpDate("2029-10-24", TODAY)).toMatch(/36 months/);
    expect(validateFollowUpDate("2026-10-22", TODAY)).toMatch(/past/);
    expect(validateFollowUpDate(TODAY, TODAY)).toBeNull();
  });
});

describe("follow-up buckets", () => {
  it.each([
    ["2026-10-22", "overdue"],
    ["2026-10-23", "today"],
    ["2026-10-24", "1w"],
    ["2026-10-30", "1w"],
    ["2026-10-31", "2w"],
    ["2026-11-23", "1m"],
    ["2026-11-24", "2m"],
    ["2027-04-23", "6m"],
    ["2027-04-24", "9m"],
    ["2027-07-23", "9m"],
    ["2027-07-24", "12m"],
    ["2027-10-23", "12m"],
    ["2027-10-24", "18m"],
    ["2028-04-23", "18m"],
    ["2028-04-24", "24m"],
    ["2029-10-23", "36m"],
    ["2029-10-24", "later"],
  ])("%s lands in %s", (due, bucket) => {
    expect(bucketFor(due, TODAY)).toBe(bucket);
  });
});
