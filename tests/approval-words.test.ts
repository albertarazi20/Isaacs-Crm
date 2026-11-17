import { describe, expect, it } from "vitest";
import {
  advanceWords,
  cadenceSummary,
  canResume,
  delayWords,
  emailsStatus,
  holdWords,
  stepName,
  whenWords,
} from "@/lib/approvals/words";

/** What the Open approvals page and the merchant card say. Pure. */

const base = {
  status: "open" as const,
  emails: "running" as const,
  emails_note: "",
  halt: null,
  next_step: null,
  next_email_at: null,
  steps: [],
  needs_call: false,
};
const fmt = (iso: string) => `@${iso.slice(11, 16)}`;

describe("approval words", () => {
  it("names the steps and the gaps", () => {
    expect(stepName(1)).toBe("Approval email");
    expect(stepName(3)).toBe("Follow-up 2");
    expect(delayWords(24)).toBe("1 day");
    expect(delayWords(72)).toBe("3 days");
    expect(delayWords(36)).toBe("36 hours");
    expect(delayWords(1)).toBe("1 hour");
    expect(
      cadenceSummary([
        { step: 1, delay_hours: 0, ready: true },
        { step: 2, delay_hours: 24, ready: true },
        { step: 3, delay_hours: 48, ready: true },
        { step: 4, delay_hours: 72, ready: true },
      ]),
    ).toBe("The approval email right away, then 3 follow-ups, 1 day, 2 days and 3 days apart.");
    expect(cadenceSummary([{ step: 1, delay_hours: 0, ready: true }])).toMatch(/no follow-ups/);
  });

  it("says where the emails stand", () => {
    expect(
      emailsStatus({ ...base, next_step: 2, next_email_at: "2026-11-19T14:00:00Z" }, fmt),
    ).toEqual({
      tone: "good",
      label: "Emailing",
      detail: "Follow-up 1 @14:00.",
    });
    expect(
      emailsStatus(
        { ...base, steps: [{ step: 1, status: "queued", at: "2026-11-18T19:00:00Z" }] },
        fmt,
      ),
    ).toMatchObject({ label: "Sending", detail: "Approval email goes out @19:00." });
    // a reply the engine has not caught yet shows at once, and hot
    expect(emailsStatus({ ...base, halt: "replied" }, fmt)).toMatchObject({
      label: "Replied",
      hot: true,
    });
    expect(emailsStatus({ ...base, emails: "stopped", emails_note: "expired" }, fmt).label).toBe(
      "Hold date passed",
    );
    expect(
      emailsStatus({ ...base, emails_note: "missing:rep_phone,offer_expiry" }, fmt).detail,
    ).toBe("Needs the rep's phone number (My account) and the hold date.");
    expect(emailsStatus({ ...base, emails_note: "no_design", next_step: 3 }, fmt).detail).toMatch(
      /^Follow-up 2 has no design yet/,
    );
    expect(
      emailsStatus(
        {
          ...base,
          emails: "finished",
          steps: [{ step: 4, status: "sent", at: "2026-11-25T14:00:00Z" }],
        },
        fmt,
      ),
    ).toMatchObject({ label: "All emails sent", detail: "Last one @14:00." });
    expect(emailsStatus({ ...base, status: "pitched" }, fmt).label).toBe("Pitched");
    expect(emailsStatus({ ...base, emails: "paused", emails_note: "held" }, fmt).label).toBe(
      "Not started",
    );
  });

  it("counts down the funder's hold", () => {
    expect(holdWords(null, "2026-11-18")).toBeNull();
    expect(holdWords("2026-11-30", "2026-11-18")).toEqual({
      label: "Until Nov 30",
      left: "12 days left",
      tone: "neutral",
    });
    expect(holdWords("2026-11-20", "2026-11-18")?.tone).toBe("warn");
    expect(holdWords("2026-11-18", "2026-11-18")?.left).toBe("Ends today");
    expect(holdWords("2026-11-16", "2026-11-18")).toMatchObject({
      left: "Ended 2 days ago",
      tone: "bad",
    });
  });

  it("says a time the way a rep would, in their zone", () => {
    const now = Date.parse("2026-11-18T19:00:00Z"); // Wed 2pm in New York
    const ny = "America/New_York";
    expect(whenWords("2026-11-18T19:00:30Z", ny, now)).toBe("now");
    expect(whenWords("2026-11-18T21:30:00Z", ny, now)).toBe("today at 4:30 PM");
    expect(whenWords("2026-11-19T14:00:00Z", ny, now)).toBe("tomorrow at 9:00 AM");
    expect(whenWords("2026-11-17T14:00:00Z", ny, now)).toBe("yesterday at 9:00 AM");
    expect(whenWords("2026-11-21T14:00:00Z", ny, now)).toBe("Sat at 9:00 AM");
    expect(whenWords("2026-12-02T14:00:00Z", ny, now)).toBe("Dec 2");
  });

  it("puts a reply first whatever the emails are doing, until someone has called", () => {
    expect(emailsStatus({ ...base, emails: "finished", needs_call: true }, fmt)).toMatchObject({
      label: "Replied",
      hot: true,
      detail: "Emails stopped. Call them now.",
    });
    expect(emailsStatus({ ...base, needs_call: true }, fmt).detail).toBe("Call them now.");
    expect(emailsStatus({ ...base, status: "pitched", needs_call: true }, fmt).label).toBe(
      "Pitched",
    );
  });

  it("offers Resume only where it can work", () => {
    const row = {
      status: "open" as const,
      emails: "stopped" as const,
      emails_note: "",
      halt: null,
    };
    expect(canResume({ ...row, emails_note: "replied" })).toBe(true);
    expect(canResume({ ...row, emails_note: "bounced" })).toBe(true);
    expect(canResume({ ...row, emails_note: "send_failed" })).toBe(true);
    for (const note of ["opted_out", "dnc", "suppressed", "trashed"])
      expect(canResume({ ...row, emails_note: note })).toBe(false);
    expect(canResume({ ...row, emails: "running", halt: "opted_out" })).toBe(false);
    expect(canResume({ ...row, emails: "paused", halt: "dnc" })).toBe(false);
    expect(canResume({ ...row, emails: "finished" })).toBe(false);
    expect(canResume({ ...row, emails: "running" })).toBe(false);
    expect(canResume({ ...row, status: "pitched" })).toBe(false);
  });

  it("says what a Resume did", () => {
    expect(advanceWords({ kind: "queued", step: 2, notBefore: "2026-11-19T14:00:00Z" }, fmt)).toBe(
      "Follow-up 1 goes out @14:00.",
    );
    expect(advanceWords({ kind: "stopped", note: "opted_out" }, fmt)).toBe(
      "Unsubscribed. No more approval emails.",
    );
    expect(
      advanceWords({ kind: "waiting", note: "missing:rep_phone", step: 1, at: null }, fmt),
    ).toBe("Waiting. Needs the rep's phone number (My account).");
    expect(advanceWords(null, fmt)).toBe("The emails wait until you start them.");
  });
});
