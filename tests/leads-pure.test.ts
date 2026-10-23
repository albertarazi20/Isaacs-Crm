import { describe, expect, it } from "vitest";
import { leadSchema, toNewClient } from "@/lib/leads/schema";
import {
  generateToken,
  hashToken,
  MAX_BODY_BYTES,
  parseBearer,
  readLimitedJson,
  tokenHint,
} from "@/lib/leads/token";

describe("lead tokens", () => {
  it("are long, prefixed, URL-safe and different every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^isl_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it("hash to a stable 64-character digest that isn't the token", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t.slice(4, 20));
  });
  it("the hint shows enough to recognise a token and not enough to use it", () => {
    const t = generateToken();
    const hint = tokenHint(t);
    expect(hint.length).toBeLessThan(20);
    expect(t).not.toContain(hint);
  });
});

describe("parseBearer", () => {
  const good = generateToken();
  it("accepts a well-formed bearer token", () => {
    expect(parseBearer(`Bearer ${good}`)).toBe(good);
  });
  it.each([
    null,
    "",
    good,
    `bearer ${good}`,
    `Bearer  ${good}`,
    `Bearer ${good} extra`,
    "Bearer isl_short",
    `Bearer ${good.replace("isl_", "xyz_")}`,
    `Bearer ${good}\n`,
    "Basic dXNlcjpwYXNz",
  ])("refuses %j", (h) => {
    expect(parseBearer(h)).toBeNull();
  });
});

const req = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request("http://x.test/api/leads", { method: "POST", body, headers });

describe("readLimitedJson", () => {
  it("reads a JSON body", async () => {
    expect(await readLimitedJson(req('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });
  it("refuses an empty body and bad JSON in plain words", async () => {
    expect(await readLimitedJson(req(null))).toMatchObject({ ok: false, status: 400 });
    expect(await readLimitedJson(req("{nope"))).toMatchObject({
      ok: false,
      status: 400,
      error: "That isn't valid JSON",
    });
  });
  it("refuses a body over the cap, whatever Content-Length claims", async () => {
    const big = JSON.stringify({ notes: "x".repeat(MAX_BODY_BYTES) });
    expect(await readLimitedJson(req(big))).toMatchObject({ ok: false, status: 413 });
    expect(await readLimitedJson(req(big, { "content-length": "5" }))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(
      await readLimitedJson(req("{}", { "content-length": String(MAX_BODY_BYTES + 1) })),
    ).toMatchObject({
      ok: false,
      status: 413,
    });
  });
});

describe("leadSchema", () => {
  it("needs a way to reach them and a name", () => {
    expect(leadSchema.safeParse({ businessName: "Mike's Pizza" }).error?.issues[0]?.message).toBe(
      "Include a phone number or an email",
    );
    expect(leadSchema.safeParse({ phone: "3055550100" }).error?.issues[0]?.message).toBe(
      "Include a business name or a contact name",
    );
    expect(
      leadSchema.safeParse({ businessName: "Mike's Pizza", phone: "3055550100" }).success,
    ).toBe(true);
    expect(leadSchema.safeParse({ contactName: "Mike", email: "m@x.com" }).success).toBe(true);
  });
  it("accepts numbers where forms send them and trims strings", () => {
    const r = leadSchema.parse({
      businessName: "  Mike's  ",
      phone: 3055550100,
      wantedAmount: 50000,
    });
    expect(r).toMatchObject({ businessName: "Mike's", phone: "3055550100", wantedAmount: "50000" });
  });
  it("ignores fields it doesn't know — an outside caller can't set a stage or an owner", () => {
    const r = leadSchema.parse({
      businessName: "A",
      phone: "1",
      stage: "funded",
      user_id: "x",
      id: "y",
    });
    expect(Object.keys(r).sort()).toEqual(["businessName", "phone"]);
  });
  it("refuses an SSN or card number in the notes", () => {
    const r = leadSchema.safeParse({
      businessName: "A",
      phone: "3055550100",
      notes: "ssn 123-45-6789",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/Social Security/);
    expect(
      leadSchema.safeParse({
        businessName: "A",
        phone: "3055550100",
        notes: "card 4111 1111 1111 1111",
      }).success,
    ).toBe(false);
  });
  it("refuses over-long fields", () => {
    expect(leadSchema.safeParse({ businessName: "x".repeat(201), phone: "1" }).success).toBe(false);
  });
});

describe("toNewClient", () => {
  it("falls back to the contact's name, says 'Lead intake', and is due today", () => {
    const c = toNewClient(
      { contactName: "Mike Ross", phone: "(305) 555-0100", wantedAmount: "50k" },
      "2026-10-23",
    );
    expect(c).toMatchObject({
      businessName: "Mike Ross",
      source: "Lead intake",
      stage: "name_in",
      followUpOn: "2026-10-23",
      wantedAmount: 5_000_000,
    });
  });
  it("keeps the sender's source", () => {
    expect(
      toNewClient({ businessName: "A", phone: "1", source: "Lead vendor X" }, "2026-10-23").source,
    ).toBe("Lead vendor X");
  });
});
