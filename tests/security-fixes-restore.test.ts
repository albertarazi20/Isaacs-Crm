import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBackup } from "@/lib/export/backup";
import { encryptBackup } from "@/lib/export/backupCrypto";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * The restore script's guard against a downgrade: --require-encrypted refuses a plain file (before the database is
 * touched), and restoring a plain file without it prints a loud warning. Run for real, rows read back from the databases.
 */

const run = promisify(execFile);
const PASS = "a long passphrase for the test";
const EMAIL = "isaac@x.com";
const script = join(process.cwd(), "scripts", "restore-backup.ts");
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");

let src: TestDb;
let target: TestDb;
let dir: string;
let plainFile: string;
let encFile: string;
let targetUser: string;
let merchants: number;

const urlOf = (t: TestDb) =>
  (t.pool as unknown as { options: { connectionString: string } }).options.connectionString;
const clientsIn = async (t: TestDb, user: string) =>
  (
    await t.pool.query<{ n: number }>("select count(*)::int as n from clients where user_id = $1", [
      user,
    ])
  ).rows[0]!.n;

const cli = (args: string[], env: Record<string, string> = {}) =>
  run(tsx, [script, ...args], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATABASE_URL: urlOf(target), ...env },
    timeout: 60_000,
  }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      out: e.stdout ?? "",
      err: e.stderr ?? "",
    }),
  );

beforeAll(async () => {
  [src, target] = await Promise.all([createTestDb(), createTestDb()]);
  const srcUser = await insertUser(src.pool, EMAIL);
  targetUser = await insertUser(target.pool, EMAIL);
  await insertClient(src.db, srcUser, "Backup Bakery");
  await insertClient(src.db, srcUser, "Backup Barbers");
  const backup = await src.db.withUser(srcUser, (c) => buildBackup(c));
  merchants = backup.counts.clients ?? 0;
  expect(merchants).toBe(2);
  dir = await mkdtemp(join(tmpdir(), "restore-guard-"));
  plainFile = join(dir, "isaac-backup-test.json");
  encFile = join(dir, "isaac-backup-test.enc.json");
  await writeFile(plainFile, JSON.stringify(backup));
  await writeFile(encFile, await encryptBackup(JSON.stringify(backup), PASS));
}, 120_000);

afterAll(async () => {
  await Promise.all([src.drop(), target.drop()]);
  await rm(dir, { recursive: true, force: true });
});

describe("--require-encrypted", () => {
  it("refuses a plain file with a clear message and writes nothing", async () => {
    const r = await cli([plainFile, EMAIL, "--require-encrypted"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not encrypted/i);
    expect(r.err).toContain("--require-encrypted");
    expect(r.out).not.toContain("Restoring");
    expect(await clientsIn(target, targetUser)).toBe(0);
  }, 90_000);

  it("refuses a plain file even when the flag comes first, and a file that is not a backup at all", async () => {
    const junk = join(dir, "not-a-backup.json");
    await writeFile(junk, "this is not json");
    for (const args of [
      ["--require-encrypted", plainFile, EMAIL],
      [junk, EMAIL, "--require-encrypted"],
    ]) {
      const r = await cli(args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/not encrypted/i);
    }
    expect(await clientsIn(target, targetUser)).toBe(0);
  }, 90_000);

  it("is refused before the database is even reached", async () => {
    const r = await cli([plainFile, EMAIL, "--require-encrypted"], {
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not encrypted/i);
  }, 90_000);

  it("lets an encrypted file through: the rows are restored and read back from the database", async () => {
    const r = await cli([encFile, EMAIL, "--require-encrypted"], { BACKUP_PASSPHRASE: PASS });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Restored:");
    expect(await clientsIn(target, targetUser)).toBe(merchants);
  }, 90_000);
});

describe("restoring a plain file without the flag", () => {
  let other: TestDb;
  let otherUser: string;
  beforeAll(async () => {
    other = await createTestDb();
    otherUser = await insertUser(other.pool, EMAIL);
  }, 60_000);
  afterAll(async () => {
    await other.drop();
  });

  it("still restores, and says loudly that the file was not encrypted", async () => {
    const r = await cli([plainFile, EMAIL], { DATABASE_URL: urlOf(other) });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/WARNING/);
    expect(r.err).toMatch(/NOT ENCRYPTED/);
    expect(r.err).toContain("--require-encrypted");
    expect(await clientsIn(other, otherUser)).toBe(merchants);
  }, 90_000);
});

describe("an encrypted file restores without the warning", () => {
  let third: TestDb;
  let thirdUser: string;
  beforeAll(async () => {
    third = await createTestDb();
    thirdUser = await insertUser(third.pool, EMAIL);
  }, 60_000);
  afterAll(async () => {
    await third.drop();
  });

  it("prints nothing on stderr", async () => {
    const r = await cli([encFile, EMAIL], { DATABASE_URL: urlOf(third), BACKUP_PASSPHRASE: PASS });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(await clientsIn(third, thirdUser)).toBe(merchants);
  }, 90_000);
});
