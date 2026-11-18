import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { LocalStore } from "@/lib/docs/storage";
import {
  acceptUpload,
  addDocument,
  fileGeneratedDocument,
  mintUploadSession,
  scanPending,
} from "@/lib/docs/upload";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

// The staff upload route reads the session cookie through next/headers; the test's jar is what it sees.
const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "s".repeat(40);
const pdf = (text: string) =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% ${text}\n%%EOF\n`);

let t: TestDb;
let dir: string;
let store: LocalStore;
let rep: string;
let other: string;
let boss: string;
let mine: string;
let theirs: string;

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-secdocs-"));
  store = new LocalStore(dir);
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.DOCS_DIR = dir;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  other = await insertUser(t.pool, "other@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
  mine = await insertClient(t.db, rep, "Pizza Palace");
  theirs = await insertClient(t.db, other, "Other Deli");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** What a rep-role SQL path could try: a row that claims to be scanned and clean. */
const forged = (who: string, clientId: string, over: { key?: string; owner?: string } = {}) => {
  n += 1;
  return t.db.withUser(who, (q) =>
    q.query<{ id: string }>(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source,
                              scan_status, scan_note, scanned_at)
       values ($4, $1, 'bank_statement', 'f.pdf', 'application/pdf', 10, repeat($2, 64), $3, 'staff',
               'clean', 'type check passed', now())
       returning id`,
      [clientId, String(n % 10), over.key ?? `${clientId}/forged-${n}.pdf`, over.owner ?? who],
    ),
  );
};
const stored = async (id: string) =>
  (
    await t.pool.query<{ scan_status: string; scan_note: string; scanned_at: string | null }>(
      "select scan_status, scan_note, scanned_at::text from documents where id = $1",
      [id],
    )
  ).rows[0];

describe("a signed-in session cannot insert a document that skips the scan", () => {
  it("a rep's row that claims 'clean' is stored 'pending' with no scan record", async () => {
    const r = await forged(rep, mine);
    expect(await stored(r.rows[0]!.id)).toEqual({
      scan_status: "pending",
      scan_note: "",
      scanned_at: null,
    });
  });

  it("so is a manager's, whoever the merchant belongs to", async () => {
    const r = await forged(boss, theirs, { owner: other });
    expect(await stored(r.rows[0]!.id)).toEqual({
      scan_status: "pending",
      scan_note: "",
      scanned_at: null,
    });
  });

  it("a row pointing at another merchant's stored file is refused, and nothing is written", async () => {
    const before = Number((await t.pool.query("select count(*) as c from documents")).rows[0].c);
    await expect(
      forged(rep, mine, { key: `${theirs}/${"a".repeat(36)}-stmt.pdf` }),
    ).rejects.toThrow(/stored under its own merchant/);
    await expect(forged(rep, mine, { key: "anything.pdf" })).rejects.toThrow(
      /stored under its own merchant/,
    );
    expect(Number((await t.pool.query("select count(*) as c from documents")).rows[0].c)).toBe(
      before,
    );
  });

  it("the scan columns still cannot be written by the session afterwards (0564)", async () => {
    const r = await forged(rep, mine);
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update documents set scan_status = 'clean' where id = $1", [r.rows[0]!.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await stored(r.rows[0]!.id))?.scan_status).toBe("pending");
  });

  it("the system connection keeps writing its own verdict", async () => {
    const id = (
      await t.db.withSystem((q) =>
        q.query<{ id: string }>(
          `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source,
                                  scan_status, scan_note, scanned_at)
           values ($1, $2, 'other', 'sys.pdf', 'application/pdf', 10, repeat('9', 64), $3, 'upload_link', 'clean', 'by the system', now())
           returning id`,
          [rep, mine, `${mine}/sys.pdf`],
        ),
      )
    ).rows[0]!.id;
    const row = await stored(id);
    expect(row?.scan_status).toBe("clean");
    expect(row?.scan_note).toBe("by the system");
    expect(row?.scanned_at).not.toBeNull();
  });
});

describe("the flows that file documents still work, and the database shows it", () => {
  it("a rep's upload goes in pending and is clean once the scanner has run on it", async () => {
    const r = await t.db.withUser(rep, (q) =>
      addDocument(q, store, {
        clientId: mine,
        filename: "stmt_one.pdf",
        contentType: "application/pdf",
        bytes: pdf("one"),
        uploadedBy: rep,
        today: t.today,
      }),
    );
    expect((await stored(r.documentId))?.scan_status).toBe("pending");
    expect(await scanPending(t.db, store, undefined, 50, [r.documentId])).toMatchObject({
      scanned: 1,
      clean: 1,
    });
    const after = await stored(r.documentId);
    expect(after?.scan_status).toBe("clean");
    expect(after?.scanned_at).not.toBeNull();
  });

  it("scanning only the named documents leaves the rest pending", async () => {
    const make = (text: string) =>
      t.db.withUser(rep, (q) =>
        addDocument(q, store, {
          clientId: mine,
          filename: `${text}.pdf`,
          contentType: "application/pdf",
          bytes: pdf(text),
          uploadedBy: rep,
          today: t.today,
        }),
      );
    const x = await make("only-x");
    const y = await make("only-y");
    await scanPending(t.db, store, undefined, 50, [x.documentId]);
    expect((await stored(x.documentId))?.scan_status).toBe("clean");
    expect((await stored(y.documentId))?.scan_status).toBe("pending");
    await scanPending(t.db, store);
    expect((await stored(y.documentId))?.scan_status).toBe("clean");
  });

  it("the merchant's upload link and the app's own generated PDF go through the system connection unchanged", async () => {
    const { token } = await t.db.withUser(rep, (q) =>
      mintUploadSession(q, { clientId: mine, purpose: "stips", wanted: [], createdBy: rep }),
    );
    const up = await acceptUpload(t.db, store, {
      token,
      filename: "chase_oct.pdf",
      contentType: "application/pdf",
      bytes: pdf("merchant"),
      today: t.today,
    });
    expect((await stored(up.documentId))?.scan_status).toBe("pending");
    const gen = await t.db.withSystem((q) =>
      fileGeneratedDocument(q, store, {
        clientId: mine,
        kind: "signed_application",
        filename: "Signed application.pdf",
        bytes: pdf("generated"),
        today: t.today,
      }),
    );
    const row = await stored(gen.documentId);
    expect(row?.scan_status).toBe("clean");
    expect(row?.scanned_at).not.toBeNull();
  });

  it("the staff upload route scans what it stored, so the file opens at once", async () => {
    jar.token = await signSession(
      { userId: rep, email: "rep@x.com", role: "rep", epoch: 0 },
      SECRET,
    );
    const { POST } = await import("@/app/api/docs/route");
    const form = new FormData();
    form.set("clientId", mine);
    form.append(
      "file",
      new File([pdf("via route")], "route_upload.pdf", { type: "application/pdf" }),
    );
    const res = await POST(
      new Request("http://localhost/api/docs", { method: "POST", body: form }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { ok: boolean; documentId: string }[] };
    expect(body.results[0]?.ok).toBe(true);
    const row = await stored(body.results[0]!.documentId);
    expect(row?.scan_status).toBe("clean");
    expect(row?.scanned_at).not.toBeNull();
  });
});
