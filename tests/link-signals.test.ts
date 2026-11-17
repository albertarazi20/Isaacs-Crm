import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRecommendationFacts } from "@/lib/assistant/recommendations";
import { monthOf } from "@/lib/dashboard/queries";
import { loadOverview } from "@/lib/followup/overview";
import { recordLinkOpen } from "@/lib/system/linkSignals";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Hot signals (0547): a merchant who opens their upload link or application and does not finish. Recorded by token,
 * de-duplicated, private to whoever can see the merchant, shown second in "do this now", and gone the moment the
 * merchant finishes. Every claim is read from the DATABASE.
 */

let t: TestDb;
let rep: string;
let other: string;
let merchant: string;
let tokens: { upload_token: string; application_token: string };

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;
const opens = async (id: string) =>
  (await one<{ n: number }>("select count(*)::int as n from link_opens where client_id = $1", [
    id,
  ]))!.n;
const queue = async (userId: string) =>
  (
    await t.db.withUser(userId, (q) =>
      loadOverview(q, { today: t.today, month: monthOf(t.today), manager: false }),
    )
  ).queue;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  other = await insertUser(t.pool, "other@x.com");
  merchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Warm Tacos', 'Rosa', '3055550111', 'rosa@warm.com', 'FL') returning id",
    [rep],
  ))!.id;
  tokens = (await one<{ upload_token: string; application_token: string }>(
    "select upload_token, application_token from clients where id = $1",
    [merchant],
  ))!;
});
afterAll(async () => {
  await t.drop();
});

describe("recording an open", () => {
  it("records the merchant's open once per half hour, with one timeline line, and nothing for an unknown token", async () => {
    expect(await recordLinkOpen(t.db, "upload", tokens.upload_token)).toBe(true);
    expect(await recordLinkOpen(t.db, "upload", tokens.upload_token)).toBe(false);
    expect(await opens(merchant)).toBe(1);
    expect(await recordLinkOpen(t.db, "upload", "x".repeat(30))).toBe(false);
    expect(await recordLinkOpen(t.db, "apply", "not-hex")).toBe(false);
    const lines = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' and body like 'Opened%'",
      [merchant],
    );
    expect(lines.rows.map((r) => r.body)).toEqual(["Opened the upload link"]);
  });

  it("is readable by the merchant's rep and not by another rep", async () => {
    const mine = await t.db.withUser(rep, (q) => q.query("select * from link_opens"));
    const theirs = await t.db.withUser(other, (q) => q.query("select * from link_opens"));
    expect(mine.rows).toHaveLength(1);
    expect(theirs.rows).toHaveLength(0);
  });
});

describe("the signal", () => {
  it("puts the merchant second in 'do this now' and counts them for the recommendation, until they finish", async () => {
    const before = await queue(rep);
    expect(before.find((x) => x.clientId === merchant)).toMatchObject({
      kind: "opened",
      detail: "Opened the upload link, nothing sent yet",
    });
    const facts = await t.db.withUser(rep, (q) =>
      loadRecommendationFacts(q, { today: t.today, manager: false, gmailConnected: true }),
    );
    expect(facts.queue.opened).toBe(1);

    // a document arrives after the open: the signal is gone
    await t.pool.query(
      `insert into documents (client_id, user_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
       values ($1, $2, 'bank_statement', 's.pdf', 'application/pdf', 10, repeat('a', 64), 'k/s.pdf', 'upload_link')`,
      [merchant, rep],
    );
    const after = await queue(rep);
    expect(after.find((x) => x.clientId === merchant && x.kind === "opened")).toBeUndefined();
    const facts2 = await t.db.withUser(rep, (q) =>
      loadRecommendationFacts(q, { today: t.today, manager: false, gmailConnected: true }),
    );
    expect(facts2.queue.opened).toBe(0);
  });

  it("opening the application counts too, and a handed-off merchant records nothing", async () => {
    expect(await recordLinkOpen(t.db, "apply", tokens.application_token)).toBe(true);
    const q1 = await queue(rep);
    expect(q1.find((x) => x.clientId === merchant)).toMatchObject({
      kind: "opened",
      detail: "Opened the application, not signed yet",
    });
    await t.pool.query("update clients set brought_in_at = now() where id = $1", [merchant]);
    await t.pool.query("delete from link_opens where client_id = $1", [merchant]);
    expect(await recordLinkOpen(t.db, "apply", tokens.application_token)).toBe(false);
    expect(await opens(merchant)).toBe(0);
  });
});
