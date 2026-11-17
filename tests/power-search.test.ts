import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientDirectory, type DirectoryRow } from "@/lib/data/overdue";
import { restoreClient, trashClient } from "@/lib/data/mutations";
import { callingYouLine, detailLine, searchDirectory } from "@/components/power/search";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const NOW = Date.parse("2026-10-23T15:00:00Z");

let seq = 0;
function row(over: Partial<DirectoryRow> & { business_name: string }): DirectoryRow {
  seq += 1;
  return {
    id: `id-${seq}`,
    dba: "",
    contact_name: "",
    phone: "",
    email: "",
    stage: "interested",
    contact_status: "ok",
    wanted_amount_cents: null,
    last_call_at: null,
    next_due_on: null,
    ...over,
  };
}

const mike = row({
  business_name: "Mike's Pizza",
  contact_name: "Mike Ross",
  phone: "(305) 555-0101",
  email: "mike@pizza.example",
  dba: "Pizza Kings",
  stage: "interested",
  wanted_amount_cents: 5_000_000,
  last_call_at: "2026-10-20T15:00:00Z",
});
const bella = row({
  business_name: "Bella Nails & Spa",
  contact_name: "Linh Tran",
  phone: "305-555-0102",
  email: "linh@bella.example",
});
const hart = row({
  business_name: "Hartman Trucking",
  contact_name: "Dave Hartman",
  phone: "2125550111",
});
const dup = row({
  business_name: "Mike's Pizza Annex",
  contact_name: "Mike Jr",
  phone: "+1 305 555 0101",
});
const ROWS = [bella, hart, mike, dup];
const ids = (r: DirectoryRow[]) => r.map((x) => x.business_name);

describe("search by phone digits", () => {
  it("typing 305555 finds every number containing it, however it was stored", () => {
    const r = searchDirectory(ROWS, "305555");
    expect(r.kind).toBe("phone");
    expect(ids(r.matches)).toEqual(["Bella Nails & Spa", "Mike's Pizza", "Mike's Pizza Annex"]);
    expect(r.calling).toEqual([]);
  });
  it("ignores punctuation in what was typed", () => {
    expect(ids(searchDirectory(ROWS, "(305) 555-01").matches)).toHaveLength(3);
    expect(ids(searchDirectory(ROWS, "555.0111").matches)).toEqual(["Hartman Trucking"]);
  });
  it("two digits is too short to be a phone search (it falls to text)", () => {
    expect(searchDirectory(ROWS, "30").kind).toBe("text");
  });
  it("a whole number answers 'who is calling?' with exactly the clients that own it", () => {
    for (const typed of [
      "(305) 555-0101",
      "305-555-0101",
      "3055550101",
      "+1 305 555 0101",
      "1-305-555-0101",
    ]) {
      const r = searchDirectory(ROWS, typed);
      expect(r.kind).toBe("number");
      expect(ids(r.calling)).toEqual(["Mike's Pizza", "Mike's Pizza Annex"]);
      expect(r.matches).toEqual([]);
    }
  });
  it("a whole number nobody owns finds nothing", () => {
    const r = searchDirectory(ROWS, "(212) 555-9999");
    expect(r.kind).toBe("number");
    expect(r.calling).toEqual([]);
  });
  it("a client with no phone is never a phone match", () => {
    const none = row({ business_name: "No Phone Co" });
    expect(searchDirectory([none], "305555").matches).toEqual([]);
    expect(searchDirectory([none], "3055550101").calling).toEqual([]);
  });
});

describe("search by text", () => {
  it("finds by business name, DBA, merchant and email", () => {
    expect(ids(searchDirectory(ROWS, "bella").matches)).toEqual(["Bella Nails & Spa"]);
    expect(ids(searchDirectory(ROWS, "kings").matches)).toEqual(["Mike's Pizza"]);
    expect(ids(searchDirectory(ROWS, "dave").matches)).toEqual(["Hartman Trucking"]);
    expect(ids(searchDirectory(ROWS, "linh@bella").matches)).toEqual(["Bella Nails & Spa"]);
  });
  it("is case-insensitive and ignores surrounding space", () => {
    expect(ids(searchDirectory(ROWS, "  HARTMAN  ").matches)).toEqual(["Hartman Trucking"]);
  });
  it("needs every word to match something, in any order", () => {
    expect(ids(searchDirectory(ROWS, "ross mike's").matches)).toEqual(["Mike's Pizza"]);
    expect(searchDirectory(ROWS, "mike trucking").matches).toEqual([]);
  });
  it("lets a word and some phone digits mix", () => {
    expect(ids(searchDirectory(ROWS, "pizza 0101").matches)).toEqual([
      "Mike's Pizza",
      "Mike's Pizza Annex",
    ]);
  });
  it("ranks a name that starts with the word above one that merely contains it", () => {
    const a = row({ business_name: "Spaghetti House" });
    const b = row({ business_name: "Bella Nails & Spa" });
    expect(ids(searchDirectory([b, a], "spa").matches)).toEqual([
      "Spaghetti House",
      "Bella Nails & Spa",
    ]);
  });
  it("puts a business-name hit above an email-only hit", () => {
    const named = row({ business_name: "Acme Roofing" });
    const mailed = row({ business_name: "Zed Co", email: "acme@zed.example" });
    expect(ids(searchDirectory([mailed, named], "acme").matches)).toEqual([
      "Acme Roofing",
      "Zed Co",
    ]);
  });
  it("returns nothing for gibberish and for an empty box", () => {
    expect(searchDirectory(ROWS, "qzxv").matches).toEqual([]);
    expect(searchDirectory(ROWS, "   ")).toEqual({ calling: [], matches: [], kind: "empty" });
  });
  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => row({ business_name: `Auto ${i}` }));
    expect(searchDirectory(many, "auto").matches).toHaveLength(8);
    expect(searchDirectory(many, "auto", 3).matches).toHaveLength(3);
  });
  it("is the same on every run (ties break by name, then id)", () => {
    const a = row({ business_name: "Same Name" });
    const b = row({ business_name: "Same Name" });
    const one = searchDirectory([b, a], "same").matches.map((r) => r.id);
    const two = searchDirectory([a, b], "same").matches.map((r) => r.id);
    expect(one).toEqual(two);
  });
});

describe("the 'Calling you' line", () => {
  it("says who, what business, the stage, the last call and what he wants", () => {
    expect(callingYouLine(mike, NOW)).toBe(
      "Calling you: Mike Ross, Mike's Pizza · Interested · last call 3 days ago · wants $50k",
    );
  });
  it("copes with a client nobody has called or priced", () => {
    expect(callingYouLine(bella, NOW)).toBe(
      "Calling you: Linh Tran, Bella Nails & Spa · Interested · never called",
    );
  });
  it("drops the dash when there is no merchant name", () => {
    expect(callingYouLine(row({ business_name: "Solo LLC", stage: "application_in" }), NOW)).toBe(
      "Calling you: Solo LLC · Application in · never called",
    );
  });
  it("the detail line shows merchant, DBA, formatted phone and stage", () => {
    expect(detailLine(mike)).toBe("Mike Ross · dba Pizza Kings · (305) 555-0101 · Interested");
    expect(detailLine(row({ business_name: "X", stage: "dead" }))).toBe("Not interested");
  });
});

describe("the client directory behind search and the inbound-call lookup", () => {
  let t: TestDb;
  let a: string;
  let b: string;
  const ids: Record<string, string> = {};

  async function seed(user: string, name: string, phone: string): Promise<string> {
    const { rows } = await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, phone) values ($1, $2, $3) returning id",
      [user, name, phone],
    );
    const id = rows[0]?.id as string;
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date + 1)",
      [user, id],
    );
    return id;
  }
  const names = async (user: string) =>
    (await t.db.withUser(user, (q) => clientDirectory(q))).map((r) => r.business_name);

  beforeAll(async () => {
    t = await createTestDb();
    a = await insertUser(t.pool, "isaac@x.com");
    b = await insertUser(t.pool, "other@x.com");
    ids.keep = await seed(a, "Keeper Pizza", "(305) 555-0111");
    ids.gone = await seed(a, "Trashed Tacos", "(305) 555-0222");
    ids.theirs = await seed(b, "Someone Else's Shop", "(305) 555-0333");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("lists this user's clients and nobody else's", async () => {
    expect(await names(a)).toEqual(
      ["Trashed Tacos", "Keeper Pizza"].sort((x, y) => x.localeCompare(y)),
    );
    expect(await names(b)).toEqual(["Someone Else's Shop"]);
  });

  it("a trashed merchant is gone from the directory: not searchable, and an inbound call from them finds nobody", async () => {
    await t.db.withUser(a, (q) => trashClient(q, ids.gone as string));
    // The row really is still in the database (it is in the trash, not purged)...
    const still = await t.pool.query("select 1 from clients where id = $1", [ids.gone]);
    expect(still.rowCount).toBe(1);
    // ...but the directory does not hand it to the palette.
    expect(await names(a)).toEqual(["Keeper Pizza"]);
    const rows = await t.db.withUser(a, (q) => clientDirectory(q));
    expect(searchDirectory(rows, "tacos").matches).toEqual([]);
    expect(searchDirectory(rows, "(305) 555-0222")).toMatchObject({ kind: "number", calling: [] });
    expect(searchDirectory(rows, "305555").matches.map((r) => r.business_name)).toEqual([
      "Keeper Pizza",
    ]);
  });

  it("restoring it from the trash brings it back", async () => {
    await t.db.withUser(a, (q) => restoreClient(q, ids.gone as string));
    expect(await names(a)).toContain("Trashed Tacos");
    const rows = await t.db.withUser(a, (q) => clientDirectory(q));
    expect(searchDirectory(rows, "(305) 555-0222").calling.map((r) => r.business_name)).toEqual([
      "Trashed Tacos",
    ]);
  });
});
