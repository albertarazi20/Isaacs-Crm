import { describe, expect, it } from "vitest";
import { describeLeadProblem, leadSchema, toNewClient } from "@/lib/leads/schema";
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
  it("accepts a well-formed bearer token, whatever the case of the scheme (RFC 7235)", () => {
    expect(parseBearer(`Bearer ${good}`)).toBe(good);
    expect(parseBearer(`bearer ${good}`)).toBe(good);
    expect(parseBearer(`BEARER ${good}`)).toBe(good);
  });
  it.each([
    null,
    "",
    good,
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
  it("reads a body that starts with a byte-order mark", async () => {
    expect(await readLimitedJson(req('\uFEFF{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
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
      phone: "3055550100",
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

describe("leads from real senders (review 3A: A-3)", () => {
  it("treats a null field as 'not given', which is how forms and Zapier send a blank", () => {
    const r = leadSchema.safeParse({
      businessName: "Nully Co",
      phone: "305-555-0111",
      email: null,
      contactName: null,
      notes: null,
      wantedAmount: null,
    });
    expect(r.success).toBe(true);
    expect(r.data?.email).toBeUndefined();
  });
  it("names the field when it can't read it", () => {
    const r = leadSchema.safeParse({ businessName: "X", phone: ["1"], email: "a@b.co" });
    expect(r.success).toBe(false);
    expect(describeLeadProblem(r.error!)).toBe("phone: must be text or a number");
    const long = leadSchema.safeParse({ businessName: "x".repeat(300), phone: "1" });
    expect(describeLeadProblem(long.error!)).toBe("businessName: Keep it under 200 characters");
  });
  it("keeps the whole-lead messages as they were", () => {
    const r = leadSchema.safeParse({ businessName: "X" });
    expect(describeLeadProblem(r.error!)).toBe("Include a phone number or an email");
  });
});

describe("review-3A A-19: a phone that isn't one", () => {
  const base = { businessName: "Junk Phone Pizza" };
  it("'N/A' and '-' are not phone numbers: the lead needs an email instead", () => {
    expect(leadSchema.safeParse({ ...base, phone: "N/A" }).success).toBe(false);
    const ok = leadSchema.parse({ ...base, phone: "none", email: "m@x.com" });
    expect(ok.phone).toBeUndefined();
  });
  it("a real phone, however it is typed, is kept", () => {
    for (const p of ["305-555-0142", "(305) 555 0142", "+1 305 555 0142", "5550142"])
      expect(leadSchema.parse({ ...base, phone: p }).phone).toBe(p);
  });
  it("a number sent as a number is still a phone", () => {
    expect(leadSchema.parse({ ...base, phone: 3055550142 }).phone).toBe("3055550142");
  });
});
