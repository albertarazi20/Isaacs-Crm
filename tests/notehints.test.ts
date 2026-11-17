import { describe, expect, it } from "vitest";
import { addMonths } from "@/lib/mca/dates";
import { detectHot, hasCallbackIntent, hintLabel, noteHints } from "@/lib/mca/notehints";
import type { StageKey } from "@/lib/mca/stages";

// Calendar facts used below (checked against a real calendar):
//   2026-10-23 is a Friday; Oct 31 2026 is a Saturday; Nov 1 is a Sunday; Nov 15 is a Sunday; Nov 30 is a Monday.
//   2028 is a leap year (Feb 29 2028 is a Tuesday). Jan 1 2027 is a Friday, Jan 2 a Saturday. Apr 20 2030 is a Saturday.
const FRI = "2026-10-23";

type Row = [today: string, note: string, expected: string[], stage?: StageKey];

const dates = (note: string, today: string, stage?: StageKey) =>
  noteHints(note, today, { stage }).suggestions.map((s) => s.dueOn);

function table(title: string, rows: Row[]) {
  describe(title, () => {
    it.each(rows)("%s · %j → %j", (today, note, expected, stage) => {
      expect(dates(note, today, stage)).toEqual(expected);
    });
  });
}

table("weekdays", [
  [FRI, "call Friday", ["2026-10-30"]],
  [FRI, "call him back Friday", ["2026-10-30"]],
  ["2026-10-22", "Friday", ["2026-10-23"]], // Thursday → tomorrow
  [FRI, "monday", ["2026-10-26"]],
  ["2026-10-24", "call monday", ["2026-10-26"]], // Saturday
  ["2026-10-26", "monday", ["2026-11-02"]], // never today: a Monday note on Monday means next Monday
  [FRI, "next Tuesday", ["2026-10-27"]],
  ["2026-10-26", "next Tuesday", ["2026-11-03"]], // "next" = the following calendar week
  ["2026-10-25", "next Friday", ["2026-10-30"]], // Sunday
  ["2026-10-26", "this Friday", ["2026-10-30"]],
  [FRI, "on Wed", ["2026-10-28"]],
  [FRI, "thurs afternoon", ["2026-10-29"]],
  [FRI, "after Friday", ["2026-11-02"]], // the Saturday after rolls to Monday
  [FRI, "call Saturday", ["2026-10-26"]], // Saturday is not a business day
  [FRI, "Sunday", ["2026-10-26"]],
  [FRI, "after the weekend", ["2026-10-26"]],
  [FRI, "early next week", ["2026-10-26"]],
  [FRI, "next week", ["2026-10-26"]],
  [FRI, "end of next week", ["2026-10-30"]],
  [FRI, "end of the week", ["2026-10-30"]],
  ["2026-10-21", "by Friday", ["2026-10-23"]],
]);

table("tomorrow, mornings and today", [
  [FRI, "tomorrow", ["2026-10-26"]], // Saturday rolls to Monday
  ["2026-10-21", "call tomorrow", ["2026-10-22"]],
  ["2026-10-30", "tomorrow", ["2026-11-02"]], // Saturday
  ["2026-10-31", "tomorrow", ["2026-11-02"]], // Sunday
  [FRI, "in the morning", ["2026-10-26"]],
  ["2026-10-26", "call him in the morning", ["2026-10-27"]],
  ["2026-10-26", "first thing tomorrow", ["2026-10-27"]],
  [FRI, "call today", [FRI]],
  [FRI, "try him again tonight", [FRI]],
  ["2026-10-24", "call today", ["2026-10-24"]], // today is never moved, even on a Saturday
  [FRI, "no answer today", []],
  [FRI, "in a meeting, call back in an hour", [FRI]],
  [FRI, "call me in 10 min", [FRI]],
  [FRI, "spoke 10 min, wants 50k", []],
  [FRI, "spoke today, wants 50k", []],
]);

table("relative spans", [
  [FRI, "in 2 weeks", ["2026-11-06"]],
  [FRI, "call in a couple weeks", ["2026-11-06"]],
  [FRI, "in two weeks", ["2026-11-06"]],
  ["2026-10-21", "in 2 weeks", ["2026-11-04"]],
  ["2026-10-31", "in 2 weeks", ["2026-11-16"]], // Nov 14 is a Saturday
  [FRI, "in 5 days", ["2026-10-28"]],
  [FRI, "in 1 day", ["2026-10-26"]], // Saturday
  ["2026-10-21", "in 3 business days", ["2026-10-26"]],
  [FRI, "in a few days", ["2026-10-26"]], // Oct 26 is a Monday
  [FRI, "in a week", ["2026-10-30"]],
  [FRI, "in 3 wks", ["2026-11-13"]],
  [FRI, "in 6 months", ["2027-04-23"]],
  [FRI, "call back 3 months", ["2027-01-25"]], // Jan 23 2027 is a Saturday
  [FRI, "call again in 2-3 weeks", ["2026-11-06"]],
  [FRI, "after 2 weeks", ["2026-11-06"]],
  ["2026-01-31", "in 1 month", ["2026-03-02"]], // Feb 28 2026 is a Saturday
  ["2028-01-31", "in 1 month", ["2028-02-29"]], // leap year: Feb 29 is a Tuesday
  ["2026-12-31", "in 1 month", ["2027-02-01"]], // Jan 31 2027 is a Sunday
  ["2026-12-31", "in 2 weeks", ["2027-01-14"]],
  ["2028-02-29", "in a year", ["2029-02-28"]], // leap day + 12 months = Feb 28
  [FRI, "in 3 years", ["2029-10-23"]], // exactly 36 months is allowed
  [FRI, "in 40 months", []], // beyond 36 months
  [FRI, "in 4 years", []],
  [FRI, "6 months of statements", []],
  [FRI, "been in business 3 years", []],
  [FRI, "has 2 weeks of cash left", []],
]);

table("month ends and periods", [
  [FRI, "end of month", ["2026-10-30"]], // Oct 31 is a Saturday: the last business day
  ["2026-10-30", "end of month", ["2026-10-30"]], // today
  ["2026-10-31", "end of month", ["2026-11-30"]], // Saturday, and the month's last business day has passed
  ["2026-12-31", "end of month", ["2026-12-31"]],
  ["2026-11-02", "end of the month", ["2026-11-30"]],
  ["2028-02-10", "eom", ["2028-02-29"]], // leap February
  ["2027-02-10", "end of month", ["2027-02-26"]], // Feb 28 2027 is a Sunday
  [FRI, "next month", ["2026-11-02"]], // Nov 1 is a Sunday
  ["2026-11-23", "next month", ["2026-12-01"]],
  [FRI, "early next month", ["2026-11-02"]],
  [FRI, "end of next month", ["2026-11-30"]],
  [FRI, "mid-month", ["2026-11-16"]], // Nov 15 is a Sunday
  ["2026-10-10", "mid month", ["2026-10-15"]],
  [FRI, "next quarter", ["2027-01-04"]], // never New Year's Day
  ["2026-12-31", "next quarter", ["2027-01-04"]],
  ["2027-01-04", "next quarter", ["2027-04-01"]],
  [FRI, "end of the quarter", ["2026-12-31"]],
  ["2026-12-31", "end of quarter", ["2026-12-31"]],
  [FRI, "end of year", ["2026-12-31"]],
  ["2026-12-31", "eoy", ["2026-12-31"]],
  [FRI, "next year", ["2027-01-05"]],
  [FRI, "first of the month", ["2026-11-02"]],
]);

table("seasons", [
  [FRI, "after tax season", ["2027-04-20"]],
  ["2026-01-10", "after tax season", ["2026-04-20"]],
  ["2026-04-20", "after tax season", ["2026-04-20"]], // still today
  ["2026-04-21", "after tax season", ["2027-04-20"]],
  ["2030-04-10", "after tax season", ["2030-04-22"]], // Apr 20 2030 is a Saturday
  [FRI, "call me after taxes", ["2027-04-20"]],
  [FRI, "after the holidays", ["2027-01-05"]],
  ["2026-12-29", "after the holidays", ["2027-01-05"]],
  ["2027-01-02", "after the holidays", ["2027-01-05"]],
  ["2027-01-06", "after the holidays", ["2028-01-05"]],
  [FRI, "after new year", ["2027-01-05"]],
  [FRI, "slammed during tax season", []], // not a follow-up date by itself
]);

table("days of the month", [
  ["2026-10-20", "call after the 15th", ["2026-11-16"]], // the 20th: this month's 15th has gone by
  ["2026-10-10", "call after the 15th", ["2026-10-16"]],
  ["2026-10-15", "call after the 15th", ["2026-10-16"]],
  [FRI, "on the 31st", ["2026-11-02"]], // Oct 31 is a Saturday
  ["2026-11-05", "call on the 31st", ["2026-11-30"]], // November has no 31st: the 30th
  [FRI, "by the 28th", ["2026-10-28"]],
  [FRI, "around the 1st", ["2026-11-02"]], // Nov 1 is a Sunday
  [FRI, "the 15th of next month", ["2026-11-16"]],
  [FRI, "wants 1st position", []],
  [FRI, "the 2nd position is Libertas", []],
  [FRI, "his 3rd advance", []],
  [FRI, "ping him 15th", []], // no "the"/"on"/"by": not clearly a date
]);

table("explicit dates", [
  [FRI, "10/30", ["2026-10-30"]], // the cue is missing but the day is over 12
  [FRI, "call 10/30", ["2026-10-30"]],
  [FRI, "Oct 30", ["2026-10-30"]],
  [FRI, "October 30th", ["2026-10-30"]],
  [FRI, "Oct. 30, 2026", ["2026-10-30"]],
  [FRI, "30 Oct", []], // no ordinal and no "of": too loose
  [FRI, "30th of October", ["2026-10-30"]],
  [FRI, "2026-11-02", ["2026-11-02"]],
  [FRI, "10/30/26", ["2026-10-30"]],
  [FRI, "10/30/2026", ["2026-10-30"]],
  [FRI, "call 10/31", ["2026-11-02"]], // Saturday → Monday
  [FRI, "Nov 1", ["2026-11-02"]], // Sunday → Monday
  ["2026-12-20", "call 1/5", ["2027-01-05"]], // already gone by this year: next year
  ["2026-12-20", "call 1/5/27", ["2027-01-05"]],
  [FRI, "call 3/15/2027", ["2027-03-15"]],
  [FRI, "call 11/5 or Nov 6", ["2026-11-05", "2026-11-06"]],
  [FRI, "call 10/28 or Oct 30 or 11/2 or 11/3", ["2026-10-28", "2026-10-30", "2026-11-02"]], // at most three
  [FRI, "Feb 29", ["2028-02-29"]], // the next leap day
  ["2027-03-01", "call Feb 29", ["2028-02-29"]],
  ["2028-02-29", "call Feb 29", ["2028-02-29"]],
  ["2028-02-28", "call tomorrow", ["2028-02-29"]],
  [FRI, "Feb 30", []],
  [FRI, "13/45", []],
  [FRI, "call 2020-01-01", []], // in the past
  [FRI, "call 2031-01-01", []], // more than 36 months out
  [FRI, "call 11/5/2026", ["2026-11-05"]],
  [FRI, "May 5", ["2027-05-05"]],
  [FRI, "he may call back May 5", ["2027-05-05"]],
]);

table("months", [
  [FRI, "call in March", ["2027-03-01"]],
  [FRI, "call in early March 2027", ["2027-03-01"]],
  [FRI, "call after March", ["2027-04-01"]],
  [FRI, "late March", ["2027-03-25"]],
  [FRI, "call late March", ["2027-03-25"]],
  [FRI, "call end of March", ["2027-03-31"]],
  [FRI, "mid May", ["2027-05-17"]], // May 15 2027 is a Saturday
  [FRI, "in October", []], // this month and already past its start: not a plan
  [FRI, "after October", ["2026-11-02"]],
  [FRI, "until January", ["2027-01-04"]], // January starts on the 2nd (a Saturday), so Monday the 4th
]);

table("things that are not dates", [
  [FRI, "Has 2 trucks, wants 50k. 1st position, 3 months of statements", []],
  [FRI, "owns 1/2 of the business", []],
  [FRI, "3/4 of revenue is card sales", []],
  [FRI, "open 24/7", []],
  [FRI, "50/50 partners", []],
  [FRI, "open Mon-Fri 9-5", []],
  [FRI, "Monday through Friday only", []],
  [FRI, "call 305-555-0101", []],
  [FRI, "(305) 555-0101", []],
  [FRI, "revenue $10/30 days", []],
  [FRI, "great guy, two trucks, slow season", []],
  [FRI, "he may call me", []],
  [FRI, "", []],
  [FRI, "   \n  ", []],
]);

table("the past is not a plan", [
  [FRI, "called him Friday, no answer", []],
  [FRI, "spoke to him last Friday", []],
  [FRI, "emailed Monday", []],
  [FRI, "applied 10/15", []],
  [FRI, "funded 9/20", []],
  [FRI, "talked on Tuesday about the offer", []],
  [FRI, "called Monday, he'll call back next Tuesday", ["2026-10-27"]],
  [FRI, "called him 2 weeks ago", []],
  [FRI, "last 10/2 was a mess", []],
  [FRI, "since Oct 1 he has been quiet", []],
  [FRI, "Called Friday. Call back Tuesday.", ["2026-10-27"]],
]);

table("a call-back with no date gets the stage's pace — and only that", [
  [FRI, "call back after he talks to his dispatcher", ["2026-10-27"], "interested"], // 2 business days
  [FRI, "call back after he talks to his dispatcher", ["2026-10-26"], "offers_in"], // 1 business day
  [FRI, "call back after he talks to his dispatcher", ["2026-10-26"], "contract_out"],
  [FRI, "call back after he talks to his dispatcher", ["2026-10-27"]], // no stage: 2 business days
  [FRI, "follow up", ["2026-10-27"], "name_in"], // retired stages are paced as the stage they fold into
  [FRI, "circle back", ["2026-10-27"], "application_sent"], // 2 business days
  [FRI, "touch base", ["2026-10-27"], "interested"],
  [FRI, "check back", ["2026-10-27"], "interested"],
  [FRI, "he'll get back to us", [], "interested"], // he calls us: nothing to schedule
  [FRI, "call him back", ["2027-07-23"], "dead"], // 9 months
  [FRI, "call back", ["2027-07-23"], "declined"], // folds into Trash: 9 months
  [FRI, "great guy, has 2 trucks", [], "interested"],
  [FRI, "wants 40k for equipment", [], "interested"],
  [FRI, "call him back Tuesday", ["2026-10-27"], "dead"], // a date in the note beats the pace
]);

describe("labels and reasons", () => {
  it("labels a chip with the weekday and date, and shows the year only when it differs", () => {
    const [a] = noteHints("call Friday", FRI).suggestions;
    expect(a?.label).toBe("Friday Oct 30");
    const [b] = noteHints("after tax season", FRI).suggestions;
    expect(b?.label).toBe("Tuesday Apr 20, 2027");
    expect(hintLabel(FRI, FRI)).toBe("Today");
    expect(hintLabel("2026-10-26", FRI)).toBe("Monday Oct 26");
  });
  it("quotes the note in the reason, and says when a weekend was moved", () => {
    const [a] = noteHints("let's talk on Friday", FRI).suggestions;
    expect(a?.reason).toBe("You wrote “on Friday”");
    const [b] = noteHints("call 10/31", FRI).suggestions;
    expect(b?.reason).toContain("“10/31”");
    expect(b?.reason).toContain("Oct 31 is a Saturday");
  });
  it("says it is the stage's pace when the note has no date", () => {
    const [a] = noteHints("call back after he talks to his dispatcher", FRI, {
      stage: "interested",
    }).suggestions;
    expect(a?.reason).toBe(
      "No date I could read in the note, so Interested usually gets a call in 2 business days",
    );
    const [b] = noteHints("call back", FRI).suggestions;
    expect(b?.reason).toContain("2 business days");
  });
  it("returns plain data and nothing else", () => {
    const [a] = noteHints("call Friday", FRI).suggestions;
    expect(Object.keys(a ?? {}).sort()).toEqual(["dueOn", "label", "reason"]);
  });
});

describe("hot", () => {
  it.each([
    "wants it ASAP",
    "he needs it asap!",
    "A.S.A.P.",
    "urgent",
    "very urgently",
    "hot lead",
    "he's hot",
    "wants it today",
    "needs the money by tomorrow",
    "needs funding now",
    "wants cash today",
    "needs it right away",
    "in a rush",
    "time sensitive",
  ])("%j is hot", (note) => {
    expect(noteHints(note, FRI).hot).toBe(true);
  });
  it.each([
    "not urgent",
    "no rush",
    "isn't in a rush",
    "not a hot lead",
    "wasn't ASAP",
    "owns a hot dog stand",
    "Hot Dog Heaven",
    "hotel supplier",
    "no answer, urgent",
    "great guy",
    "wants 40k",
    "he'll want it next month",
    "",
  ])("%j is not hot (unless the clause says so)", (note) => {
    expect(detectHot(note), note).toBe(note === "no answer, urgent");
  });
  it("a hot note with no date offers today, and a dated hot note keeps its date", () => {
    expect(noteHints("wants it ASAP", FRI)).toMatchObject({
      hot: true,
      suggestions: [{ dueOn: FRI, label: "Today" }],
    });
    expect(dates("urgent, call him on Monday", FRI)).toEqual(["2026-10-26"]);
    expect(noteHints("urgent, call him on Monday", FRI).hot).toBe(true);
    expect(noteHints("not urgent, call Monday", FRI)).toMatchObject({ hot: false });
  });
  it("detects the hot words anywhere in the note", () => {
    expect(
      noteHints("Spoke 10 min. Two trucks down, needs cash for repairs. Wants it ASAP.", FRI).hot,
    ).toBe(true);
  });
});

describe("callback intent", () => {
  it.each([
    "call back",
    "call him back",
    "call her back Tuesday",
    "callback",
    "follow up",
    "follow-up in a week",
    "circle back",
    "check back",
    "get back to him",
    "reach out again",
    "try again",
    "try him again",
    "revisit",
    "remind him",
    "after he talks to his dispatcher",
    "once she signs the lease",
    "when he's back",
    "call him again later",
  ])("%j", (note) => {
    expect(hasCallbackIntent(note)).toBe(true);
  });
  it.each(["has 2 trucks", "wants 40k", "no answer", "left message", "great guy", "called him"])(
    "%j is not one",
    (note) => {
      expect(hasCallbackIntent(note)).toBe(false);
    },
  );
});

describe("several dates in one note", () => {
  it("lists them in the order written, once each", () => {
    expect(dates("call Friday, or maybe next Tuesday, or Friday again", FRI)).toEqual([
      "2026-10-30",
      "2026-10-27",
    ]);
  });
  it("does not read 'next Tuesday' twice (as 'next Tuesday' and as 'Tuesday')", () => {
    expect(dates("call back next Tuesday", FRI)).toEqual(["2026-10-27"]);
    expect(dates("after the 15th", "2026-10-20")).toEqual(["2026-11-16"]);
  });
  it("copes with a long note and finds the date in the middle of it", () => {
    const filler = "Spoke with the owner about equipment, wants more cash, slow season. ".repeat(
      60,
    );
    expect(dates(`${filler} Call him Friday. ${filler}`, FRI)).toEqual(["2026-10-30"]);
  });
  it("a real note, end to end", () => {
    const note =
      "Spoke 10 min. Two trucks down, needs cash for repairs. Call back after he talks to his dispatcher — he said Thursday or Friday. Has 1st position with Libertas, balance about 21k.";
    expect(dates(note, FRI, "spoke_with_owner")).toEqual(["2026-10-29", "2026-10-30"]);
  });
});

describe("it never invents a date", () => {
  const NO_DATE = [
    "Interested in 60k for a second location",
    "Left voicemail",
    "No answer",
    "Wants to compare offers with another broker",
    "2 other advances, 1st position Libertas 40k",
    "Slammed with daily remittances",
    "Revenue about 80k a month, 6 years in business",
    "Owner is Tony, wife handles the books",
    "Sent the application",
    "Said he'll think about it",
  ];
  it.each(NO_DATE)("%j → nothing", (note) => {
    expect(noteHints(note, FRI)).toEqual({ suggestions: [], hot: false });
  });
});

describe("invariants over a year of todays", () => {
  const PHRASES = [
    "call Friday",
    "next Tuesday",
    "after the 15th",
    "in 2 weeks",
    "end of month",
    "after tax season",
    "in the morning",
    "monday",
    "after the holidays",
    "next quarter",
    "10/30",
    "Oct 30",
    "2026-11-02",
    "on the 31st",
    "in 1 month",
    "in 3 business days",
    "end of year",
    "mid-month",
    "call back after he talks to his dispatcher",
    "wants it ASAP",
    "tomorrow",
    "Feb 29",
    "in a couple weeks",
    "call in March",
  ];
  const isWeekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

  function* days(start: string, n: number) {
    const d = new Date(`${start}T00:00:00Z`);
    for (let i = 0; i < n; i += 1) {
      yield d.toISOString().slice(0, 10);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  it("is always today or later, at most 36 months out, on a business day (today excepted), at most three, and repeatable", () => {
    let checked = 0;
    for (const today of days("2027-12-20", 400)) {
      for (const note of PHRASES) {
        const a = noteHints(note, today, { stage: "interested" });
        const b = noteHints(note, today, { stage: "interested" });
        expect(b).toEqual(a);
        expect(a.suggestions.length).toBeLessThanOrEqual(3);
        const seen = new Set<string>();
        for (const s of a.suggestions) {
          expect(s.dueOn >= today, `${note} @ ${today} → ${s.dueOn} is in the past`).toBe(true);
          expect(s.dueOn <= addMonths(today, 36), `${note} @ ${today} → ${s.dueOn}`).toBe(true);
          if (s.dueOn !== today) {
            expect(isWeekend(s.dueOn), `${note} @ ${today} → ${s.dueOn} is a weekend`).toBe(false);
          }
          expect(seen.has(s.dueOn)).toBe(false);
          seen.add(s.dueOn);
          expect(s.label.length).toBeGreaterThan(0);
          expect(s.reason.length).toBeGreaterThan(0);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("gives nothing for date-free notes on any day", () => {
    for (const today of days("2028-02-20", 30)) {
      expect(noteHints("great guy, has 2 trucks, wants 50k", today).suggestions).toEqual([]);
    }
  });
});
