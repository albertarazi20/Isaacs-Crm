import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signSession } from "@/lib/auth/session";
import { LocalStore } from "@/lib/docs/storage";
import { addDocument } from "@/lib/docs/upload";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

// The route reads the session cookie through next/headers; outside a Next request there is none, so the cookie jar
// is ours: whatever token the test sets is what the route sees.
const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "s".repeat(40);

let t: TestDb;
let dir: string;
let rep: string;
let rep2: string;
let manager: string;
let docId: string;
let original: Uint8Array;

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-docroute-"));
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  process.env.SESSION_SECRET = SECRET;
  process.env.DOCS_DIR = dir;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  const pizza = await insertClient(t.db, rep, "Pizza Palace");
  const pdf = await PDFDocument.create();
  pdf.addPage();
  original = await pdf.save();
  docId = (
    await t.db.withUser(rep, (q) =>
      addDocument(q, new LocalStore(dir), {
        clientId: pizza,
        filename: "Chase_Statement.pdf",
        contentType: "application/pdf",
        bytes: original,
        uploadedBy: rep,
        today: t.today,
      }),
    )
  ).documentId;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

const asUser = async (userId: string, email: string, role: "rep" | "manager") => {
  jar.token = await signSession({ userId, email, role, epoch: 0 }, SECRET);
};
const open = async (id: string, query = "") => {
  const { GET } = await import("@/app/api/docs/[id]/route");
  return GET(new Request(`http://localhost/api/docs/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
};

describe("opening a document", () => {
  it("the merchant's rep and a manager get the file exactly as it was filed; nothing is stamped or logged", async () => {
    await asUser(rep, "rep@x.com", "rep");
    const res = await open(docId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(
      /^inline; filename="Chase_Statement\.pdf"/,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(original);

    await asUser(manager, "boss@x.com", "manager");
    const m = await open(docId, "?dl=1");
    expect(m.status).toBe(200);
    expect(m.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(new Uint8Array(await m.arrayBuffer())).toEqual(original);

    expect((await t.pool.query("select 1 from document_views")).rowCount).toBe(0);
  });

  it("another rep cannot open it, a signed-out caller is turned away, a bad id is not found", async () => {
    await asUser(rep2, "rep2@x.com", "rep");
    expect((await open(docId)).status).toBe(409);
    jar.token = "";
    expect((await open(docId)).status).toBe(401);
    await asUser(rep, "rep@x.com", "rep");
    expect((await open("not-an-id")).status).toBe(404);
  });
});
