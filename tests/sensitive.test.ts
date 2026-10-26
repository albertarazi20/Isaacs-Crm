import { describe, expect, it } from "vitest";
import { buildCallReminder } from "@/lib/mca/digest";
import { buildRawEmail } from "@/lib/email/raw";
import { findSensitive, luhn } from "@/lib/data/sensitive";
import {
  clientFieldsSchema,
  emailSchema,
  newClientSchema,
  noteSchema,
  touchSchema,
} from "@/lib/data/schemas";

const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

describe("sensitive data guard", () => {
  it.each([
    ["his SSN is 123-45-6789", "ssn"],
    ["ssn 123 45 6789 call back", "ssn"],
    ["card 4111 1111 1111 1111 exp 12/27", "card"],
    ["4111-1111-1111-1111", "card"],
    ["5500005555555559", "card"],
    ["acct # 123456789012", "account"],
    ["Routing: 021000021", "account"],
    ["account number 00012345678", "account"],
    ["SSN 123456789", "ssn"],
    ["his social security number is 123456789", "ssn"],
    ["social: 123-45-6789", "ssn"],
    ["EIN 12-3456789", "ssn"],
    ["tax id 123456789", "ssn"],
    ["number is 1234 5678 9012 3456", "card"],
    ["1234-5678-9012-3456", "card"],
    ["amex 3782 822463 10005", "card"],
    ["visa 1234567890123456", "card"],
    ["his card: 1234 5678 9012 345", "card"],
  ])("refuses %j as %s", (text, kind) => {
    expect(findSensitive(text)?.kind).toBe(kind);
  });

  it.each([
    "Mike wants 50k, call back Friday after he talks to his dispatcher",
    "Phone (305) 555-0101 or 305-555-0101",
    "Wants $75,000 over 9 months, daily remittance $550",
    "Statements: Jul 2026, Aug 2026, Sep 2026",
    "Funded 2026-10-23 at 1.32 factor, payback 66000",
    "2nd position behind Libertas, balance 21,000",
    "Called at 3:30pm, left message, he's at the shop until 5",
    "ref 1234567890123456 (not a card — fails the checksum)",
    "Order #123456789 shipped, social media lead",
    "Wants $123,456,789? no — $123,456",
    "call 305 555 0100 or 3055550100",
    "Lead list A, Oct 2026 (batch 1234)",
    "6 months, daily remittance 550",
    "ID 12345678 on the lease",
  ])("lets ordinary notes through: %j", (text) => {
    expect(findSensitive(text)).toBeNull();
  });

  it("knows a real card checksum from a random number", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });

  it("is enforced on every free-text field that gets saved", () => {
    expect(() => noteSchema.parse({ clientId: ID, body: "SSN 123-45-6789" })).toThrow(
      /Social Security/,
    );
    expect(() =>
      touchSchema.parse({ clientId: ID, kind: "call", body: "card 4111 1111 1111 1111" }),
    ).toThrow(/card number/);
    expect(() =>
      emailSchema.parse({ clientId: ID, subject: "Hi", body: "my account number 123456789" }),
    ).toThrow(/bank account/);
    expect(noteSchema.parse({ clientId: ID, body: "Wants 50k" }).body).toBe("Wants 50k");
  });
});

describe("single-line fields and email addresses", () => {
  it("reject line breaks and control characters — no header injection through a merchant name", () => {
    expect(() =>
      newClientSchema.parse({ businessName: "Acme\r\nBcc: attacker@evil.test" }),
    ).toThrow(/line breaks/);
    expect(() =>
      newClientSchema.parse({ businessName: "Acme", contactName: "Mike\u0000" }),
    ).toThrow(/control characters/);
    expect(() => clientFieldsSchema.parse({ phone: "5551234567\njavascript:alert(1)" })).toThrow();
  });
  it("accept exactly one valid email, or none", () => {
    expect(newClientSchema.parse({ businessName: "A", email: "mike@pizza.com" }).email).toBe(
      "mike@pizza.com",
    );
    expect(newClientSchema.parse({ businessName: "A", email: "" }).email).toBe("");
    for (const bad of [
      "a@b.com,c@d.com",
      "a@b.com; c@d.com",
      "Mike <m@x.com>",
      "not-an-email",
      "a@b",
    ]) {
      expect(() => newClientSchema.parse({ businessName: "A", email: bad }), bad).toThrow(
        /valid email/,
      );
    }
  });
  it("the Gmail builder refuses anything but one address", () => {
    const base = { from: "isaac@x.com", subject: "s", text: "t" };
    expect(() => buildRawEmail({ ...base, to: "a@b.com,c@d.com" })).toThrow(/exactly one/);
    expect(() => buildRawEmail({ ...base, to: "Mike <m@x.com>" })).toThrow(/exactly one/);
    expect(buildRawEmail({ ...base, to: "mike@pizza.com" })).toBeTruthy();
  });
  it("a booked-call subject can never carry a control character even from old data", () => {
    const r = buildCallReminder(
      {
        clientId: "c",
        businessName: "Acme\r\nBcc: x@y.z",
        contactName: "",
        phone: "",
        callTime: "3:30 PM",
        wantedAmount: null,
        lastCallNote: null,
        positionCount: 0,
      },
      "https://app.test",
    );
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the guard covers one-line fields too (I-4)", () => {
  it("refuses an SSN typed into source, terms or a name, in plain words", () => {
    expect(() =>
      newClientSchema.parse({ businessName: "X", source: "referred by 123-45-6789" }),
    ).toThrow(/Social Security/);
    expect(() =>
      newClientSchema.parse({ businessName: "X", contactName: "Mike SSN 123456789" }),
    ).toThrow(/Social Security/);
    expect(() =>
      newClientSchema.parse({ businessName: "X", industry: "card 4111 1111 1111 1111" }),
    ).toThrow(/card number/);
  });
  it("lets ordinary one-line values through", () => {
    const ok = newClientSchema.parse({
      businessName: "Mike's Pizza #2",
      contactName: "Mike Ross",
      phone: "(305) 555-0100",
      source: "Lead vendor Oct 2026",
      industry: "Restaurant",
      state: "TX",
    });
    expect(ok.source).toBe("Lead vendor Oct 2026");
  });
});
