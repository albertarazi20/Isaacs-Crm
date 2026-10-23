import { describe, expect, it } from "vitest";
import {
  buildCallIcs,
  escapeText,
  foldLine,
  googleCalendarUrl,
  icsFilename,
  icsUtc,
  zonedLocalToInstant,
  type CallEvent,
} from "@/lib/messaging/ics";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const unfold = (s: string) => s.replace(/\r\n /g, "");

const EV: CallEvent = {
  uid: "call-abc@isaac",
  start: "2026-10-27T18:30:00Z",
  businessName: "Mike's Pizza",
  phone: "(305) 555-0101",
  wants: "$60,000, 6 months daily",
  topic: "Review offers",
  lastNote: "Wants it by Friday; two trucks down",
  url: "https://isaac.example.com/clients/abc",
  now: new Date("2026-10-23T12:00:00Z"),
};

describe("TEXT escaping (RFC 5545 §3.3.11)", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a,b;c")).toBe(String.raw`a\,b\;c`);
    expect(escapeText("back" + String.fromCharCode(92) + "slash")).toBe(String.raw`back\\slash`);
    expect(escapeText("one\ntwo")).toBe("one\\ntwo");
    expect(escapeText("one\r\ntwo\rthree")).toBe("one\\ntwo\\nthree");
  });
  it("escapes the backslash first, so an escape isn't escaped twice", () => {
    expect(escapeText("a\\,b")).toBe("a\\\\\\,b");
    expect(escapeText("\\n")).toBe("\\\\n");
  });
  it("drops control characters but keeps tabs out of trouble", () => {
    expect(escapeText("a\u0000b\u0007c\u001Fd\u007Fe")).toBe("abcde");
  });
  it("leaves plain text, quotes, colons and unicode alone", () => {
    expect(escapeText(`Mike's "Best" Pizza: café — 5 stars`)).toBe(
      `Mike's "Best" Pizza: café — 5 stars`,
    );
  });
});

describe("line folding (75 octets)", () => {
  it("leaves a line of 75 octets alone and folds one of 76", () => {
    expect(foldLine("a".repeat(75))).toBe("a".repeat(75));
    expect(foldLine("a".repeat(76))).toBe(`${"a".repeat(75)}\r\n a`);
  });
  it("continuation lines start with one space and are at most 75 octets including it", () => {
    const folded = foldLine("x".repeat(300));
    const lines = folded.split("\r\n");
    expect(lines).toHaveLength(5); // 75 + 74 + 74 + 74 + 3
    expect(bytes(lines[0] ?? "")).toBe(75);
    for (const l of lines.slice(1)) {
      expect(l.startsWith(" ")).toBe(true);
      expect(bytes(l)).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe("x".repeat(300));
  });
  it("counts octets, not characters, and never splits a multi-byte character", () => {
    // é = 2 bytes, — = 3 bytes, 😀 = 4 bytes
    for (const ch of ["é", "—", "😀"]) {
      const text = `SUMMARY:${ch.repeat(80)}`;
      const folded = foldLine(text);
      for (const l of folded.split("\r\n")) {
        expect(bytes(l), ch).toBeLessThanOrEqual(75);
        expect(l.includes("�")).toBe(false);
      }
      expect(unfold(folded)).toBe(text);
    }
    const lines = foldLine(`X:${"é".repeat(80)}`).split("\r\n");
    expect(bytes(lines[0] ?? "")).toBe(74); // 2 + 36×2 = 74; a 37th é would make 76
  });
  it("round-trips any length", () => {
    for (let n = 0; n < 400; n += 7) {
      const s = `DESCRIPTION:${"ab,".repeat(n)}`;
      expect(unfold(foldLine(s))).toBe(s);
    }
  });
});

describe("UTC", () => {
  it("writes DTSTART/DTEND as UTC without separators", () => {
    expect(icsUtc(new Date("2026-10-27T18:30:00Z"))).toBe("20261027T183000Z");
    expect(icsUtc(new Date("2026-01-05T00:00:09.987Z"))).toBe("20260105T000009Z");
  });

  it("converts a local time to the right instant across daylight saving (New York)", () => {
    const ny = (local: string) => zonedLocalToInstant(local, "America/New_York").toISOString();
    expect(ny("2026-01-15T09:00")).toBe("2026-01-15T14:00:00.000Z"); // EST, UTC-5
    expect(ny("2026-07-04T12:00")).toBe("2026-07-04T16:00:00.000Z"); // EDT, UTC-4
    // spring forward: 2026-03-08 02:00 → 03:00
    expect(ny("2026-03-08T01:59")).toBe("2026-03-08T06:59:00.000Z");
    expect(ny("2026-03-08T03:00")).toBe("2026-03-08T07:00:00.000Z");
    expect(ny("2026-03-08T02:30")).toBe("2026-03-08T07:30:00.000Z"); // doesn't exist: moves ahead to 3:30 EDT
    // fall back: 2026-11-01 02:00 → 01:00
    expect(ny("2026-11-01T00:30")).toBe("2026-11-01T04:30:00.000Z"); // EDT
    expect(ny("2026-11-01T01:30")).toBe("2026-11-01T05:30:00.000Z"); // happens twice: the first (EDT)
    expect(ny("2026-11-01T02:30")).toBe("2026-11-01T07:30:00.000Z"); // EST
    // the day either side of the change differs by an hour in UTC for the same wall-clock time
    expect(ny("2026-10-31T09:00")).toBe("2026-10-31T13:00:00.000Z");
    expect(ny("2026-11-01T09:00")).toBe("2026-11-01T14:00:00.000Z");
  });
  it("handles other US zones, including ones with no daylight saving", () => {
    expect(zonedLocalToInstant("2026-03-08T02:30", "America/Los_Angeles").toISOString()).toBe(
      "2026-03-08T10:30:00.000Z",
    );
    expect(zonedLocalToInstant("2026-07-04T12:00", "America/Phoenix").toISOString()).toBe(
      "2026-07-04T19:00:00.000Z",
    );
    expect(zonedLocalToInstant("2026-01-04T12:00", "America/Phoenix").toISOString()).toBe(
      "2026-01-04T19:00:00.000Z",
    );
    expect(zonedLocalToInstant("2026-07-04T12:00", "America/Chicago").toISOString()).toBe(
      "2026-07-04T17:00:00.000Z",
    );
    expect(zonedLocalToInstant("2026-12-25T08:15:30", "Pacific/Honolulu").toISOString()).toBe(
      "2026-12-25T18:15:30.000Z",
    );
    expect(zonedLocalToInstant("2026-07-04T12:00", "UTC").toISOString()).toBe(
      "2026-07-04T12:00:00.000Z",
    );
  });
  it("refuses nonsense", () => {
    expect(() => zonedLocalToInstant("tomorrow", "America/New_York")).toThrow();
    expect(() => buildCallIcs({ ...EV, start: "2026-10-27T14:30" })).toThrow(/timezone/);
    expect(() => buildCallIcs({ ...EV, start: "not a date" })).toThrow();
  });
  it("puts a local booking into the file as UTC on both sides of a daylight-saving change", () => {
    const before = buildCallIcs({ ...EV, start: "2026-10-31T09:00", timezone: "America/New_York" });
    const after = buildCallIcs({ ...EV, start: "2026-11-01T09:00", timezone: "America/New_York" });
    expect(before).toContain("\r\nDTSTART:20261031T130000Z\r\n");
    expect(before).toContain("\r\nDTEND:20261031T133000Z\r\n");
    expect(after).toContain("\r\nDTSTART:20261101T140000Z\r\n");
    expect(after).toContain("\r\nDTEND:20261101T143000Z\r\n");
  });
  it("accepts an instant with an offset or a Date", () => {
    const a = buildCallIcs({ ...EV, start: "2026-10-27T14:30:00-04:00" });
    const b = buildCallIcs({ ...EV, start: new Date("2026-10-27T18:30:00Z") });
    expect(a).toContain("DTSTART:20261027T183000Z");
    expect(b).toContain("DTSTART:20261027T183000Z");
  });
});

describe("the calendar file", () => {
  const ics = buildCallIcs(EV);
  const lines = ics.split("\r\n");
  const flat = unfold(ics).split("\r\n");

  it("is CRLF all the way and ends with a line break", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-2)).toBe("END:VCALENDAR");
    expect(lines.at(-1)).toBe("");
  });
  it("has one VEVENT with a UTC start, a 30-minute length and the title", () => {
    expect(flat).toContain("BEGIN:VEVENT");
    expect(flat.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(flat).toContain("DTSTART:20261027T183000Z");
    expect(flat).toContain("DTEND:20261027T190000Z");
    expect(flat).toContain("DTSTAMP:20261023T120000Z");
    expect(flat).toContain("SUMMARY:Call: Mike's Pizza");
    expect(flat).toContain("UID:call-abc@isaac");
    expect(flat).toContain("URL:https://isaac.example.com/clients/abc");
    expect(flat).toContain("VERSION:2.0");
    expect(flat.some((l) => l.startsWith("PRODID:"))).toBe(true);
  });
  it("puts the phone, what he wants, the topic, the last note and the link in the description", () => {
    const d = flat.find((l) => l.startsWith("DESCRIPTION:")) ?? "";
    expect(d).toContain("Phone: (305) 555-0101");
    expect(d).toContain("Wants: $60\\,000\\, 6 months daily");
    expect(d).toContain("About: Review offers");
    expect(d).toContain(String.raw`Last call note: Wants it by Friday\; two trucks down`);
    expect(d).toContain("Client page: https://isaac.example.com/clients/abc");
    // each fact on its own line, as escaped \n
    expect(d.split("\\n")).toHaveLength(5);
  });
  it("has a 15-minute reminder", () => {
    const i = flat.indexOf("BEGIN:VALARM");
    expect(i).toBeGreaterThan(0);
    expect(flat.slice(i, i + 5)).toEqual([
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Call: Mike's Pizza",
      "TRIGGER:-PT15M",
      "END:VALARM",
    ]);
    expect(buildCallIcs({ ...EV, alarmMinutes: 5, durationMinutes: 45 })).toContain(
      "TRIGGER:-PT5M",
    );
    expect(unfold(buildCallIcs({ ...EV, durationMinutes: 45 }))).toContain(
      "DTEND:20261027T191500Z",
    );
  });
  it("never has a line over 75 octets", () => {
    const long = buildCallIcs({
      ...EV,
      businessName: "Åsa's Béarnaise — Gourmet, Catering; & Café ".repeat(4),
      lastNote: "A very long note, with commas; semicolons; and — dashes — ".repeat(12),
      url: `https://isaac.example.com/clients/${"a".repeat(120)}`,
    });
    for (const l of long.split("\r\n")) expect(bytes(l)).toBeLessThanOrEqual(75);
    expect(unfold(long)).toContain("Call: Åsa's Béarnaise");
  });
  it("escapes a business name and a note full of special characters", () => {
    const f = unfold(
      buildCallIcs({
        ...EV,
        businessName: "Smith, Jones; & Sons\\Co",
        lastNote: "line one\nline two",
      }),
    ).split("\r\n");
    expect(f).toContain(String.raw`SUMMARY:Call: Smith\, Jones\; & Sons\\Co`);
    expect(f.find((l) => l.startsWith("DESCRIPTION:Phone"))).toContain(
      "Last call note: line one\\nline two",
    );
  });
  it("can't be broken out of by a newline in the data", () => {
    const evil = buildCallIcs({
      ...EV,
      businessName: "X\r\nEND:VEVENT\r\nBEGIN:VEVENT",
      lastNote: "ok\r\nATTACH:http://evil",
    });
    expect(evil.split("\r\n").filter((l) => l === "END:VEVENT")).toHaveLength(1);
    expect(evil.split("\r\n").some((l) => l.startsWith("ATTACH"))).toBe(false);
  });
  it("leaves out facts it doesn't have", () => {
    const f = unfold(
      buildCallIcs({ ...EV, phone: "", wants: undefined, topic: "", lastNote: "  ", url: "" }),
    );
    const d =
      f
        .split("\r\n")
        .find((l) => l.startsWith("DESCRIPTION:Call") === false && l.startsWith("DESCRIPTION:")) ??
      "";
    expect(d).toBe("DESCRIPTION:");
    expect(f).not.toContain("URL:");
    expect(f).not.toContain("Phone:");
  });
  it("keeps the same UID for the same call so importing twice updates it", () => {
    expect(buildCallIcs(EV)).toBe(buildCallIcs(EV));
    expect(unfold(buildCallIcs({ ...EV, uid: "weird uid/with spaces" }))).toContain(
      "UID:weird-uid-with-spaces",
    );
  });
});

describe("Google Calendar link", () => {
  const link = new URL(googleCalendarUrl(EV));
  it("is Google's new-event template with the title and a UTC start/end", () => {
    expect(link.origin + link.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(link.searchParams.get("action")).toBe("TEMPLATE");
    expect(link.searchParams.get("text")).toBe("Call: Mike's Pizza");
    expect(link.searchParams.get("dates")).toBe("20261027T183000Z/20261027T190000Z");
  });
  it("carries the phone, what he wants, the last note and the client page", () => {
    const details = link.searchParams.get("details") ?? "";
    expect(details).toContain("Phone: (305) 555-0101");
    expect(details).toContain("Wants: $60,000, 6 months daily");
    expect(details).toContain("Last call note: Wants it by Friday; two trucks down");
    expect(details).toContain("Client page: https://isaac.example.com/clients/abc");
  });
  it("follows a local booking across daylight saving", () => {
    const l = new URL(
      googleCalendarUrl({ ...EV, start: "2026-11-01T09:00", timezone: "America/New_York" }),
    );
    expect(l.searchParams.get("dates")).toBe("20261101T140000Z/20261101T143000Z");
  });
});

describe("file name", () => {
  it("is a tidy slug", () => {
    expect(icsFilename("Mike's Pizza")).toBe("call-mikes-pizza.ics");
    expect(icsFilename("Café Müller & Sons, LLC")).toBe("call-cafe-muller-sons-llc.ics");
    expect(icsFilename("   ")).toBe("call-client.ics");
    expect(icsFilename("x".repeat(100)).length).toBeLessThanOrEqual(50);
  });
});
