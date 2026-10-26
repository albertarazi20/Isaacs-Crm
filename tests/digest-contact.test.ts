import { describe, expect, it } from "vitest";
import { buildDigest, groupDue, type DueTimer } from "@/lib/mca/digest";
import {
  formatUS,
  gmailComposeHref,
  normalizeUS,
  smsHref,
  telHref,
  voiceCallHref,
  voiceTextHref,
} from "@/lib/mca/phone";
import { buildRawEmail } from "@/lib/email/raw";

const TODAY = "2026-10-23";
const timer = (over: Partial<DueTimer>): DueTimer => ({
  timerId: "t1",
  clientId: "c1",
  businessName: "Mike's Pizza",
  contactName: "Mike",
  phone: "5551234567",
  stage: "interested",
  kind: "follow_up",
  dueOn: TODAY,
  note: "",
  ...over,
});

describe("digest", () => {
  it("sends nothing when nothing is due", () => {
    expect(buildDigest([], TODAY, "https://app.test")).toBeNull();
    expect(buildDigest([timer({ dueOn: "2026-10-24" })], TODAY, "https://app.test")).toBeNull();
  });
  it("lists overdue (oldest first) before today", () => {
    const g = groupDue(
      [
        timer({ timerId: "a", clientId: "ca", dueOn: TODAY, businessName: "Zed" }),
        timer({ timerId: "b", clientId: "cb", dueOn: "2026-10-20" }),
        timer({ timerId: "c", clientId: "cc", dueOn: "2026-10-01" }),
        timer({ timerId: "d", clientId: "cd", dueOn: "2026-11-01" }),
      ],
      TODAY,
    );
    expect(g.overdue.map((t) => t.timerId)).toEqual(["c", "b"]);
    expect(g.dueToday.map((t) => t.timerId)).toEqual(["a"]);
  });
  it("lists a client once when two timers are due, keeping the most specific one", () => {
    const g = groupDue(
      [
        timer({ timerId: "a", clientId: "same", kind: "follow_up" }),
        timer({ timerId: "b", clientId: "same", kind: "renewal" }),
        timer({ timerId: "c", clientId: "same", kind: "check_in", dueOn: "2026-10-10" }),
      ],
      TODAY,
    );
    expect(g.overdue.map((t) => t.timerId)).toEqual(["c"]); // the oldest wins, so it is shown as overdue
    expect(g.dueToday).toEqual([]);
    const same = groupDue(
      [timer({ timerId: "a", kind: "follow_up" }), timer({ timerId: "b", kind: "renewal" })],
      TODAY,
    );
    expect(same.dueToday.map((t) => t.timerId)).toEqual(["b"]);
  });
  it("names the count and links straight to each client", () => {
    const d = buildDigest(
      [timer({}), timer({ timerId: "t2", clientId: "c2", dueOn: "2026-10-20", kind: "renewal" })],
      TODAY,
      "https://app.test",
    );
    expect(d?.subject).toBe("1 due today, 1 overdue — follow-ups");
    expect(d?.count).toBe(2);
    expect(d?.text).toContain("https://app.test/clients/c2");
    expect(d?.text).toContain("3d overdue");
    expect(d?.text).toContain("Renewal call");
  });
  it("words the subject for overdue-only and today-only digests", () => {
    expect(buildDigest([timer({ dueOn: "2026-10-20" })], TODAY, "https://app.test")?.subject).toBe(
      "1 overdue follow-up",
    );
    expect(
      buildDigest([timer({}), timer({ timerId: "t2", clientId: "c2" })], TODAY, "https://app.test")
        ?.subject,
    ).toBe("2 follow-ups due today");
  });
  it("escapes merchant-controlled text in the HTML body", () => {
    const d = buildDigest(
      [timer({ businessName: "<script>alert(1)</script>", note: 'a"b' })],
      TODAY,
      "https://app.test",
    );
    expect(d?.html).not.toContain("<script>");
    expect(d?.html).toContain("&lt;script&gt;");
    expect(d?.html).toContain("a&quot;b");
  });
});

describe("phone links", () => {
  it("normalises US numbers to E.164", () => {
    expect(normalizeUS("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeUS("1-555-123-4567")).toBe("+15551234567");
    expect(normalizeUS("555-1234")).toBeNull();
    expect(normalizeUS("")).toBeNull();
  });
  it("formats for display", () => {
    expect(formatUS("+15551234567")).toBe("(555) 123-4567");
    expect(formatUS("garbage")).toBe("garbage");
  });
  it("builds sms/tel/voice/gmail links", () => {
    expect(telHref("+15551234567")).toBe("tel:+15551234567");
    expect(smsHref("+15551234567")).toBe("sms:+15551234567");
    expect(smsHref("+15551234567", "Hey Mike, Isaac here")).toBe(
      "sms:+15551234567?&body=Hey%20Mike%2C%20Isaac%20here",
    );
    expect(voiceTextHref("+15551234567")).toContain("t.%2B15551234567");
    expect(voiceCallHref("+15551234567")).toContain("%2B15551234567");
    expect(gmailComposeHref({ to: "m@x.com", subject: "Hi", body: "a b" })).toBe(
      "https://mail.google.com/mail/?view=cm&fs=1&to=m%40x.com&su=Hi&body=a+b",
    );
  });
});

describe("raw email for Gmail", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

  it("builds headers and a base64 body", () => {
    const msg = decode(
      buildRawEmail({
        from: "isaac@x.com",
        to: "mike@y.com",
        subject: "Checking in",
        text: "Hi Mike",
      }),
    );
    expect(msg).toContain("From: isaac@x.com\r\n");
    expect(msg).toContain("To: mike@y.com\r\n");
    expect(msg).toContain("Subject: Checking in\r\n");
    const body = msg.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")).toBe("Hi Mike");
  });
  it("encodes non-ASCII subjects", () => {
    const msg = decode(
      buildRawEmail({ from: "a@b.com", to: "c@d.com", subject: "Café — follow up", text: "x" }),
    );
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });
  it("review-3B B-17: a long non-ASCII subject is split into short encoded words that decode back whole", () => {
    const subject = `Update on your offers — ${"Pizzería Núñez ".repeat(12)}`.trim();
    const msg = decode(buildRawEmail({ from: "a@b.com", to: "c@d.com", subject, text: "x" }));
    const header =
      /Subject: ((?:=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=(?:\r\n )?)+)\r\n/.exec(msg)?.[1] ?? "";
    const words = header.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words
      .map((w) => Buffer.from(w.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(subject);
  });
  it("refuses header injection", () => {
    expect(() =>
      buildRawEmail({ from: "a@b.com", to: "c@d.com\r\nBcc: evil@z.com", subject: "x", text: "x" }),
    ).toThrow(/line break/);
    expect(() =>
      buildRawEmail({ from: "a@b.com", to: "c@d.com", subject: "x\nBcc: e@z.com", text: "x" }),
    ).toThrow();
  });
});
