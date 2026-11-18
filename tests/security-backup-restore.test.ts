import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, buildBackup, type Backup } from "@/lib/export/backup";
import {
  encryptBackup,
  PassphraseRequired,
  readBackupFile,
  type EncryptedBackup,
} from "@/lib/export/backupCrypto";
import { RestoreError, restoreBackup } from "@/lib/export/restore";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

// The encrypted backup against real databases: what is read back from the restored database is compared with what
// was in the source database, and a refused file is shown to have left the target database exactly as it was.

const run = promisify(execFile);
const PASS = "a long passphrase for the test";
const EMAIL = "isaac@x.com";
const WRONG = /Wrong passphrase, or the file has been changed/;

let src: TestDb;
let viaLib: TestDb;
let viaCli: TestDb;
let viaPlain: TestDb;
let srcUser: string;
let libUser: string;
let cliUser: string;
let plainUser: string;
let backup: Backup;
let plainText: string;
let encText: string;
let dir: string;

const strip = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) => {
      const rest = { ...r };
      delete rest.user_id;
      return JSON.stringify(rest, Object.keys(rest).sort());
    })
    .sort();

/** Rows each backup table holds for a user, straight from the database (not through the backup code). */
async function counts(t: TestDb, user: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    const { rows } = await t.pool.query<{ n: number }>(
      `select count(*)::int as n from ${name} where user_id = $1`,
      [user],
    );
    out[name] = rows[0]?.n ?? 0;
  }
  return out;
}
const EMPTY = Object.fromEntries(BACKUP_TABLES.map((n) => [n, 0]));

/** Restores the way the operator script does: read the file (decrypting), then one transaction. */
async function restoreFile(t: TestDb, user: string, text: string, passphrase?: string) {
  const parsed = await readBackupFile(text, passphrase);
  const client = await t.pool.connect();
  try {
    await client.query("begin");
    const out = await restoreBackup(client, parsed, user);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const urlOf = (t: TestDb) =>
  (t.pool as unknown as { options: { connectionString: string } }).options.connectionString;

beforeAll(async () => {
  [src, viaLib, viaCli, viaPlain] = await Promise.all([
    createTestDb(),
    createTestDb(),
    createTestDb(),
    createTestDb(),
  ]);
  srcUser = await insertUser(src.pool, EMAIL, "America/New_York");
  libUser = await insertUser(viaLib.pool, EMAIL, "America/New_York");
  cliUser = await insertUser(viaCli.pool, EMAIL, "America/New_York");
  plainUser = await insertUser(viaPlain.pool, EMAIL, "America/New_York");
  dir = await mkdtemp(join(tmpdir(), "backup-enc-"));

  const d = (n: number) => addDays(src.today, n);
  const pizza = await insertClient(src.db, srcUser, "Application Pizza");
  await src.db.withUser(srcUser, async (c) => {
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
    await c.query(
      "insert into snippets (user_id, title, kind, body, sort) values (app.current_user_id(), 'Hi', 'text', 'Hi {first_name}', 0)",
    );
  });
  await insertClient(src.db, srcUser, "Docs Deli");
  const gone = await insertClient(src.db, srcUser, "Trashed Taqueria");
  await src.db.withUser(srcUser, (c) => c.query("select trash_client($1)", [gone]));

  backup = await src.db.withUser(srcUser, (c) => buildBackup(c));
  plainText = JSON.stringify(backup);
  encText = await encryptBackup(plainText, PASS);
}, 120_000);

afterAll(async () => {
  await Promise.all([src.drop(), viaLib.drop(), viaCli.drop(), viaPlain.drop()]);
  await rm(dir, { recursive: true, force: true });
});

describe("an encrypted backup restores the same database", () => {
  it("the fixture is rich, and the encrypted file holds none of it in the clear", () => {
    expect(backup.counts).toMatchObject({
      clients: 3,
      trashed_clients: 1,
      client_asks: 1,
      snippets: 1,
    });
    expect(backup.counts.activities).toBeGreaterThan(0);
    for (const name of ["Application Pizza", "Docs Deli", "Trashed Taqueria", "call after the 5th"])
      expect(encText).not.toContain(name);
  });

  it("a wrong passphrase leaves the database exactly as it was: nothing restored", async () => {
    expect(await counts(viaLib, libUser)).toEqual(EMPTY);
    await expect(restoreFile(viaLib, libUser, encText, "not the right passphrase")).rejects.toThrow(
      WRONG,
    );
    await expect(restoreFile(viaLib, libUser, encText)).rejects.toBeInstanceOf(PassphraseRequired);
    expect(await counts(viaLib, libUser)).toEqual(EMPTY);
  });

  it("a tampered file is refused and leaves the database as it was", async () => {
    const env = JSON.parse(encText) as EncryptedBackup;
    const bytes = Buffer.from(env.ciphertext, "base64");
    const mid = bytes.length >> 1;
    bytes[mid] = (bytes[mid] ?? 0) ^ 0xff;
    const flipped = JSON.stringify({ ...env, ciphertext: bytes.toString("base64") });
    const truncated = JSON.stringify({
      ...env,
      ciphertext: Buffer.from(env.ciphertext, "base64").subarray(0, 100).toString("base64"),
    });
    for (const bad of [flipped, truncated, encText.slice(0, -5)])
      await expect(restoreFile(viaLib, libUser, bad, PASS)).rejects.toThrow(RestoreError);
    expect(await counts(viaLib, libUser)).toEqual(EMPTY);
  });

  it("the right passphrase restores every table, row for row, as read back from the database", async () => {
    // after all those refusals the same account restores cleanly: they left no half-done state in the way
    const restored = await restoreFile(viaLib, libUser, encText, PASS);
    for (const name of BACKUP_TABLES) expect(restored[name], name).toBe(backup.counts[name]);
    expect(await counts(viaLib, libUser)).toEqual(backup.counts);

    const again = await viaLib.db.withUser(libUser, (c) => buildBackup(c));
    for (const name of BACKUP_TABLES) {
      expect(strip(again.tables[name] ?? []), name).toEqual(strip(backup.tables[name] ?? []));
      for (const row of again.tables[name] ?? []) expect(row.user_id, name).toBe(libUser);
    }
    // the trashed merchant is still trashed, the follow-up timer is still open
    expect(again.counts.trashed_clients).toBe(1);
    expect(again.tables.timers?.some((t) => t.kind === "follow_up" && t.done_at === null)).toBe(
      true,
    );
  });
});

describe("a plain backup still restores", () => {
  it("restores row for row, with no passphrase, and ignores one if offered", async () => {
    const restored = await restoreFile(viaPlain, plainUser, plainText);
    for (const name of BACKUP_TABLES) expect(restored[name], name).toBe(backup.counts[name]);
    const again = await viaPlain.db.withUser(plainUser, (c) => buildBackup(c));
    for (const name of BACKUP_TABLES)
      expect(strip(again.tables[name] ?? []), name).toEqual(strip(backup.tables[name] ?? []));
    // an already-restored account is refused as before; the passphrase argument changes nothing
    await expect(restoreFile(viaPlain, plainUser, plainText, "unused passphrase")).rejects.toThrow(
      /already has merchants/,
    );
  });
});

describe("the operator script (scripts/restore-backup.ts), run for real", () => {
  const script = join(process.cwd(), "scripts", "restore-backup.ts");
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const cli = (file: string, env: Record<string, string>) =>
    run(tsx, [script, file, EMAIL], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATABASE_URL: urlOf(viaCli), ...env },
      timeout: 60_000,
    }).then(
      (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: e.code ?? 1,
        out: e.stdout ?? "",
        err: e.stderr ?? "",
      }),
    );
  let file: string;
  beforeAll(async () => {
    file = join(dir, "isaac-backup-test.enc.json");
    await writeFile(file, encText);
  });

  it("a wrong passphrase exits non-zero with a clear message and writes nothing", async () => {
    const r = await cli(file, { BACKUP_PASSPHRASE: "definitely the wrong one" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(WRONG);
    expect(r.err).not.toContain("definitely the wrong one");
    expect(await counts(viaCli, cliUser)).toEqual(EMPTY);
  }, 90_000);

  it("an encrypted file with no passphrase and no terminal is refused, and writes nothing", async () => {
    const r = await cli(file, {});
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/encrypted/);
    expect(await counts(viaCli, cliUser)).toEqual(EMPTY);
  }, 90_000);

  it("the right passphrase restores the database, and the rows read back match the backup", async () => {
    const r = await cli(file, { BACKUP_PASSPHRASE: PASS });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Restored:");
    expect(await counts(viaCli, cliUser)).toEqual(backup.counts);
    const again = await viaCli.db.withUser(cliUser, (c) => buildBackup(c));
    for (const name of BACKUP_TABLES)
      expect(strip(again.tables[name] ?? []), name).toEqual(strip(backup.tables[name] ?? []));
  }, 90_000);
});
