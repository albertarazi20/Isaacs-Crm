import { describe, expect, it } from "vitest";
import { callbackAt, callbackLabel } from "../src/lib/mca/callback";

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
    expect(callbackLabel(1)).toBe("1 hour");
    expect(callbackLabel(3)).toBe("3 hours");
  });
});
