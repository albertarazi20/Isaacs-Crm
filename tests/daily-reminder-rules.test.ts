/**
 * The pure rules behind a bucket's daily reminder (rules.ts): the instant a wall-clock time is in a zone, the next
 * reminder slot for a merchant (every day but Saturday, in the merchant's own zone), the day after a date that skips
 * Saturday, and the outbox source that marks a daily reminder.
 */
import { describe, expect, it } from "vitest";
import {
  isDailySource,
  localInstant,
  nextDailySend,
  nextNonSaturday,
  partsIn,
} from "@/lib/send/rules";

const iso = (d: Date) => d.toISOString();
const TEN = 600;

describe("localInstant", () => {
  it.each([
    ["America/New_York", "2026-11-23", "2026-11-23T15:00:00.000Z"], // EST, UTC-5
    ["America/Chicago", "2026-11-23", "2026-11-23T16:00:00.000Z"], // CST, UTC-6
    ["America/Los_Angeles", "2026-11-23", "2026-11-23T18:00:00.000Z"], // PST, UTC-8
    ["Pacific/Honolulu", "2026-11-23", "2026-11-23T20:00:00.000Z"], // HST, UTC-10, no DST
    ["Asia/Kolkata", "2026-11-23", "2026-11-23T04:30:00.000Z"], // IST, UTC+5:30
    ["America/New_York", "2026-07-15", "2026-07-15T14:00:00.000Z"], // EDT, UTC-4
    ["America/Los_Angeles", "2026-07-15", "2026-07-15T17:00:00.000Z"], // PDT, UTC-7
    ["America/Chicago", "2026-07-15", "2026-07-15T15:00:00.000Z"], // CDT, UTC-5
    ["Pacific/Honolulu", "2026-07-15", "2026-07-15T20:00:00.000Z"], // unchanged in summer
    ["Asia/Kolkata", "2026-07-15", "2026-07-15T04:30:00.000Z"], // unchanged in summer
    ["UTC", "2026-07-15", "2026-07-15T10:00:00.000Z"],
  ])("10:00 in %s on %s is %s", (tz, date, utc) => {
    expect(iso(localInstant(tz, date, TEN))).toBe(utc);
  });

  it("keeps 10:00 local on the day the clocks go forward, and the day around it (US, 8 March 2026)", () => {
    expect(iso(localInstant("America/New_York", "2026-03-07", TEN))).toBe(
      "2026-03-07T15:00:00.000Z",
    );
    expect(iso(localInstant("America/New_York", "2026-03-08", TEN))).toBe(
      "2026-03-08T14:00:00.000Z",
    );
    expect(iso(localInstant("America/New_York", "2026-03-09", TEN))).toBe(
      "2026-03-09T14:00:00.000Z",
    );
    expect(iso(localInstant("America/Los_Angeles", "2026-03-08", TEN))).toBe(
      "2026-03-08T17:00:00.000Z",
    );
    expect(iso(localInstant("America/Chicago", "2026-03-08", TEN))).toBe(
      "2026-03-08T15:00:00.000Z",
    );
  });

  it("keeps 10:00 local on the day the clocks go back (US, 1 November 2026)", () => {
    expect(iso(localInstant("America/New_York", "2026-10-31", TEN))).toBe(
      "2026-10-31T14:00:00.000Z",
    );
    expect(iso(localInstant("America/New_York", "2026-11-01", TEN))).toBe(
      "2026-11-01T15:00:00.000Z",
    );
    expect(iso(localInstant("America/Chicago", "2026-10-31", TEN))).toBe(
      "2026-10-31T15:00:00.000Z",
    );
    expect(iso(localInstant("America/Chicago", "2026-11-01", TEN))).toBe(
      "2026-11-01T16:00:00.000Z",
    );
    expect(iso(localInstant("America/Los_Angeles", "2026-11-01", TEN))).toBe(
      "2026-11-01T18:00:00.000Z",
    );
  });

  it("handles the earliest and latest reminder times the shop can set (06:00 and 20:00) on a clock-change day", () => {
    expect(iso(localInstant("America/New_York", "2026-03-08", 360))).toBe(
      "2026-03-08T10:00:00.000Z",
    ); // 06:00 EDT
    expect(iso(localInstant("America/New_York", "2026-03-08", 1200))).toBe(
      "2026-03-09T00:00:00.000Z",
    ); // 20:00 EDT
    expect(iso(localInstant("America/New_York", "2026-11-01", 360))).toBe(
      "2026-11-01T11:00:00.000Z",
    ); // 06:00 EST
    expect(iso(localInstant("America/New_York", "2026-11-01", 1200))).toBe(
      "2026-11-02T01:00:00.000Z",
    ); // 20:00 EST
  });

  it("lands on a half-hour time and on a half-hour zone", () => {
    expect(iso(localInstant("America/New_York", "2026-11-23", 630))).toBe(
      "2026-11-23T15:30:00.000Z",
    );
    expect(iso(localInstant("Asia/Kolkata", "2026-11-23", 645))).toBe("2026-11-23T05:15:00.000Z"); // 10:45 IST
  });

  it("round-trips: the instant read back in the zone is that day at that time, for every day of 2026", () => {
    const zones = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Pacific/Honolulu",
      "Asia/Kolkata",
    ];
    for (const tz of zones) {
      for (const minute of [360, 600, 630, 1200]) {
        for (let d = 0; d < 365; d += 1) {
          const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
          const p = partsIn(tz, localInstant(tz, date, minute));
          expect({ tz, date: p.date, hour: p.hour, minute: p.minute }).toEqual({
            tz,
            date,
            hour: Math.floor(minute / 60),
            minute: minute % 60,
          });
        }
      }
    }
  });
});

describe("nextDailySend", () => {
  const NY = "America/New_York";

  it("is today while the time is still ahead, and tomorrow once it has passed", () => {
    // Monday 23 Nov 2026
    expect(nextDailySend(new Date("2026-11-23T13:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-23",
      at: new Date("2026-11-23T15:00:00Z"),
    }); // 08:00 EST
    expect(nextDailySend(new Date("2026-11-23T14:59:59Z"), NY, TEN).date).toBe("2026-11-23"); // 09:59:59
    // at the exact minute it is no longer ahead
    expect(nextDailySend(new Date("2026-11-23T15:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-24",
      at: new Date("2026-11-24T15:00:00Z"),
    });
    expect(nextDailySend(new Date("2026-11-23T17:00:00Z"), NY, TEN).date).toBe("2026-11-24"); // 12:00 EST
  });

  it("is the local midnight rollover, not the UTC one", () => {
    // 03:00 UTC on Tuesday is still Monday 22:00 in New York: after 10:00, so Tuesday
    expect(nextDailySend(new Date("2026-11-24T03:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-24",
      at: new Date("2026-11-24T15:00:00Z"),
    });
    // 03:00 UTC on Monday is Sunday 22:00 in New York: Monday's slot
    expect(nextDailySend(new Date("2026-11-23T03:00:00Z"), NY, TEN).date).toBe("2026-11-23");
  });

  it("skips Saturday: Friday after the time goes to Sunday, not Monday", () => {
    // Friday 20 Nov 2026, 12:00 EST: Friday's 10:00 has passed, Saturday is skipped
    expect(nextDailySend(new Date("2026-11-20T17:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-22",
      at: new Date("2026-11-22T15:00:00Z"),
    });
  });

  it("keeps Friday while the time is still ahead", () => {
    expect(nextDailySend(new Date("2026-11-20T13:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-20",
      at: new Date("2026-11-20T15:00:00Z"),
    });
  });

  it("never lands on a Saturday, whatever the hour of that Saturday", () => {
    // 05:00, 12:00 and 23:30 local on Saturday 21 Nov 2026 (EST = UTC-5)
    for (const utc of ["2026-11-21T10:00:00Z", "2026-11-21T17:00:00Z", "2026-11-22T04:30:00Z"]) {
      expect(nextDailySend(new Date(utc), NY, TEN)).toEqual({
        date: "2026-11-22",
        at: new Date("2026-11-22T15:00:00Z"),
      });
    }
  });

  it("sends on Sunday, and the Sunday after the time goes to Monday", () => {
    expect(nextDailySend(new Date("2026-11-22T13:00:00Z"), NY, TEN).date).toBe("2026-11-22");
    expect(nextDailySend(new Date("2026-11-22T17:00:00Z"), NY, TEN).date).toBe("2026-11-23");
  });

  it("lets the merchant's zone decide the weekday: the same instant is Friday morning in Honolulu and Friday noon in New York", () => {
    const now = new Date("2026-11-20T16:30:00Z");
    // Honolulu 06:30 Friday: today, 10:00 HST
    expect(nextDailySend(now, "Pacific/Honolulu", TEN)).toEqual({
      date: "2026-11-20",
      at: new Date("2026-11-20T20:00:00Z"),
    });
    // New York 11:30 Friday: passed, Saturday skipped, Sunday
    expect(nextDailySend(now, NY, TEN)).toEqual({
      date: "2026-11-22",
      at: new Date("2026-11-22T15:00:00Z"),
    });
  });

  it("uses the merchant's local Saturday even when it is still Friday in UTC", () => {
    // 20:00 UTC Friday is already Saturday 01:30 in Kolkata: Sunday 10:00 IST
    expect(nextDailySend(new Date("2026-11-20T20:00:00Z"), "Asia/Kolkata", TEN)).toEqual({
      date: "2026-11-22",
      at: new Date("2026-11-22T04:30:00Z"),
    });
    // and a Friday-morning Kolkata merchant, while it is still Thursday evening in UTC, gets Friday
    expect(nextDailySend(new Date("2026-11-19T20:00:00Z"), "Asia/Kolkata", TEN)).toEqual({
      date: "2026-11-20",
      at: new Date("2026-11-20T04:30:00Z"),
    });
  });

  it("rolls over a month end", () => {
    // Monday 30 Nov 2026, 12:00 EST
    expect(nextDailySend(new Date("2026-11-30T17:00:00Z"), NY, TEN).date).toBe("2026-12-01");
  });

  it("rolls over a year end, then skips the Saturday after the Friday 1 January 2027", () => {
    // Thursday 31 Dec 2026, 11:00 EST: Friday 1 Jan 2027
    expect(nextDailySend(new Date("2026-12-31T16:00:00Z"), NY, TEN)).toEqual({
      date: "2027-01-01",
      at: new Date("2027-01-01T15:00:00Z"),
    });
    // Friday 1 Jan 2027, 11:00 EST: Sunday 3 Jan
    expect(nextDailySend(new Date("2027-01-01T16:00:00Z"), NY, TEN).date).toBe("2027-01-03");
  });

  it("rolls over a leap day", () => {
    // Monday 28 Feb 2028, 12:00 EST
    expect(nextDailySend(new Date("2028-02-28T17:00:00Z"), NY, TEN).date).toBe("2028-02-29");
  });

  it("follows the clock change: Saturday evening before the spring change lands on Sunday 10:00 EDT", () => {
    expect(nextDailySend(new Date("2026-03-07T16:00:00Z"), NY, TEN)).toEqual({
      date: "2026-03-08",
      at: new Date("2026-03-08T14:00:00Z"),
    });
    // after the autumn change, Sunday 1 Nov is 10:00 EST
    expect(nextDailySend(new Date("2026-10-31T16:00:00Z"), NY, TEN)).toEqual({
      date: "2026-11-01",
      at: new Date("2026-11-01T15:00:00Z"),
    });
  });

  it("uses the shop's reminder time: 06:00 has passed at 08:00, 20:00 has not", () => {
    const now = new Date("2026-11-23T13:00:00Z"); // 08:00 EST Monday
    expect(nextDailySend(now, NY, 360)).toEqual({
      date: "2026-11-24",
      at: new Date("2026-11-24T11:00:00Z"),
    });
    expect(nextDailySend(now, NY, 1200)).toEqual({
      date: "2026-11-23",
      at: new Date("2026-11-24T01:00:00Z"),
    });
  });

  it("gives two merchants in different zones the same local time on the same day", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    expect(nextDailySend(now, NY, TEN).at).toEqual(new Date("2026-11-23T15:00:00Z"));
    expect(nextDailySend(now, "America/Los_Angeles", TEN).at).toEqual(
      new Date("2026-11-23T18:00:00Z"),
    );
    expect(nextDailySend(now, "America/Chicago", TEN).at).toEqual(new Date("2026-11-23T16:00:00Z"));
  });
});

describe("nextNonSaturday", () => {
  it.each([
    ["2026-11-23", "2026-11-24"], // Monday to Tuesday
    ["2026-11-19", "2026-11-20"], // Thursday to Friday
    ["2026-11-20", "2026-11-22"], // Friday to Sunday: only Saturday is skipped
    ["2026-11-21", "2026-11-22"], // a Saturday input still gives Sunday
    ["2026-11-22", "2026-11-23"], // Sunday to Monday
    ["2026-11-30", "2026-12-01"], // month end
    ["2026-12-31", "2027-01-01"], // year end (Thursday to Friday)
    ["2027-01-01", "2027-01-03"], // Friday 1 Jan to Sunday 3 Jan
    ["2028-02-28", "2028-02-29"], // leap day
    ["2028-02-29", "2028-03-01"],
  ])("%s -> %s", (from, to) => {
    expect(nextNonSaturday(from)).toBe(to);
  });

  it("never returns a Saturday, for any day over four years", () => {
    for (let d = 0; d < 1461; d += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      const next = nextNonSaturday(date);
      expect(new Date(`${next}T00:00:00Z`).getUTCDay()).not.toBe(6);
      expect(next > date).toBe(true);
    }
  });
});

describe("isDailySource", () => {
  const id = "0b9c2f6e-3d1a-4b7e-8c55-1a2b3c4d5e6f";
  it("accepts bucket:<uuid>:daily:<YYYY-MM-DD>", () => {
    expect(isDailySource(`bucket:${id}:daily:2026-11-23`)).toBe(true);
  });
  it.each([
    ["a sequence step", `bucket:${id}:step:1`],
    ["a blast", `blast:${id}`],
    ["a short id", "bucket:abc:daily:2026-11-23"],
    [
      "an upper-case id (ids are stored in lower case)",
      `bucket:${id.toUpperCase()}:daily:2026-11-23`,
    ],
    ["a date without zero padding", `bucket:${id}:daily:2026-1-3`],
    ["a missing date", `bucket:${id}:daily:`],
    ["text after the date", `bucket:${id}:daily:2026-11-23:dup:x`],
    ["text before it", `x-bucket:${id}:daily:2026-11-23`],
    ["a trailing newline", `bucket:${id}:daily:2026-11-23\n`],
    ["an intake source", "intake-1"],
    ["empty", ""],
  ])("rejects %s", (_name, source) => {
    expect(isDailySource(source)).toBe(false);
  });
});

describe("partsIn", () => {
  it("reads the hour, minute, weekday and date in the zone", () => {
    expect(partsIn("America/New_York", new Date("2026-11-21T03:30:00Z"))).toEqual({
      hour: 22,
      minute: 30,
      weekday: 5, // Friday evening in New York
      date: "2026-11-20",
    });
    expect(partsIn("Asia/Kolkata", new Date("2026-11-21T03:30:00Z"))).toEqual({
      hour: 9,
      minute: 0,
      weekday: 6,
      date: "2026-11-21",
    });
  });
});
