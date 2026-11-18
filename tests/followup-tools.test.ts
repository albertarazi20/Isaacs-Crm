import { describe, expect, it } from "vitest";
import type { BucketMember } from "@/lib/buckets/queries";
import { fileSlug, FOLLOWUP_HEADER, followupCsv, followupRows } from "@/lib/export/followup";
import { callWindow, dialList, localTime, numbersText, tableText } from "@/lib/followup/dial";
import { matchesSearch } from "@/lib/followup/search";

/**
 * The Follow Up tools: finding a merchant by anything you remember, the dial list (who may be called, the numbers
 * as text to paste into Google Voice or a sheet), and the bucket as a spreadsheet for a text blast.
 */

const member = (over: Partial<BucketMember> = {}): BucketMember => ({
  enrollment_id: "e1",
  client_id: "c1",
  business_name: "Pioneer Auto Glass",
  contact_name: "Hector Vale",
  phone: "+13055550100",
  email: "vale@example.com",
  state: "FL",
  timezone: "America/New_York",
  tz_label: "ET",
  wanted_amount_cents: null,
  entered_at: "2026-11-10T15:00:00.000Z",
  next_step: 2,
  next_due_on: "2026-11-19",
  steps_sent: 1,
  paused: false,
  last_touch_at: "2026-11-12T15:00:00.000Z",
  reply_waiting: false,
  email_opt_out: false,
  email_bounced: false,
  stips_missing: 1,
  missing: [{ kind: "signed_application", period: null }],
  active_at: null,
  rep_name: "Maya Rep",
  contact_status: "ok",
  bucket_id: "b1",
  bucket_name: "Missing application",
  ...over,
});

describe("finding a merchant", () => {
  const m = member();
  it("finds by business, contact, email, state, bucket and rep", () => {
    for (const q of ["pioneer", "GLASS", "hector", "vale@", "fl", "missing application", "maya"])
      expect(matchesSearch(m, q), q).toBe(true);
    expect(matchesSearch(m, "bakery")).toBe(false);
  });
  it("needs every word, wherever each one is", () => {
    expect(matchesSearch(m, "pioneer vale")).toBe(true);
    expect(matchesSearch(m, "pioneer bakery")).toBe(false);
  });
  it("finds a number however it is typed or was stored", () => {
    for (const q of [
      "3055550100",
      "305-555-0100",
      "(305) 555-0100",
      "305 555",
      "+1305555",
      "555-0100",
    ])
      expect(matchesSearch(m, q), q).toBe(true);
    expect(matchesSearch(m, "305-555-0199")).toBe(false);
    // a stored number that was typed with punctuation
    expect(matchesSearch(member({ phone: "(305) 555-0100" }), "3055550100")).toBe(true);
  });
  it("an empty search finds everyone", () => {
    expect(matchesSearch(m, "   ")).toBe(true);
  });
});

describe("the dial list", () => {
  const list = [
    member({ client_id: "a", business_name: "Alpha", phone: "+13055550101" }),
    member({ client_id: "b", business_name: "Bravo", phone: "3055550102", contact_name: "" }),
    member({ client_id: "c", business_name: "Charlie", contact_status: "dnc" }),
    member({ client_id: "d", business_name: "Delta", contact_status: "no_call" }),
    member({ client_id: "e", business_name: "Echo", phone: "call his cell" }),
    member({ client_id: "f", business_name: "Foxtrot", phone: "" }),
    member({
      client_id: "g",
      business_name: "Golf",
      contact_status: "no_text",
      phone: "+13055550107",
    }),
  ];
  const { rows, skipped } = dialList(list);

  it("keeps the order and leaves off whoever may not or cannot be called, with the reason", () => {
    expect(rows.map((r) => r.business)).toEqual(["Alpha", "Bravo", "Golf"]);
    expect(skipped.map((s) => [s.business, s.why])).toEqual([
      ["Charlie", "do not contact"],
      ["Delta", "asked not to be called"],
      ["Echo", "not a usable number"],
      ["Foxtrot", "no phone number"],
    ]);
  });
  it("dials a number once when two merchant records share it", () => {
    const twins = dialList([
      member({ client_id: "a", business_name: "Alpha", phone: "+13055550101" }),
      member({ client_id: "b", business_name: "Alpha Two", phone: "(305) 555-0101" }),
      member({ client_id: "c", business_name: "Other", phone: "305-555-0102" }),
    ]);
    expect(twins.rows.map((r) => r.business)).toEqual(["Alpha", "Other"]);
    expect(twins.skipped).toEqual([
      { clientId: "b", business: "Alpha Two", why: "same number as Alpha" },
    ]);
  });
  it("shows each number the way a phone shows it, and links Google Voice", () => {
    expect(rows[1]).toMatchObject({ phone: "(305) 555-0102", e164: "+13055550102" });
    expect(rows[0]!.voiceHref).toBe("https://voice.google.com/u/0/calls?a=nc,%2B13055550101");
  });
  it("makes the text to paste", () => {
    expect(numbersText(rows)).toBe("(305) 555-0101\n(305) 555-0102\n(305) 555-0107");
    expect(tableText(rows).split("\n")[0]).toBe("Alpha\tHector Vale\t(305) 555-0101");
  });
  it("reads the merchant's own clock and the calling hours", () => {
    const noonEt = new Date("2026-11-18T17:00:00Z"); // 12:00 in New York, 9:00 in Los Angeles
    expect(localTime("America/New_York", noonEt)).toBe("12:00 PM");
    expect(callWindow("America/New_York", noonEt)).toBe("open");
    expect(callWindow("America/Los_Angeles", new Date("2026-11-18T15:00:00Z"))).toBe("early"); // 7:00
    expect(callWindow("America/New_York", new Date("2026-11-19T02:30:00Z"))).toBe("late"); // 21:30
    expect(callWindow("Not/AZone", noonEt)).toBe("unknown");
  });
});

describe("a bucket as a spreadsheet", () => {
  it("has the columns a sheet and a text blast need, in order", () => {
    expect([...FOLLOWUP_HEADER].slice(0, 8)).toEqual([
      "Business",
      "Contact",
      "Phone",
      "Phone (E.164)",
      "Email",
      "State",
      "Time zone",
      "Bucket",
    ]);
    expect(FOLLOWUP_HEADER.slice(-3)).toEqual(["Call OK", "Text OK", "Email OK"]);
  });

  it("writes one line a merchant, leaves out do-not-contact, and says how many", () => {
    const { rows, left } = followupRows([
      member(),
      member({ client_id: "x", business_name: "Nope", contact_status: "dnc" }),
    ]);
    expect(left).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      "Pioneer Auto Glass",
      "Hector Vale",
      "(305) 555-0100",
      "+13055550100",
      "vale@example.com",
      "FL",
      "ET",
      "Missing application",
      "Step 2",
      "2026-11-19",
      1,
      "2026-11-12",
      "the signed application",
      "no",
      "Maya Rep",
      "2026-11-10",
      "yes",
      "yes",
      "yes",
    ]);
  });

  it("marks who may be called, texted and emailed", () => {
    const flags = (over: Partial<BucketMember>) => followupRows([member(over)]).rows[0]!.slice(-3);
    expect(flags({ contact_status: "no_text" })).toEqual(["yes", "no", "yes"]);
    expect(flags({ contact_status: "no_call" })).toEqual(["no", "yes", "yes"]);
    expect(flags({ contact_status: "no_email" })).toEqual(["yes", "yes", "no"]);
    expect(flags({ email_opt_out: true })).toEqual(["yes", "yes", "no"]);
    expect(flags({ email_bounced: true })).toEqual(["yes", "yes", "no"]);
    expect(flags({ email: "" })).toEqual(["yes", "yes", "no"]);
    expect(flags({ phone: "n/a" })).toEqual(["no", "no", "yes"]);
  });

  it("is a real CSV that a spreadsheet can never run as a formula", () => {
    const { csv } = followupCsv([
      member({
        business_name: '=HYPERLINK("http://x")',
        contact_name: "Lee, Kim",
        phone: "+13055550100",
      }),
    ]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(FOLLOWUP_HEADER.join(","));
    expect(lines[1]!.startsWith(`"'=HYPERLINK(""http://x"")",`)).toBe(true);
    expect(lines[1]).toContain('"Lee, Kim"');
    expect(lines[1]).toContain(",(305) 555-0100,+13055550100,");
  });

  it("names the file after the bucket", () => {
    expect(fileSlug("Missing ID / voided check")).toBe("missing-id-voided-check");
    expect(fileSlug("///")).toBe("bucket");
  });
});
