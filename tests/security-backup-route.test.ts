import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { BACKUP_TABLES, type Backup } from "@/lib/export/backup";
import { decryptBackup, isEncryptedBackup } from "@/lib/export/backupCrypto";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

// The backup route's encrypted download. The session cookie is read through next/headers; the jar is ours.
const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "s".repeat(40);
const PASS = "twelve chars or more";
let t: TestDb;
let rep: string;
let manager: string;

const post = (body: unknown) =>
  new Request("http://localhost/api/export/backup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const asUser = async (userId: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
};

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await insertClient(t.db, rep, "Pizza Palace");
  await insertClient(t.db, manager, "Taco Town");
  process.env.DATABASE_URL = (
    t.pool as unknown as { options: { connectionString: string } }
  ).options.connectionString;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = "https://crm.test";
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the encrypted backup download", () => {
  it("a manager gets a .enc.json file that opens with the passphrase to the database's own rows", async () => {
    const { POST } = await import("@/app/api/export/backup/route");
    await asUser(manager, "boss@x.com", "manager");
    const res = await POST(post({ passphrase: PASS }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="isaac-backup-\d{4}-\d{2}-\d{2}\.enc\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    // nothing readable in the file
    for (const s of ["Pizza Palace", "Taco Town", "boss@x.com", PASS])
      expect(text).not.toContain(s);
    const envelope: unknown = JSON.parse(text);
    expect(isEncryptedBackup(envelope)).toBe(true);

    const backup = (await decryptBackup(envelope, PASS)) as Backup;
    // the decrypted content is the database's rows (a manager sees the whole floor): read them directly and compare
    for (const name of BACKUP_TABLES) {
      const { rows } = await t.pool.query<{ n: number }>(`select count(*)::int as n from ${name}`);
      expect(backup.counts[name], name).toBe(rows[0]?.n);
    }
    expect(backup.tables.clients?.map((c) => c.business_name)).toEqual([
      "Pizza Palace",
      "Taco Town",
    ]);
    await expect(decryptBackup(envelope, "some other passphrase")).rejects.toThrow(/Wrong/);
  }, 30_000);

  it("refuses a passphrase under 12 characters, a missing one and a body that is not JSON, with a sentence", async () => {
    const { POST } = await import("@/app/api/export/backup/route");
    await asUser(manager, "boss@x.com", "manager");
    for (const body of [{ passphrase: "short" }, {}, { passphrase: 12345678901234 }, "not json"]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/passphrase/i);
    }
  });

  it("a rep is refused and a signed-out caller is turned away, before the passphrase is looked at", async () => {
    const { POST } = await import("@/app/api/export/backup/route");
    await asUser(rep, "rep@x.com", "rep");
    expect((await POST(post({ passphrase: PASS }))).status).toBe(403);
    expect((await POST(post({ passphrase: "x" }))).status).toBe(403);
    jar.token = "";
    expect((await POST(post({ passphrase: PASS }))).status).toBe(401);
  });

  it("the plain download is still there, for the 'without encryption' choice", async () => {
    const { GET } = await import("@/app/api/export/backup/route");
    await asUser(manager, "boss@x.com", "manager");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/isaac-backup-[\d-]+\.json"$/);
    const backup = JSON.parse(await res.text()) as Backup;
    expect(backup.app).toBe("isaac");
    expect(backup.tables.clients?.map((c) => c.business_name)).toEqual([
      "Pizza Palace",
      "Taco Town",
    ]);
    jar.token = "";
    expect((await GET()).status).toBe(401);
  });
});

describe("the backup download is audited and limited like the other exports", () => {
  it("writes an export_download line for the manager, plain and encrypted, and refuses the 21st in an hour", async () => {
    const { GET, POST } = await import("@/app/api/export/backup/route");
    await asUser(manager, "boss@x.com", "manager");
    await t.pool.query("delete from audit_events where user_id = $1", [manager]);
    expect((await GET()).status).toBe(200);
    expect((await POST(post({ passphrase: PASS }))).status).toBe(200);
    const { rows } = await t.pool.query<{ detail: { export: string; rows: number } }>(
      "select detail from audit_events where user_id = $1 and kind = 'export_download' order by at",
      [manager],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.detail.export).toBe("backup");
      expect(r.detail.rows).toBeGreaterThan(0);
    }
    // the hourly limit counts backups with the other exports: 18 more fill it, the next is refused (429)
    await t.pool.query(
      `insert into audit_events (user_id, email, kind, detail)
         select $1, 'boss@x.com', 'export_download', '{"export":"clients","rows":1}'::jsonb from generate_series(1, 18)`,
      [manager],
    );
    const refused = await GET();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    const after = await t.pool.query(
      "select count(*)::int as n from audit_events where user_id = $1 and kind = 'export_download'",
      [manager],
    );
    expect(after.rows[0]!.n).toBe(20);
  });
});
