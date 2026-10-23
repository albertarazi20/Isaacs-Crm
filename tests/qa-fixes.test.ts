import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import * as m from "@/lib/data/mutations";
import { findDuplicates } from "@/lib/data/queries";
import {
  askSchema,
  duplicateCheckSchema,
  newClientSchema,
  noteSchema,
  positionSchema,
  scheduleCallSchema,
} from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  ctx = { today: t.today, timezone: "America/New_York" };
});
afterAll(async () => {
  await t.drop();
});

const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);
const newClient = (name: string, extra: Record<string, unknown> = {}) =>
  asA((q) => m.createClient(q, newClientSchema.parse({ businessName: name, ...extra }), ctx));
const say = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return toActionError(e);
  }
  return null;
};

describe("QA I-17: refusals are in words Isaac can act on", () => {
  it("a long note, a long business name: the limit, in plain words", () => {
    expect(
      say(() => noteSchema.parse({ clientId: crypto.randomUUID(), body: "x".repeat(5001) })),
    ).toBe("That's too long — the limit is 5,000 characters");
    expect(say(() => newClientSchema.parse({ businessName: "x".repeat(250) }))).toBe(
      "That's too long — the limit is 200 characters",
    );
  });

  it("an ask of $0 is refused before the database sees it", () => {
    const base = { clientId: crypto.randomUUID(), estApproval: "" };
    expect(say(() => askSchema.parse({ ...base, wantedAmount: "0" }))).toBe(
      "Enter an amount above $0",
    );
    expect(say(() => askSchema.parse({ ...base, wantedAmount: "50k" }))).toBeNull();
    expect(say(() => askSchema.parse({ ...base, wantedAmount: "" }))).toBeNull();
  });

  it("a database check that does fire explains itself by name", async () => {
    const c = await newClient("Check Me");
    const err = await asA((q) =>
      q.query("update client_asks set wanted_amount_cents = 0 where client_id = $1", [c.id]),
    ).catch((e: unknown) => e);
    // no ask row yet — insert one directly to trip the check
    expect(err).toBeDefined();
    const trip = await asA((q) =>
      q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents) select user_id, id, 0 from clients where id = $1",
        [c.id],
      ),
    ).catch((e: unknown) => e);
    expect(toActionError(trip)).toBe("Enter an amount above $0");
  });

  it("booking a call on a day that has gone says so about the CALL", async () => {
    const c = await newClient("Late Booker");
    const past = scheduleCallSchema.parse({
      clientId: c.id,
      at: `${addDays(ctx.today, -3)}T10:30`,
      note: "",
    });
    await expect(asA((q) => m.scheduleCall(q, past, ctx))).rejects.toThrow(
      "That call time has already passed — pick a time from now on",
    );
  });
});

describe("QA I-16: other advances can't contradict themselves", () => {
  const base = () => ({
    clientId: crypto.randomUUID(),
    positionNo: 2,
    fundedAmount: "",
    payback: "",
    balance: "",
    payment: "",
  });
  it("refuses a payback smaller than the advance", () => {
    expect(
      say(() => positionSchema.parse({ ...base(), fundedAmount: "20k", payback: "10k" })),
    ).toMatch(/payback is less than the advance/i);
  });
  it("refuses a balance bigger than the payback", () => {
    expect(say(() => positionSchema.parse({ ...base(), payback: "10k", balance: "50k" }))).toBe(
      "The balance can't be more than the payback",
    );
  });
  it("accepts a normal one, and one with only some of the numbers", () => {
    expect(
      say(() =>
        positionSchema.parse({ ...base(), fundedAmount: "20k", payback: "27k", balance: "9k" }),
      ),
    ).toBeNull();
    expect(say(() => positionSchema.parse({ ...base(), balance: "9k" }))).toBeNull();
  });
});

describe("QA I-15: the duplicate check can leave the merchant himself out", () => {
  it("editing Mike's phone to Cruz's number finds Cruz, never Mike", async () => {
    const mike = await newClient("Mike's Pizza", { phone: "(305) 555-0141" });
    const cruz = await newClient("Cruz Landscaping", { phone: "(305) 555-0142" });
    const parsed = duplicateCheckSchema.parse({
      phone: "305-555-0142",
      businessName: "Mike's Pizza",
      excludeId: mike.id,
    });
    const hits = await asA((q) => findDuplicates(q, parsed));
    expect(hits.map((h) => h.id)).toEqual([cruz.id]);
    // his own number never warns him about himself
    const self = await asA((q) =>
      findDuplicates(q, {
        phone: "305-555-0141",
        businessName: "Mike's Pizza",
        excludeId: mike.id,
      }),
    );
    expect(self).toEqual([]);
  });
});
