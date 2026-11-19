import { describe, expect, it } from "vitest";
import {
  byteSize,
  cadence,
  cadenceSummary,
  emailName,
  emailTitle,
  formatHours,
  formatKb,
  gapToHours,
  hasDesign,
  hourLabel,
  inboxPreview,
  isHtmlFile,
  lastEmailSentence,
  listNames,
  roughHours,
  sinceApproval,
  splitHours,
  windowSummary,
} from "@/components/settings/approvalCadence";

/**
 * Settings → Approval emails: the pure pieces the screen draws with. The timeline's words, the gap editor's
 * hours ⇄ days, the daytime window and the inbox line of a design. No database.
 */

const SEEDED = [
  { step: 1, delay_hours: 0 },
  { step: 2, delay_hours: 24 },
  { step: 3, delay_hours: 48 },
  { step: 4, delay_hours: 72 },
];

describe("email names", () => {
  it("calls the first the approval and numbers the rest as follow-ups", () => {
    expect(emailTitle(1)).toBe("Email 1 — the approval");
    expect(emailTitle(2)).toBe("Follow-up 1");
    expect(emailTitle(6)).toBe("Follow-up 5");
    expect(emailName(1)).toBe("Email 1");
    expect(emailName(3)).toBe("Follow-up 2");
  });
});

describe("hours and days", () => {
  it("shows a whole number of days as days, anything else as hours", () => {
    expect(splitHours(24)).toEqual({ value: 1, unit: "days" });
    expect(splitHours(72)).toEqual({ value: 3, unit: "days" });
    expect(splitHours(36)).toEqual({ value: 36, unit: "hours" });
    expect(splitHours(1)).toEqual({ value: 1, unit: "hours" });
    expect(splitHours(0)).toEqual({ value: 0, unit: "hours" });
  });
  it("words an exact gap", () => {
    expect(formatHours(1)).toBe("1 hour");
    expect(formatHours(24)).toBe("1 day");
    expect(formatHours(36)).toBe("36 hours");
    expect(formatHours(48)).toBe("2 days");
  });
  it("rounds a total to days from three days on, keeps hours below that", () => {
    expect(roughHours(144)).toBe("6 days");
    expect(roughHours(30)).toBe("30 hours");
    expect(roughHours(48)).toBe("2 days");
    expect(roughHours(80)).toBe("3 days");
    expect(roughHours(84)).toBe("4 days");
  });
  it("turns the editor's number and unit into whole hours inside the server's limits", () => {
    expect(gapToHours("2", "days")).toEqual({ hours: 48 });
    expect(gapToHours(" 36 ", "hours")).toEqual({ hours: 36 });
    expect(gapToHours("90", "days")).toEqual({ hours: 2160 });
    expect(gapToHours("2160", "hours")).toEqual({ hours: 2160 });
  });
  it("refuses what the server would refuse, with a reason", () => {
    expect(gapToHours("0", "hours")).toEqual({ error: "At least an hour" });
    expect(gapToHours("0", "days")).toEqual({ error: "At least an hour" });
    expect(gapToHours("91", "days")).toEqual({ error: "At most 90 days" });
    expect(gapToHours("2161", "hours")).toEqual({ error: "At most 90 days" });
    expect(gapToHours("", "hours")).toEqual({ error: "Enter a whole number" });
    expect(gapToHours("1.5", "days")).toEqual({ error: "Enter a whole number" });
    expect(gapToHours("-2", "days")).toEqual({ error: "Enter a whole number" });
    expect(gapToHours("two", "days")).toEqual({ error: "Enter a whole number" });
  });
});

describe("the sequence", () => {
  it("counts each email from the approval; the first goes right away whatever its stored delay", () => {
    expect(cadence(SEEDED)).toEqual([
      { step: 1, gapHours: 0, atHours: 0 },
      { step: 2, gapHours: 24, atHours: 24 },
      { step: 3, gapHours: 48, atHours: 72 },
      { step: 4, gapHours: 72, atHours: 144 },
    ]);
    expect(cadence([{ step: 1, delay_hours: 99 }])).toEqual([{ step: 1, gapHours: 0, atHours: 0 }]);
  });
  it("reads the steps in order even when they come out of order", () => {
    const shuffled = [SEEDED[2]!, SEEDED[0]!, SEEDED[3]!, SEEDED[1]!];
    expect(cadence(shuffled).map((p) => p.step)).toEqual([1, 2, 3, 4]);
    expect(cadence(shuffled).at(-1)?.atHours).toBe(144);
  });
  it("sums it up", () => {
    expect(cadenceSummary(SEEDED)).toBe("4 emails over about 6 days");
    expect(cadenceSummary([{ step: 1, delay_hours: 0 }])).toBe("1 email, right away");
    expect(cadenceSummary([])).toBe("No emails");
    expect(
      cadenceSummary([
        { step: 1, delay_hours: 0 },
        { step: 2, delay_hours: 6 },
      ]),
    ).toBe("2 emails over about 6 hours");
  });
  it("says when the last one goes", () => {
    expect(lastEmailSentence(SEEDED)).toBe(
      "If nobody replies, the last one goes about 6 days after the approval.",
    );
    expect(lastEmailSentence([{ step: 1, delay_hours: 0 }])).toBe(
      "Just the one email, right away.",
    );
    // the first email is the rep's own, sent from their mailbox: not a wait the system keeps
    expect(sinceApproval(0)).toBe("You send it");
    expect(sinceApproval(72)).toBe("About 3 days after the approval");
    expect(sinceApproval(36)).toBe("About 36 hours after the approval");
  });
});

describe("the daytime window", () => {
  it("labels hours the way a person says them", () => {
    expect(hourLabel(9)).toBe("9 AM");
    expect(hourLabel(12)).toBe("Noon");
    expect(hourLabel(18)).toBe("6 PM");
    expect(hourLabel(0)).toBe("Midnight");
    expect(hourLabel(24)).toBe("Midnight");
    expect(hourLabel(23)).toBe("11 PM");
  });
  it("says the days and hours in a line", () => {
    expect(windowSummary(9, 18, false)).toBe(
      "Monday to Friday, 9 AM to 6 PM, in each merchant's own time zone.",
    );
    expect(windowSummary(8, 20, true)).toBe(
      "Every day, 8 AM to 8 PM, in each merchant's own time zone.",
    );
  });
});

describe("designs", () => {
  it("is ready only with both a design and a subject", () => {
    expect(hasDesign({ html: "<p>Hi</p>", subject: "Hello" })).toBe(true);
    expect(hasDesign({ html: "  ", subject: "Hello" })).toBe(false);
    expect(hasDesign({ html: "<p>Hi</p>", subject: " " })).toBe(false);
  });
  it("lists names in a sentence", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["Follow-up 2"])).toBe("Follow-up 2");
    expect(listNames(["Email 1", "Follow-up 3"])).toBe("Email 1 and Follow-up 3");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
  });
  it("measures a design in UTF-8 bytes and says it in KB", () => {
    expect(byteSize("abc")).toBe(3);
    expect(byteSize("’")).toBe(3);
    expect(formatKb(512)).toBe("512 bytes");
    expect(formatKb(14_271)).toBe("14.3 KB");
    expect(formatKb(120_400)).toBe("120 KB");
  });
  it("takes .html and .htm files, by name or by type", () => {
    expect(isHtmlFile("approved.html", "")).toBe(true);
    expect(isHtmlFile("APPROVED.HTM", "")).toBe(true);
    expect(isHtmlFile("design", "text/html")).toBe(true);
    expect(isHtmlFile("logo.png", "image/png")).toBe(false);
    expect(isHtmlFile("notes.txt", "text/plain")).toBe(false);
  });
});

describe("the inbox line", () => {
  it("is the hidden preheader when the design has one, without its filler characters", () => {
    const html = `<html><head><title>Congrats</title></head><body>
      <div style="display:none;max-height:0;overflow:hidden;">Your offer is ready.&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
      <p>https://selectivecap.com</p><h1>Congrats, Maria.</h1></body></html>`;
    expect(inboxPreview(html)).toBe("Your offer is ready.");
  });
  it("falls back to the design's opening words", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body><p>Hi Maria,</p><p>Your approval for Sunrise Bakery is ready.</p></body></html>";
    expect(inboxPreview(html)).toBe("Hi Maria, Your approval for Sunrise Bakery is ready.");
  });
  it("cuts a long line at about 90 characters", () => {
    const words = "word ".repeat(40);
    const line = inboxPreview(`<p>${words}</p>`);
    expect(line.length).toBeLessThanOrEqual(90);
    expect(line.endsWith("…")).toBe(true);
    expect(inboxPreview(`<p>${words}</p>`, 20)).toBe("word word word word…");
  });
  it("is empty for an empty design", () => {
    expect(inboxPreview("")).toBe("");
  });
});
