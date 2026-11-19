import { describe, expect, it } from "vitest";
import { expiryWords, weekAfterSend } from "@/lib/approvals/engine";

describe("the offer date when the rep typed no hold date: a week after the email goes out, never a weekend", () => {
  const NY = "America/New_York";
  it("is exactly 7 days later on a weekday", () => {
    // Monday Nov 9 2026, 10:00 New York
    expect(weekAfterSend(new Date("2026-11-09T15:00:00Z"), NY)).toBe("2026-11-16"); // Monday
    expect(weekAfterSend(new Date("2026-11-10T15:00:00Z"), NY)).toBe("2026-11-17"); // Tuesday
    expect(weekAfterSend(new Date("2026-11-13T15:00:00Z"), NY)).toBe("2026-11-20"); // Friday
  });
  it("moves a Saturday or Sunday forward to the Monday", () => {
    // sent Saturday Nov 14 -> Nov 21 is a Saturday -> Monday Nov 23
    expect(weekAfterSend(new Date("2026-11-14T15:00:00Z"), NY)).toBe("2026-11-23");
    // sent Sunday Nov 15 -> Nov 22 is a Sunday -> Monday Nov 23
    expect(weekAfterSend(new Date("2026-11-15T15:00:00Z"), NY)).toBe("2026-11-23");
  });
  it("counts the merchant's own day, not UTC's", () => {
    // 11:30 PM Tuesday Nov 10 in New York is already Nov 11 in UTC
    expect(weekAfterSend(new Date("2026-11-11T04:30:00Z"), NY)).toBe("2026-11-17");
    // 7:00 PM Tuesday Nov 10 in Honolulu is already Wednesday in UTC
    expect(weekAfterSend(new Date("2026-11-11T05:00:00Z"), "Pacific/Honolulu")).toBe("2026-11-17");
  });
  it("never lands on a Saturday or Sunday across a whole year of send days", () => {
    for (let i = 0; i < 400; i += 1) {
      const sent = new Date(Date.UTC(2026, 0, 1, 15) + i * 86_400_000);
      const d = new Date(`${weekAfterSend(sent, NY)}T12:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(d);
    }
  });
  it("is written out as the design shows it", () => {
    expect(expiryWords(weekAfterSend(new Date("2026-11-10T15:00:00Z"), NY))).toBe(
      "Tuesday, November 17",
    );
  });
});
