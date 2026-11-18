import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_TABLES,
  CLIENT_KEPT_TOKEN_COLUMN,
  CLIENT_SECRET_COLUMNS,
  buildBackup,
  type Backup,
} from "@/lib/export/backup";
import { restoreBackup } from "@/lib/export/restore";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let src: TestDb;
let dst: TestDb;
let srcUser: string;
let dstUser: string;
let backup: Backup;
let srcTokens: Record<string, string>[];

const tokens = async (t: TestDb, user: string) =>
  (
    await t.pool.query<Record<string, string>>(
      "select business_name, upload_token, application_token, unsubscribe_token from clients where user_id = $1 order by business_name",
      [user],
    )
  ).rows;

beforeAll(async () => {
  src = await createTestDb();
  dst = await createTestDb();
  srcUser = await insertUser(src.pool, "tokens@x.com", "UTC");
  dstUser = await insertUser(dst.pool, "tokens-new@x.com", "UTC");
  await insertClient(src.db, srcUser, "Token Pizza");
  await insertClient(src.db, srcUser, "Token Deli");
  srcTokens = await tokens(src, srcUser);
  backup = JSON.parse(
    JSON.stringify(await src.db.withUser(srcUser, (q) => buildBackup(q))),
  ) as Backup;
});
afterAll(async () => {
  await src.drop();
  await dst.drop();
});

const restoreInto = async (t: TestDb, file: unknown, user: string) => {
  const c = await t.pool.connect();
  try {
    await c.query("begin");
    const r = await restoreBackup(c, file, user);
    await c.query("commit");
    return r;
  } finally {
    c.release();
  }
};

describe("a backup file holds no document or application tokens, but keeps the unsubscribe token", () => {
  it("has real tokens in the database; the file carries only each merchant's unsubscribe token", () => {
    expect(srcTokens).toHaveLength(2);
    const text = JSON.stringify(backup);
    for (const row of srcTokens)
      for (const col of CLIENT_SECRET_COLUMNS) {
        expect(row[col]?.length, col).toBeGreaterThanOrEqual(32);
        expect(text).not.toContain(row[col]);
      }
    for (const row of backup.tables.clients ?? [])
      for (const col of CLIENT_SECRET_COLUMNS) expect(row, col).not.toHaveProperty(col);
    expect(CLIENT_SECRET_COLUMNS).toEqual(["upload_token", "application_token"]);
    expect(CLIENT_KEPT_TOKEN_COLUMN).toBe("unsubscribe_token");
    const inFile = (backup.tables.clients ?? []).map((r) => r.unsubscribe_token).sort();
    expect(inFile).toEqual(srcTokens.map((r) => r.unsubscribe_token).sort());
  });

  it("restores into a fresh account: the unsubscribe tokens survive, upload and application tokens are new", async () => {
    const counts = await restoreInto(dst, backup, dstUser);
    for (const name of BACKUP_TABLES) expect(counts[name], name).toBe(backup.counts[name]);
    // read back from the restored database, not from the file
    const after = await tokens(dst, dstUser);
    expect(after.map((r) => r.business_name)).toEqual(srcTokens.map((r) => r.business_name));
    for (const [i, row] of after.entries()) {
      expect(row.unsubscribe_token, "unsubscribe_token").toBe(srcTokens[i]?.unsubscribe_token);
      for (const col of CLIENT_SECRET_COLUMNS) {
        expect(row[col]?.length, col).toBeGreaterThanOrEqual(32);
        expect(row[col], col).not.toBe(srcTokens[i]?.[col]);
      }
    }
  });

  it("an old backup that still carries all three tokens restores: upload and application are not reused, unsubscribe is", async () => {
    const other = await insertUser(dst.pool, "old-file@x.com", "UTC");
    // the file shape from before the tokens were left out: every client row has all three, with known values
    const old = JSON.parse(JSON.stringify(backup)) as Backup;
    old.tables.clients = (old.tables.clients ?? []).map((r, i) => ({
      ...r,
      upload_token: `oldupload${i}`.padEnd(40, "u"),
      application_token: `oldapplication${i}`.padEnd(40, "a"),
      unsubscribe_token: `oldunsub${i}`.padEnd(40, "s"),
    }));
    // new ids so they do not clash with the first restore (ids are kept on restore)
    old.tables.clients = old.tables.clients.map((r, i) => ({
      ...r,
      id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    }));
    for (const name of ["trashed_clients", "client_asks", "stips", "timers", "activities"])
      old.tables[name] = [];
    old.counts = Object.fromEntries(Object.entries(old.tables).map(([k, v]) => [k, v.length]));
    await restoreInto(dst, old, other);
    const rows = await tokens(dst, other);
    expect(rows).toHaveLength(2);
    for (const row of rows)
      for (const col of CLIENT_SECRET_COLUMNS) {
        expect(row[col]).not.toMatch(/^old(upload|application)/);
        expect(row[col]?.length, col).toBeGreaterThanOrEqual(32);
      }
    expect(rows.map((r) => r.unsubscribe_token).sort()).toEqual(
      [0, 1].map((i) => `oldunsub${i}`.padEnd(40, "s")),
    );
  });

  it("a backup made without unsubscribe tokens (earlier on the day this changed) still restores, with new ones", async () => {
    const other = await insertUser(dst.pool, "no-unsub@x.com", "UTC");
    const bare = JSON.parse(JSON.stringify(backup)) as Backup;
    bare.tables.clients = (bare.tables.clients ?? []).map((r, i) => {
      const rest: Record<string, unknown> = {
        ...r,
        id: `00000000-0000-4000-8000-00000000010${i + 1}`,
      };
      delete rest.unsubscribe_token;
      return rest;
    });
    for (const name of ["trashed_clients", "client_asks", "stips", "timers", "activities"])
      bare.tables[name] = [];
    bare.counts = Object.fromEntries(Object.entries(bare.tables).map(([k, v]) => [k, v.length]));
    await restoreInto(dst, bare, other);
    const rows = await tokens(dst, other);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.unsubscribe_token?.length).toBeGreaterThanOrEqual(32);
      expect(srcTokens.map((r) => r.unsubscribe_token)).not.toContain(row.unsubscribe_token);
    }
  });

  it("a file where only some merchants have a usable unsubscribe token still restores, all with defaults", async () => {
    const other = await insertUser(dst.pool, "mixed-unsub@x.com", "UTC");
    const mixed = JSON.parse(JSON.stringify(backup)) as Backup;
    mixed.tables.clients = (mixed.tables.clients ?? []).map((r, i) => ({
      ...r,
      id: `00000000-0000-4000-8000-00000000020${i + 1}`,
      unsubscribe_token: i === 0 ? r.unsubscribe_token : null,
    }));
    for (const name of ["trashed_clients", "client_asks", "stips", "timers", "activities"])
      mixed.tables[name] = [];
    mixed.counts = Object.fromEntries(Object.entries(mixed.tables).map(([k, v]) => [k, v.length]));
    await restoreInto(dst, mixed, other);
    const rows = await tokens(dst, other);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.unsubscribe_token?.length).toBeGreaterThanOrEqual(32);
  });
});
