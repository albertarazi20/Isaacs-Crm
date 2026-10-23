import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, relativeDay, timeAgo, toLocalInput } from "@/lib/format";
import { STAGE_KEYS } from "@/lib/mca/stages";
import { emailBody, emailSubject, textTemplate } from "@/lib/mca/templates";

const TODAY = "2026-10-23";

describe("relativeDay", () => {
  it.each([
    ["2026-10-23", "Today"],
    ["2026-10-24", "Tomorrow"],
    ["2026-10-22", "1 day overdue"],
    ["2026-10-13", "10 days overdue"],
    ["2026-10-30", "in 7 days"],
    ["2026-11-20", "in 4 weeks"],
    ["2027-01-23", "in 3 months"],
    ["2028-10-23", "in 2 years"],
    ["2029-10-23", "in 3 years"],
  ])("%s → %s", (due, text) => {
    expect(relativeDay(due, TODAY)).toBe(text);
  });
});

describe("dates and times", () => {
  it("shows the year only when it differs", () => {
    expect(formatDate("2026-12-01", TODAY)).toBe("Dec 1");
    expect(formatDate("2027-01-05", TODAY)).toBe("Jan 5, 2027");
  });
  it("renders timestamps in the user's timezone", () => {
    expect(formatDateTime("2026-10-27T18:30:00Z", "America/New_York")).toBe("Oct 27, 2:30 PM");
    expect(toLocalInput("2026-10-27T18:30:00Z", "America/New_York")).toBe("2026-10-27T14:30");
  });
  it("describes how long ago", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(timeAgo("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-23T11:15:00Z", now)).toBe("45 min ago");
    expect(timeAgo("2026-10-23T09:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-10-20T12:00:00Z", now)).toBe("3 days ago");
    expect(timeAgo("2026-05-23T12:00:00Z", now)).toBe("5 months ago");
  });
});

describe("message templates", () => {
  const base = { contactName: "Mike Ross", businessName: "Mike's Pizza", senderName: "Isaac" };
  it("covers every stage with something sendable", () => {
    for (const stage of STAGE_KEYS) {
      const text = textTemplate({ ...base, stage });
      expect(text, stage).toContain("Mike");
      expect(text, stage).toContain("Isaac");
      expect(emailSubject({ ...base, stage }), stage).not.toBe("");
      expect(emailBody({ ...base, stage }), stage).toMatch(/Thanks,\nIsaac$/);
    }
  });
  it("sounds right for the stage, and never uses loan language", () => {
    expect(textTemplate({ ...base, stage: "paid_in_full" })).toContain("renewal");
    expect(textTemplate({ ...base, stage: "stips" })).toContain("documents");
    for (const stage of STAGE_KEYS) {
      expect(textTemplate({ ...base, stage }).toLowerCase(), stage).not.toMatch(
        /\bloan\b|interest rate|borrower/,
      );
    }
  });
  it("copes with a missing name", () => {
    expect(textTemplate({ ...base, contactName: "", stage: "interested" })).toMatch(
      /^Hey, it's Isaac/,
    );
  });
});
