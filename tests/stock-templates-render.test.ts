import { describe, expect, it } from "vitest";
import { approvalValues } from "@/lib/approvals/engine";
import {
  approvalClaims,
  fillApprovalEmail,
  htmlToText,
  preheaderText,
  type ApprovalValues,
} from "@/lib/approvals/html";
import { STOCK_DESIGNS } from "@/lib/approvals/stock";
import { buildRawEmail } from "@/lib/email/raw";
import { emailsStatus } from "@/lib/approvals/words";

/**
 * Each Selective Capital design filled in for a merchant the way the engine does it (approvalValues, then
 * fillApprovalEmail, then htmlToText for the plain-text part), with a business name that has an ampersand and
 * apostrophes. Pure: the database side is in stock-templates-db.test.ts.
 */

const BUSINESS = "Harbor & Pine O'Neil's Cafe";
const UNSUB = "https://crm.test/u/tok_123";
const values = (over: Partial<Parameters<typeof approvalValues>[0]> = {}): ApprovalValues =>
  approvalValues({
    contact_name: "mike harbor",
    business_name: BUSINESS,
    amount_cents: 8_500_000,
    hold_until: "2026-11-21",
    rep_name: "josh miller",
    rep_phone: "(561) 915-1002",
    rep_email: "josh@selectivecap.com",
    unsubscribe_url: UNSUB,
    ...over,
  });
const fill = (i: number, v: ApprovalValues = values()) => fillApprovalEmail(STOCK_DESIGNS[i]!, v);

describe.each(STOCK_DESIGNS.map((d, i) => [d.name, i] as const))(
  "%s, sent to a sample merchant",
  (_n, i) => {
    const filled = fill(i);
    const text = htmlToText(filled.html);

    it("has no field left over, in the subject or the HTML", () => {
      expect(filled.missing).toEqual([]);
      expect(filled.unfilled).toEqual([]);
      expect(filled.html).not.toContain("{{");
      expect(filled.subject).not.toContain("{{");
    });

    it("escapes the merchant's values in the HTML and leaves the subject plain", () => {
      expect(filled.html).not.toContain("Harbor & Pine");
      expect(filled.html).not.toContain("O'Neil");
      expect(filled.subject).toBe(
        [
          `${BUSINESS}: Approved for Funding`,
          "Did you see your approval, Mike?",
          "Your offer is time-sensitive",
          "Should I keep your offer open, Mike?",
        ][i],
      );
    });

    it("resolves the rep's phone, email and name and the merchant's unsubscribe link", () => {
      expect(filled.html.match(/href="tel:\+15619151002"/g)).toHaveLength(4);
      expect(filled.html).toContain('href="mailto:josh@selectivecap.com');
      expect(filled.html).toContain("Josh Miller");
      expect(filled.html).toContain("(561) 915-1002");
      expect(filled.html).toContain(`href="${UNSUB}"`);
      expect(filled.html).toContain("5301 N Federal Hwy");
    });

    it("has a readable plain-text part with the words, the link and none of the markup", () => {
      expect(text.length).toBeGreaterThan(400);
      expect(text).toContain("Mike");
      expect(text).toContain("Josh Miller");
      expect(text).toContain("(561) 915-1002");
      expect(text).toContain(`Unsubscribe (${UNSUB})`);
      expect(text).toContain("5301 N Federal Hwy");
      expect(text).not.toMatch(/[<>]|&amp;|&#39;|&nbsp;|\{\{|font-size|display:\s*none/);
      // the hidden preview line is for the inbox, not the body
      expect(text).not.toContain(preheaderText(filled.html));
    });

    it("goes as multipart/alternative with both parts intact", () => {
      const raw = Buffer.from(
        buildRawEmail({
          from: "josh@selectivecap.com",
          to: "m@harborpine.com",
          subject: filled.subject,
          text,
          html: filled.html,
        }),
        "base64url",
      ).toString("utf8");
      expect(raw).toContain("Content-Type: multipart/alternative");
      const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
      const parts = raw.split(`--${boundary}`);
      const body = (p: string) => Buffer.from(p.split("\r\n\r\n")[1] ?? "", "base64").toString();
      expect(parts[1]).toContain("text/plain");
      expect(body(parts[1] ?? "")).toBe(text);
      expect(parts[2]).toContain("text/html");
      expect(body(parts[2] ?? "")).toBe(filled.html);
    });

    it("passes the claim rules for this merchant (even a California one)", () => {
      expect(approvalClaims(`${filled.subject}\n${text}`, { state: "CA" })).toEqual([]);
    });
  },
);

describe("the inbox preview line comes from the design", () => {
  it("is the owner's preheader with the merchant's own words in it", () => {
    expect(STOCK_DESIGNS.map((_d, i) => preheaderText(fill(i).html))).toEqual([
      `${BUSINESS} is approved. Your offer is ready, and we can fund as soon as today.`,
      `${BUSINESS} is approved and the offer is ready to review.`,
      "Approvals are tied to your current bank statements.",
      `Your offer for ${BUSINESS} expires Saturday, November 21.`,
    ]);
  });
});

describe("a missing value holds the email instead of sending a literal {{field}}", () => {
  it("a rep with no phone number holds every one of the four", () => {
    for (const i of [0, 1, 2, 3]) {
      const f = fill(i, values({ rep_phone: "  " }));
      expect(f.missing).toEqual(["rep_phone"]);
      // the design still shows the field as typed: the engine never sends this one
      expect(f.html).toContain("{{rep_phone}}");
    }
  });

  it("follow-up 3 with no hold date is held for the date; the other three do not need one", () => {
    const noDate = values({ hold_until: null });
    expect(noDate.offer_expiry).toBe("");
    expect([0, 1, 2].map((i) => fill(i, noDate).missing)).toEqual([[], [], []]);
    expect(fill(3, noDate).missing).toEqual(["offer_expiry"]);
  });

  it("a merchant with no contact name or no rep email holds the email too", () => {
    expect(fill(1, values({ contact_name: "" })).missing).toEqual(["first_name"]);
    expect(fill(0, values({ rep_email: "" })).missing).toEqual(["rep_email"]);
  });

  it("the approval card says which email is held and how to fix it", () => {
    const base = {
      status: "open" as const,
      emails: "running" as const,
      halt: null,
      next_step: 4,
      next_email_at: null,
      steps: [],
      needs_call: false,
    };
    const held = emailsStatus({ ...base, emails_note: "missing:offer_expiry" }, () => "");
    expect(held).toMatchObject({ tone: "warn", label: "Waiting" });
    expect(held.detail).toBe("Follow-up 3 needs the hold date. Add it with Change.");
    expect(
      emailsStatus({ ...base, next_step: 1, emails_note: "missing:rep_phone" }, () => "").detail,
    ).toBe("Approval email needs the rep's phone number (My account).");
  });
});

describe("what a merchant's name can do to the page", () => {
  it("is shown as text, never as markup", () => {
    const evil = `<img src=x onerror=alert(1)> & "Co"`;
    for (const i of [0, 1, 2, 3]) {
      const f = fill(i, values({ business_name: evil, contact_name: "<b>mike</b>" }));
      expect(f.html).not.toContain("<img src=x");
      expect(f.html).not.toContain("<b>mike");
      expect(f.unfilled).toEqual([]);
    }
    expect(fill(0, values({ business_name: evil })).html).toContain(
      "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;",
    );
  });

  it("a merchant name that holds braces is not read as a field", () => {
    const f = fill(0, values({ business_name: "Cafe {{rep_name}} {{x}}" }));
    expect(f.unfilled).toEqual([]);
    expect(f.missing).toEqual([]);
    expect(f.html).toContain("Cafe {{rep_name}} {{x}}");
  });
});
