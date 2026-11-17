import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailboxSyncStatus } from "@/lib/inbox/sync";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let manager: string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query("update app_users set name = 'Josh' where id = $1", [rep]);
});
afterAll(async () => {
  await t.drop();
});

describe("last synced per mailbox", () => {
  it("lists each connected mailbox with its last sync, its cursor and its last error; a rep sees their own", async () => {
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true), ($2, 'josh@gmail.com', 'enc', false)",
      [manager, rep],
    );
    await t.pool.query(
      "insert into mail_sync_state (user_id, history_id, last_synced_at, messages_seen) values ($1, '123', now() - interval '5 minutes', 42)",
      [manager],
    );
    await t.pool.query(
      "insert into mail_sync_state (user_id, last_error) values ($1, 'Gmail needs to be reconnected')",
      [rep],
    );
    const rows = await t.db.withUser(manager, mailboxSyncStatus);
    expect(
      rows.map((r) => [
        r.name,
        r.can_read_mail,
        r.has_cursor,
        r.messages_seen,
        r.last_error,
        r.last_synced_at !== null,
      ]),
    ).toEqual([
      ["Boss", true, true, 42, null, true],
      ["Josh", false, false, 0, "Gmail needs to be reconnected", false],
    ]);
    const mine = await t.db.withUser(rep, mailboxSyncStatus);
    expect(mine.map((r) => r.name)).toEqual(["Josh"]);
  });
});
