import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { followupCsv } from "@/lib/export/followup";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The lead lines the Follow Up tools are built on, read back from the DATABASE: every bucket's people with the bucket
 * they are in and what they asked us not to do, a rep seeing only their own, a merchant in one bucket at a time (a
 * move takes them out of the old one), trashed merchants gone, and the spreadsheet leaving out do-not-contact.
 */

let t: TestDb;
let rita: string;
let omar: string;
let boss: string;
let applicationBucket: string;
let statementsBucket: string;
let queries: typeof import("@/lib/buckets/queries");
let db: typeof import("@/lib/db").db;

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;

async function merchant(owner: string, name: string, phone: string, status = "ok") {
  const row = await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state, contact_status) values ($1, $2, 'Contact', $3, $4, 'FL', $5) returning id",
    [owner, name, phone, `${name.toLowerCase().replace(/\W/g, "")}@example.com`, status],
  );
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  rita = await insertUser(t.pool, "rita@x.com");
  omar = await insertUser(t.pool, "omar@x.com");
  boss = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Pat Boss' where id = $1", [
    boss,
  ]);
  applicationBucket = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_app'",
  ))!.id;
  statementsBucket = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_statements'",
  ))!.id;
  queries = await import("@/lib/buckets/queries");
  db = (await import("@/lib/db")).db;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the lead lines", () => {
  let alpha: string;
  let bravo: string;
  let charlie: string;
  let delta: string;

  beforeAll(async () => {
    alpha = await merchant(rita, "Alpha Tacos", "+13055550101");
    bravo = await merchant(rita, "Bravo Bakery", "+13055550102", "no_text");
    charlie = await merchant(rita, "Charlie Cafe", "+13055550103", "dnc");
    delta = await merchant(omar, "Delta Diner", "+13055550104");
    for (const [c, b] of [
      [alpha, applicationBucket],
      [bravo, applicationBucket],
      [charlie, statementsBucket],
      [delta, statementsBucket],
    ] as const)
      await t.pool.query("select enroll_in_bucket($1, $2)", [c, b]);
  });

  it("carries the bucket and what the merchant asked us not to do", async () => {
    const inApplication = await db.withUser(boss, (q) =>
      queries.listBucketMembers(q, applicationBucket),
    );
    expect(inApplication.map((m) => m.business_name).sort()).toEqual([
      "Alpha Tacos",
      "Bravo Bakery",
    ]);
    const bravoRow = inApplication.find((m) => m.client_id === bravo)!;
    expect(bravoRow).toMatchObject({
      contact_status: "no_text",
      bucket_id: applicationBucket,
      bucket_name: "Missing application",
      phone: "+13055550102",
    });
  });

  it("lists everyone in every bucket, one line a merchant, buckets in order", async () => {
    const all = await db.withUser(boss, (q) => queries.listAllMembers(q));
    expect(all.map((m) => [m.bucket_name, m.business_name])).toEqual([
      ["Missing application", "Alpha Tacos"],
      ["Missing application", "Bravo Bakery"],
      ["Missing statements", "Charlie Cafe"],
      ["Missing statements", "Delta Diner"],
    ]);
  });

  it("shows a rep only their own merchants", async () => {
    const mine = await db.withUser(rita, (q) => queries.listAllMembers(q));
    expect(mine.map((m) => m.business_name).sort()).toEqual([
      "Alpha Tacos",
      "Bravo Bakery",
      "Charlie Cafe",
    ]);
    const omars = await db.withUser(omar, (q) => queries.listAllMembers(q));
    expect(omars.map((m) => m.business_name)).toEqual(["Delta Diner"]);
  });

  it("puts a merchant in one bucket at a time: a move takes them out of the old one", async () => {
    await t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [alpha, statementsBucket]);
    const live = await one<{ n: number }>(
      "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
      [alpha],
    );
    expect(live!.n).toBe(1);
    const all = await db.withUser(boss, (q) => queries.listAllMembers(q));
    expect(all.filter((m) => m.client_id === alpha)).toHaveLength(1);
    expect(all.find((m) => m.client_id === alpha)!.bucket_name).toBe("Missing statements");
    // and back, for the tests below
    await t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [alpha, applicationBucket]);
  });

  it("leaves a trashed merchant out", async () => {
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      delta,
      omar,
    ]);
    const all = await db.withUser(boss, (q) => queries.listAllMembers(q));
    expect(all.map((m) => m.business_name)).not.toContain("Delta Diner");
    await t.pool.query("delete from trashed_clients where client_id = $1", [delta]);
  });

  it("makes a spreadsheet of a bucket that leaves out do-not-contact and counts them", async () => {
    const members = await db.withUser(boss, (q) => queries.listBucketMembers(q, statementsBucket));
    const { csv, left } = followupCsv(members);
    expect(left).toBe(1); // Charlie asked not to be contacted at all
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(2); // the header and Delta
    expect(lines[1]).toContain("Delta Diner");
    expect(lines[1]).toContain(",(305) 555-0104,+13055550104,");
    expect(csv).not.toContain("Charlie");
  });
});
