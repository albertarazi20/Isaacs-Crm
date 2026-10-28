import { describe, expect, it } from "vitest";
import { callbackAt, callbackLabel, clockNow, slotAt, TIME_SLOTS } from "../src/lib/mca/callback";

describe("callback times", () => {
  it("adds hours in the user's own time zone", () => {
    // 2026-10-27 02:00 UTC is 22:00 on the 26th in New York (EDT).
    const now = Date.UTC(2026, 9, 27, 2, 0);
    expect(callbackAt("America/New_York", 3, now)).toBe("2026-10-27T01:00");
    expect(callbackAt("America/New_York", 1, now)).toBe("2026-10-26T23:00");
  });
  it("rolls over midnight and never prints hour 24", () => {
    const now = Date.UTC(2026, 9, 27, 3, 30); // 23:30 on the 26th in New York
    expect(callbackAt("America/New_York", 1, now)).toBe("2026-10-27T00:30");
  });
  it("follows a daylight-saving change", () => {
    // 2026-11-01 05:30 UTC is 01:30 EDT; the clocks fall back at 2:00 EDT, so +1h is 01:30 EST.
    const now = Date.UTC(2026, 10, 1, 5, 30);
    expect(callbackAt("America/New_York", 1, now)).toBe("2026-11-01T01:30");
  });
  it("labels", () => {
    expect(callbackLabel(0.5)).toBe("30 min");
    expect(callbackLabel(1)).toBe("1 hour");
    expect(callbackLabel(3)).toBe("3 hours");
  });
  it("adds 30 minutes", () => {
    const now = Date.UTC(2026, 9, 27, 21, 40); // 17:40 EDT
    expect(callbackAt("America/New_York", 0.5, now)).toBe("2026-10-27T18:10");
  });
});

describe("time of day slots", () => {
  it("has every half hour, 12-hour labels, in order", () => {
    expect(TIME_SLOTS).toHaveLength(48);
    expect(TIME_SLOTS[0]).toEqual({ value: "00:00", label: "12:00 AM" });
    const at = (v: string) => TIME_SLOTS.find((s) => s.value === v)?.label;
    expect(at("05:30")).toBe("5:30 AM");
    expect(at("12:00")).toBe("12:00 PM");
    expect(at("17:30")).toBe("5:30 PM");
    expect(TIME_SLOTS.at(-1)).toEqual({ value: "23:30", label: "11:30 PM" });
    expect(TIME_SLOTS.map((s) => s.value)).toEqual([...TIME_SLOTS.map((s) => s.value)].sort());
  });
  it("builds the datetime the reminder form sends", () => {
    expect(slotAt("2026-10-28", "17:30")).toBe("2026-10-28T17:30");
  });
  it("reads the clock in the user's time zone", () => {
    expect(clockNow("America/New_York", Date.UTC(2026, 9, 27, 21, 40))).toBe("17:40");
  });
});
