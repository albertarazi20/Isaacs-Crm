import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import { listSources } from "@/lib/data/queries";
import { newClientSchema } from "@/lib/data/schemas";
import { DEFAULT_SOURCES, mergeSources } from "@/lib/data/sources";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

describe("mergeSources", () => {
  it("offers the starters when he has no sources yet", () => {
    expect(mergeSources([])).toEqual([...DEFAULT_SOURCES]);
  });
  it("puts his own sources first, in the order given, and drops starters he already uses", () => {
    const out = mergeSources(["Lead vendor Oct", "referral"]);
    expect(out.slice(0, 2)).toEqual(["Lead vendor Oct", "referral"]);
    expect(out.filter((s) => s.toLowerCase() === "referral")).toEqual(["referral"]);
    expect(out).toContain("Cold call");
  });
  it("tidies spacing and ignores blanks", () => {
    expect(mergeSources(["  Lead   vendor ", "", "   "])[0]).toBe("Lead vendor");
  });
});

describe("listSources", () => {
  let t: TestDb;
  let a: string;
  let b: string;
  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com");
    b = await insertUser(t.pool, "other@x.com");
    const ctx = { today: t.today, timezone: "UTC" };
    const add = (user: string, name: string, source: string) =>
      t.db.withUser(user, (q) =>
        m.createClient(q, newClientSchema.parse({ businessName: name, source }), ctx),
      );
    await add(a, "One", "Lead vendor");
    await add(a, "Two", "lead vendor");
    await add(a, "Three", "Lead vendor");
    await add(a, "Four", "Referral");
    await add(a, "Five", "");
    await add(a, "Six", "Imported");
    const trashed = await add(a, "Seven", "Trash only source");
    await t.db.withUser(a, (q) => m.trashClient(q, trashed.id));
    await add(b, "Other", "Someone else's source");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("lists sources most used first, one per spelling, without blanks, 'Imported', trash or other users", async () => {
    const out = await t.db.withUser(a, (q) => listSources(q));
    expect(out).toHaveLength(2);
    expect(out[0]?.toLowerCase()).toBe("lead vendor");
    expect(out[1]).toBe("Referral");
  });
});
