import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCardMeta } from "@/lib/data/cardMeta";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * "Most active" on the Merchants list: CardMeta.active_at is the merchant's own last move (an open, a document they
 * sent, a signature, a reply), read from the DATABASE under the rep's row security. A rep's own touches do not count.
 */

let t: TestDb;
let rep: string;
let other: string;
const merchant = async (userId: string, name: string, phone: string) =>
  (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Sam Lee', $3, $4, 'FL') returning id",
      [userId, name, phone, `${phone}@shop.com`],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  other = await insertUser(t.pool, "other@x.com");
});
afterAll(async () => {
  await t.drop();
});

describe("the merchant's own last move", () => {
  it("is the newest of an open, a sent document and a signature; a rep's call is not the merchant's move", async () => {
    const opened = await merchant(rep, "Opened Co", "3055551001");
    await t.pool.query(
      "insert into link_opens (client_id, kind, opened_at) values ($1, 'upload', now() - interval '3 hours'), ($1, 'apply', now() - interval '2 days')",
      [opened],
    );
    const sent = await merchant(rep, "Sent Co", "3055551002");
    await t.pool.query(
      `insert into documents (client_id, user_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, created_at)
       values ($1, $2, 'bank_statement', 's.pdf', 'application/pdf', 10, repeat('b', 64), 'k/s2.pdf', 'upload_link', now() - interval '1 hour'),
              ($1, $2, 'voided_check', 'c.pdf', 'application/pdf', 10, repeat('c', 64), 'k/c2.pdf', 'staff', now())`,
      [sent, rep],
    );
    const called = await merchant(rep, "Called Co", "3055551003");
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body, outcome) values ($1, $2, 'call', 'Talked', 'reached')",
      [rep, called],
    );
    const theirs = await merchant(other, "Theirs Co", "3055551004");
    await t.pool.query(
      "insert into link_opens (client_id, kind, opened_at) values ($1, 'upload', now())",
      [theirs],
    );

    const meta = await t.db.withUser(rep, (q) => listCardMeta(q));
    const hoursAgo = (iso: string | null) => (Date.now() - new Date(iso!).getTime()) / 3_600_000;
    expect(hoursAgo(meta[opened]!.active_at)).toBeCloseTo(3, 0);
    // the staff upload just now is the rep's move; the merchant's own upload was an hour ago
    expect(hoursAgo(meta[sent]!.active_at)).toBeCloseTo(1, 0);
    expect(meta[called]!.active_at).toBeNull();
    // the list sorts these as text: an ISO string, never a Date object
    expect(typeof meta[opened]!.active_at).toBe("string");
    expect(meta[opened]!.active_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // another rep's merchant is not on this rep's list at all
    expect(meta[theirs]).toBeUndefined();
  });
});
