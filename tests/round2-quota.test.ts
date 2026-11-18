import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertEmailQuota } from "@/lib/data/mutations";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let other: string;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "quota-rep@example.com");
  other = await insertUser(t.pool, "quota-other@example.com");
  client = await insertClient(t.db, rep, "Quota Co");
});
afterAll(async () => {
  await t.drop();
});

/** What the outbox worker writes for an automated send: an outbox row, then an email activity with the same words. */
async function automatedSend(subject: string, body: string) {
  await t.pool.query(
    `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at)
     values ($1, $2, 'sequence', 'bucket:x:step:1', 'a@example.com', $3, $4, 'sent', now())`,
    [rep, client, subject, body],
  );
  await t.pool.query(
    "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', $3)",
    [rep, client, `${subject}\n\n${body}`],
  );
}

describe("the daily manual email quota", () => {
  it("is not used up by the automated mail the outbox worker records", async () => {
    for (let i = 0; i < 5; i += 1) await automatedSend(`Step ${i}`, `Hello ${i}`);
    // five automated activities and a limit of 1: still room, because none of them was sent by hand
    await t.db.withUser(rep, (q) => assertEmailQuota(q, 1));
    const n = await t.pool.query(
      "select count(*)::int as n from activities where kind = 'email' and user_id = $1",
      [rep],
    );
    expect(n.rows[0]?.n).toBe(5);
  });
  it("still counts what the rep sent by hand, and only that rep's", async () => {
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'Hand written')",
      [rep, client],
    );
    await expect(t.db.withUser(rep, (q) => assertEmailQuota(q, 1))).rejects.toThrow(
      /Daily email limit/,
    );
    await t.db.withUser(rep, (q) => assertEmailQuota(q, 2));
    // another rep has sent nothing
    await t.db.withUser(other, (q) => assertEmailQuota(q, 1));
  });
  it("counts a hand-sent mail whose words match an old automated one", async () => {
    // same words, but the outbox row was sent days ago: this activity is a new manual send
    await t.pool.query(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at)
       values ($1, $2, 'sequence', 'x', 'a@example.com', 'Old', 'Body', 'sent', now() - interval '3 days')`,
      [rep, client],
    );
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', $3)",
      [rep, client, "Old\n\nBody"],
    );
    await expect(t.db.withUser(rep, (q) => assertEmailQuota(q, 2))).rejects.toThrow(
      /Daily email limit/,
    );
  });
});
