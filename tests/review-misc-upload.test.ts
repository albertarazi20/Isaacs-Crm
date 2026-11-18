/**
 * The upload cap holds a row lock only for the slot reservation, never across the blob write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BlobStore, LocalStore } from "@/lib/docs/storage";
import { acceptUpload, mintUploadSession } from "@/lib/docs/upload";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const pdf = (text: string) =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% ${text}\n%%EOF\n`);

let t: TestDb;
let dir: string;
let local: LocalStore;
let client: string;

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "revmisc-up-"));
  local = new LocalStore(dir);
  const rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  client = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, 'Slow Store Cafe', 'Pat Doe', '3055550141', 'pat@x.com') returning id",
      [rep],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("acceptUpload and a slow blob store", () => {
  it("does not keep the session row locked while the blob is written", async () => {
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let entered: () => void = () => undefined;
    const inPut = new Promise<void>((r) => (entered = r));
    const slow: BlobStore = {
      kind: "local",
      put: async (key, bytes, type) => {
        entered();
        await gate;
        return local.put(key, bytes, type);
      },
      get: (k) => local.get(k),
      delete: (k) => local.delete(k),
    };
    const first = acceptUpload(t.db, slow, {
      token,
      filename: "slow.pdf",
      contentType: "application/pdf",
      bytes: pdf("slow"),
      today: t.today,
    });
    await inPut; // the first upload is now in the middle of its blob write
    // another connection touches the same session row with a tiny lock wait: it must not be blocked
    const c = await t.pool.connect();
    try {
      await c.query("begin; set local lock_timeout = '300ms'");
      const r = await c.query("update upload_sessions set last_used_at = now() where token = $1", [
        token,
      ]);
      expect(r.rowCount).toBe(1);
      await c.query("commit");
    } finally {
      c.release();
    }
    // a second upload on the same link completes while the first is still writing
    const second = await acceptUpload(t.db, local, {
      token,
      filename: "other.pdf",
      contentType: "application/pdf",
      bytes: pdf("other"),
      today: t.today,
    });
    expect(second.duplicate).toBe(false);
    release();
    expect((await first).duplicate).toBe(false);
    const n = await t.pool.query<{ f: number }>(
      "select files_received as f from upload_sessions where token = $1",
      [token],
    );
    expect(n.rows[0]?.f).toBe(2);
  });

  it("gives the slot back when the file is refused or is a duplicate", async () => {
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    await expect(
      acceptUpload(t.db, local, {
        token,
        filename: "virus.exe",
        contentType: "application/octet-stream",
        bytes: new TextEncoder().encode("MZ"),
        today: t.today,
      }),
    ).rejects.toThrow(/not accepted/);
    const same = { token, filename: "a.pdf", contentType: "application/pdf", today: t.today };
    await acceptUpload(t.db, local, { ...same, bytes: pdf("dup") });
    const again = await acceptUpload(t.db, local, { ...same, bytes: pdf("dup") });
    expect(again.duplicate).toBe(true);
    const n = await t.pool.query<{ f: number }>(
      "select files_received as f from upload_sessions where token = $1",
      [token],
    );
    expect(n.rows[0]?.f).toBe(1);
  });
});
