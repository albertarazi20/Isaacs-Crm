import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, buildBackup, type Backup } from "@/lib/export/backup";
import { checkBackup, RestoreError, restoreBackup } from "@/lib/export/restore";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let src: TestDb;
let dst: TestDb;
let srcUser: string;
let dstUser: string;
let backup: Backup;
const d = (n: number) => addDays(src.today, n);

beforeAll(async () => {
  src = await createTestDb();
  dst = await createTestDb();
  srcUser = await insertUser(src.pool, "isaac@x.com", "America/New_York");
  dstUser = await insertUser(dst.pool, "isaac-new@x.com", "America/New_York");

  const q = <T>(fn: (c: Parameters<Parameters<typeof src.db.withUser>[1]>[0]) => Promise<T>) =>
    src.db.withUser(srcUser, fn);

  // a merchant with a follow-up, a note and an ask
  const pizza = await insertClient(src.db, srcUser, "Application Pizza");
  await q(async (c) => {
    await c.query("select * from move_client($1, 'application_in', $2::jsonb)", [
      pizza,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]);
    await c.query(
      "insert into activities (user_id, client_id, kind, body) values (app.current_user_id(), $1, 'note', 'He said call after the 5th — “quoted” text, ünïcode')",
      [pizza],
    );
    await c.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms) values (app.current_user_id(), $1, 6000000, '6 months')",
      [pizza],
    );
  });

  // a second merchant, and a saved snippet
  await insertClient(src.db, srcUser, "Docs Deli");
  await q(async (c) => {
    await c.query(
      "insert into snippets (user_id, title, kind, body, sort) values (app.current_user_id(), 'Hi', 'text', 'Hi {first_name}', 0)",
    );
  });

  // a merchant in the trash: his closed timers must come back even though the flag blocks new timers
  const gone = await insertClient(src.db, srcUser, "Trashed Taqueria");
  await q((c) => c.query("select trash_client($1)", [gone]));

  backup = await src.db.withUser(srcUser, (c) => buildBackup(c));
  // round-trip through JSON exactly as the file would
  backup = JSON.parse(JSON.stringify(backup)) as Backup;
});
afterAll(async () => {
  await src.drop();
  await dst.drop();
});

const strip = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) => {
      const rest = { ...r };
      delete rest.user_id;
      return JSON.stringify(rest, Object.keys(rest).sort());
    })
    .sort();

describe("restoring a backup", () => {
  it("puts every table back exactly, under the new account", async () => {
    // the fixture really is rich: a trashed merchant, an ask and a snippet
    expect(backup.counts).toMatchObject({
      clients: 3,
      trashed_clients: 1,
      client_asks: 1,
      snippets: 1,
    });
    const client = await dst.pool.connect();
    try {
      await client.query("begin");
      const counts = await restoreBackup(client, backup, dstUser);
      await client.query("commit");
      for (const name of BACKUP_TABLES) expect(counts[name], name).toBe(backup.counts[name]);
    } finally {
      client.release();
    }
    // the destination database now holds the same rows (ignoring whose they are) — read back through the app role
    const again = await dst.db.withUser(dstUser, (c) => buildBackup(c));
    for (const name of BACKUP_TABLES) {
      expect(strip(again.tables[name] ?? []), name).toEqual(strip(backup.tables[name] ?? []));
      for (const row of again.tables[name] ?? []) expect(row.user_id, name).toBe(dstUser);
    }
    // the trashed merchant is still trashed, and the follow-up timer is still there
    expect(again.counts.trashed_clients).toBe(1);
    expect(again.tables.timers?.some((t) => t.kind === "follow_up" && t.done_at === null)).toBe(
      true,
    );
  });

  it("the restored account works: the merchants list and an edit behave normally", async () => {
    const r = await dst.pool.query<{ n: number }>(
      "select count(*)::int n from client_cards where user_id = $1",
      [dstUser],
    );
    // the trashed merchant is hidden from the card view, the other two are there
    expect(r.rows[0]?.n).toBe(2);
    await dst.db.withUser(dstUser, (c) =>
      c.query("select * from set_follow_up($1, $2)", [
        backup.tables.clients?.find((x) => x.business_name === "Application Pizza")?.id,
        addDays(dst.today, 30),
      ]),
    );
  });

  it("refuses to restore twice, or onto an account that already has merchants", async () => {
    const client = await dst.pool.connect();
    try {
      await expect(restoreBackup(client, backup, dstUser)).rejects.toThrow(/already has merchants/);
    } finally {
      client.release();
    }
  });

  it("refuses into a database that still holds the originals", async () => {
    const other = await insertUser(src.pool, "second@x.com", "UTC");
    const client = await src.pool.connect();
    try {
      await expect(restoreBackup(client, backup, other)).rejects.toThrow(/already exist/);
    } finally {
      client.release();
    }
  });

  it("refuses a file that is not a backup, or from another version", () => {
    expect(() => checkBackup({ hello: 1 })).toThrow(RestoreError);
    expect(() => checkBackup({ ...backup, version: 99 })).toThrow(/version 99/);
    const broken = { ...backup, tables: { ...backup.tables, snippets: undefined } };
    expect(() => checkBackup(broken)).toThrow(/missing its "snippets"/);
  });

  it("the app role can't call the restore function (it would write rows under anyone's id)", async () => {
    await expect(
      dst.db.withUser(dstUser, (c) => c.query("select app.restore_rows('snippets', '[]'::jsonb)")),
    ).rejects.toThrow(/permission denied/);
  });

  it("an unknown table name is refused by the function itself", async () => {
    await expect(
      dst.pool.query("select app.restore_rows('app_users', '[{}]'::jsonb)"),
    ).rejects.toThrow(/not a table a backup can restore into/);
  });
});
