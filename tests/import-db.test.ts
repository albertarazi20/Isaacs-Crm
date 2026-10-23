import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importClients } from "@/lib/data/import";
import { importSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  b = await insertUser(t.pool, "other@x.com");
  ctx = { today: t.today, timezone: "America/New_York" };
});
afterAll(async () => {
  await t.drop();
});

const row = (over: Record<string, unknown>) => ({
  line: 2,
  businessName: "Biz",
  contactName: "",
  phone: "",
  email: "",
  wantedAmount: "",
  industry: "",
  state: "",
  notes: "",
  stage: "name_in",
  followUpOn: addDays(t.today, 1),
  statusNote: "",
  ...over,
});
const run = (user: string, rows: Record<string, unknown>[]) =>
  t.db.withUser(user, (q) => importClients(q, importSchema.parse({ rows }).rows, ctx));

describe("importing clients", () => {
  const rows = () => [
    row({
      line: 2,
      businessName: "Mike's Pizza",
      contactName: "Mike",
      phone: "+13055550001",
      wantedAmount: "50k",
      stage: "interested",
      followUpOn: addDays(t.today, 3),
      notes: "Wants it fast",
    }),
    row({
      line: 3,
      businessName: "Old Dead Deal",
      phone: "+13055550002",
      stage: "dead",
      followUpOn: addDays(t.today, 200),
      statusNote: "Imported status: Went silent",
    }),
    row({ line: 4, businessName: "No Phone Co" }),
  ];

  it("creates each client with its stage, ask, follow-up and note — in the database", async () => {
    const r = await run(a, rows());
    expect(r).toEqual({ created: 3, skippedExisting: 0, failed: [] });
    const { rows: cards } = await t.pool.query(
      "select business_name, stage, wanted_amount_cents, next_due_on::text, source from client_cards where user_id = $1 order by business_name",
      [a],
    );
    expect(cards).toEqual([
      {
        business_name: "Mike's Pizza",
        stage: "interested",
        wanted_amount_cents: 5_000_000,
        next_due_on: addDays(t.today, 3),
        source: "Imported",
      },
      {
        business_name: "No Phone Co",
        stage: "name_in",
        wanted_amount_cents: null,
        next_due_on: addDays(t.today, 1),
        source: "Imported",
      },
      {
        business_name: "Old Dead Deal",
        stage: "dead",
        wanted_amount_cents: null,
        next_due_on: addDays(t.today, 200),
        source: "Imported",
      },
    ]);
    const notes = await t.pool.query(
      "select c.business_name, a.body from activities a join clients c on c.id = a.client_id where a.kind = 'note' order by 1",
    );
    expect(notes.rows).toEqual([
      { business_name: "Mike's Pizza", body: "Wants it fast" },
      { business_name: "Old Dead Deal", body: "Imported status: Went silent" },
    ]);
  });
  it("importing the same file again creates nothing new", async () => {
    const r = await run(a, rows());
    expect(r).toEqual({ created: 0, skippedExisting: 3, failed: [] });
    expect(
      (await t.pool.query("select count(*)::int as n from clients where user_id = $1", [a])).rows[0]
        .n,
    ).toBe(3);
  });
  it("matches a phone-less row by business name, ignoring punctuation and case", async () => {
    const r = await run(a, [
      row({ businessName: "no phone co." }),
      row({ line: 3, businessName: "Brand New Phoneless" }),
    ]);
    expect(r).toMatchObject({ created: 1, skippedExisting: 1 });
  });
  it("skips a phone the user already has, however it was typed", async () => {
    await insertClient(t.db, b, "Existing Co");
    await t.pool.query(
      "update clients set phone = '(555) 123-4567' where business_name = 'Existing Co'",
    );
    const r = await run(b, [
      row({ businessName: "Dup", phone: "+15551234567" }),
      row({ line: 3, businessName: "Fresh", phone: "+15559998888" }),
    ]);
    expect(r).toMatchObject({ created: 1, skippedExisting: 1 });
  });
  it("reports a failing row and still imports the rest", async () => {
    const r = await run(a, [
      row({
        line: 2,
        businessName: "Too Far Co",
        phone: "+13055550010",
        followUpOn: addDays(t.today, 365 * 4),
      }),
      row({ line: 3, businessName: "Fine Co", phone: "+13055550011" }),
    ]);
    expect(r.created).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ line: 2 });
    expect(r.failed[0]?.message).toMatch(/36 months/);
    expect(
      (await t.pool.query("select 1 from clients where business_name in ('Too Far Co')")).rows,
    ).toEqual([]);
    expect(
      (await t.pool.query("select 1 from clients where business_name = 'Fine Co'")).rows,
    ).toHaveLength(1);
  });
  it("never imports a client as Funded without terms, and caps the batch", () => {
    expect(() => importSchema.parse({ rows: [row({ stage: "funded" })] })).toThrow(/terms/);
    expect(() => importSchema.parse({ rows: [] })).toThrow(/Nothing to import/);
    expect(() => importSchema.parse({ rows: Array.from({ length: 2001 }, () => row({})) })).toThrow(
      /2,000/,
    );
  });
  it("keeps each user's import to themselves", async () => {
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from clients where user_id = $1 and business_name = 'Mike''s Pizza'",
          [b],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
