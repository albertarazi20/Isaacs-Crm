import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectedMonth, freshness } from "@/lib/docs/freshness";
import { labelFile, periodFromName } from "@/lib/docs/label";
import { LocalStore, safeName } from "@/lib/docs/storage";
import {
  acceptUpload,
  addDocument,
  clientFreshness,
  listDocuments,
  mintUploadSession,
  openDocument,
  openUploadPage,
  relabelDocument,
  scanPending,
  sniff,
  wantedFor,
} from "@/lib/docs/upload";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const T = "2026-11-15";
const pdf = (text = "hello") =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% ${text}\n%%EOF\n`);

describe("labelling", () => {
  it("reads the statement month out of a file name", () => {
    expect(periodFromName("Chase_Statement_Oct_2026.pdf", T)).toBe("2026-10-01");
    expect(periodFromName("statement-2026-09.pdf", T)).toBe("2026-09-01");
    expect(periodFromName("09-2026 BofA.pdf", T)).toBe("2026-09-01");
    expect(periodFromName("20260831_stmt.pdf", T)).toBe("2026-08-01");
    expect(periodFromName("September2026.pdf", T)).toBe("2026-09-01");
    expect(periodFromName("stmt_10_26.pdf", T)).toBe("2026-10-01");
    // the future and the distant past are not statement months
    expect(periodFromName("Dec_2026.pdf", T)).toBeNull();
    expect(periodFromName("Jan_2019.pdf", T)).toBeNull();
    expect(periodFromName("scan0001.pdf", T)).toBeNull();
  });
  it("labels by name, with honest confidence", () => {
    expect(labelFile("Chase_Statement_Oct_2026.pdf", "application/pdf", T)).toMatchObject({
      kind: "bank_statement",
      period: "2026-10-01",
      confidence: 0.9,
    });
    expect(labelFile("Signed MCA Application.pdf", "application/pdf", T).kind).toBe(
      "signed_application",
    );
    expect(labelFile("voided check.jpg", "image/jpeg", T).kind).toBe("voided_check");
    expect(labelFile("IMG_4411.jpeg", "image/jpeg", T)).toMatchObject({
      kind: "drivers_license",
      confidence: 0.35,
    });
    expect(labelFile("Square processing statement Sep 2026.pdf", "application/pdf", T).kind).toBe(
      "processing_statement",
    );
    expect(labelFile("scan0001.pdf", "application/pdf", T)).toMatchObject({
      kind: "other",
      confidence: 0.2,
    });
  });
});

describe("freshness", () => {
  it("expects last month after the 5th and the month before that early in the month", () => {
    expect(expectedMonth("2026-11-15")).toBe("2026-10-01");
    expect(expectedMonth("2026-11-03")).toBe("2026-09-01");
    expect(expectedMonth("2026-01-10")).toBe("2025-12-01");
  });
  it("says which months lenders will ask for", () => {
    const f = freshness(["2026-08-01", "2026-09-01"], "2026-11-15");
    expect(f).toMatchObject({
      newest: "2026-09-01",
      expected: "2026-10-01",
      monthsBehind: 1,
      status: "stale",
    });
    expect(f.missing).toEqual(["2026-07-01", "2026-10-01"]);
    expect(f.message).toBe("Newest statement is September 2026. The file needs October 2026.");
    expect(
      freshness(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"], "2026-11-15").status,
    ).toBe("fresh");
    expect(freshness([], "2026-11-15").message).toMatch(/^No statements yet/);
    const gap = freshness(["2026-07-01", "2026-09-01", "2026-10-01"], "2026-11-15");
    expect(gap.monthsBehind).toBe(0);
    expect(gap.message).toMatch(/August 2026 is missing/);
  });
});

describe("the file check", () => {
  it("accepts what the bytes say and refuses the rest", () => {
    expect(sniff(pdf(), "application/octet-stream", "stmt.pdf")).toEqual({
      ok: true,
      contentType: "application/pdf",
    });
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg", "id.jpg").ok).toBe(
      true,
    );
    expect(sniff(new TextEncoder().encode("<html>"), "text/html", "a.html").ok).toBe(false);
    expect(sniff(new TextEncoder().encode("MZ..."), "application/pdf", "evil.pdf").ok).toBe(false);
    expect(sniff(new TextEncoder().encode("x"), "application/x-msdownload", "a.exe").ok).toBe(
      false,
    );
    expect(sniff(new Uint8Array(0), "application/pdf", "a.pdf").ok).toBe(false);
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName('Oct "Stmt".pdf')).toBe("Oct Stmt.pdf");
  });
});

describe("the document pipeline", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let rep2: string;
  let manager: string;
  let pizza: string;
  let prev: string; // last month, as a period
  let prevName: string;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-docs-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
    manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
      manager,
    ]);
    pizza = await insertClient(t.db, rep, "Pizza Palace");
    const d = await t.pool.query<{ p: string; n: string }>(
      "select (date_trunc('month', current_date) - interval '1 month')::date::text as p, to_char(date_trunc('month', current_date) - interval '1 month', 'Mon_YYYY') as n",
    );
    prev = d.rows[0]!.p;
    prevName = d.rows[0]!.n;
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        pizza,
        JSON.stringify([{ kind: "signed_application" }, { kind: "bank_statement", period: prev }]),
      ]),
    );
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the permanent link opens a two-hour session that asks for what is missing", async () => {
    const token = (
      await t.pool.query<{ u: string }>("select upload_token as u from clients where id = $1", [
        pizza,
      ])
    ).rows[0]!.u;
    const s = await openUploadPage(t.db, token, t.today);
    expect(s).not.toBeNull();
    expect(s!.token).not.toBe(token);
    expect(s!.wanted.map((w) => w.kind)).toContain("signed_application");
    expect(s!.wanted.find((w) => w.kind === "bank_statement")?.period).toBe(prev);
    expect(s!.business_name).toBe("Pizza Palace");
    // the same session token opens the same session
    expect((await openUploadPage(t.db, s!.token, t.today))?.id).toBe(s!.id);
    expect(await openUploadPage(t.db, "nope", t.today)).toBeNull();
    expect(await openUploadPage(t.db, "a".repeat(48), t.today)).toBeNull();
  });

  it("a merchant upload is labelled, stored, ticks the stip, writes the activity and waits for the scan", async () => {
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: pizza }));
    const r = await acceptUpload(t.db, store, {
      token,
      filename: `Chase_Statement_${prevName}.pdf`,
      contentType: "application/pdf",
      bytes: pdf("october"),
      today: t.today,
    });
    expect(r).toMatchObject({
      kind: "bank_statement",
      period: prev,
      duplicate: false,
      confidence: 0.9,
    });
    const stip = await t.pool.query<{ received_at: string | null; doc_key: string | null }>(
      "select received_at::text, doc_key from stips where client_id = $1 and kind = 'bank_statement' and period = $2",
      [pizza, prev],
    );
    expect(stip.rows[0]?.received_at).not.toBeNull();
    expect(stip.rows[0]?.doc_key).toMatch(new RegExp(`^${pizza}/`));
    const act = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' order by occurred_at desc limit 1",
      [pizza],
    );
    expect(act.rows[0]?.body).toMatch(
      /^Received .* bank statement — Chase_Statement_.*\(merchant upload\)$/,
    );
    expect(await store.get(stip.rows[0]!.doc_key!)).not.toBeNull();

    // not openable until scanned; the scan flips it
    await expect(t.db.withUser(rep, (q) => openDocument(q, r.documentId))).rejects.toThrow(
      /still being checked/,
    );
    expect(await scanPending(t.db, store)).toEqual({ scanned: 1, clean: 1, rejected: 0 });
    expect((await t.db.withUser(rep, (q) => openDocument(q, r.documentId))).scan_status).toBe(
      "clean",
    );

    // the same bytes again are a duplicate, not a second row
    const again = await acceptUpload(t.db, store, {
      token,
      filename: "copy.pdf",
      contentType: "application/pdf",
      bytes: pdf("october"),
      today: t.today,
    });
    expect(again).toMatchObject({ documentId: r.documentId, duplicate: true });
    const sess = await t.pool.query<{ n: number }>(
      "select files_received as n from upload_sessions where token = $1",
      [token],
    );
    expect(sess.rows[0]?.n).toBe(1);

    // a wrong file is refused with a plain sentence
    await expect(
      acceptUpload(t.db, store, {
        token,
        filename: "virus.exe",
        contentType: "application/octet-stream",
        bytes: new TextEncoder().encode("MZ"),
        today: t.today,
      }),
    ).rejects.toThrow(/not accepted/);
    // an expired session is refused
    const dead = await t.db.withSystem((q) => mintUploadSession(q, { clientId: pizza, hours: 0 }));
    await expect(
      acceptUpload(t.db, store, {
        token: dead.token,
        filename: "a.pdf",
        contentType: "application/pdf",
        bytes: pdf("x"),
        today: t.today,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("staff uploads are clean at once, visible under RLS, and a relabel moves the checklist", async () => {
    const r = await t.db.withUser(rep, (q) =>
      addDocument(q, store, {
        clientId: pizza,
        filename: "scan0001.pdf",
        contentType: "application/pdf",
        bytes: pdf("app"),
        uploadedBy: rep,
        today: t.today,
      }),
    );
    expect(r.kind).toBe("other");
    expect(
      (await t.db.withUser(rep, (q) => listDocuments(q, pizza))).map((d) => d.scan_status),
    ).toEqual(["clean", "clean"]);
    expect(await t.db.withUser(rep2, (q) => listDocuments(q, pizza))).toEqual([]);
    expect((await t.db.withUser(manager, (q) => listDocuments(q, pizza))).length).toBe(2);

    await t.db.withUser(rep, (q) => relabelDocument(q, r.documentId, "signed_application", null));
    const stip = await t.pool.query<{ received_at: string | null }>(
      "select received_at::text from stips where client_id = $1 and kind = 'signed_application'",
      [pizza],
    );
    expect(stip.rows[0]?.received_at).not.toBeNull();
    const wanted = await t.db.withUser(rep, (q) => wantedFor(q, pizza, t.today));
    expect(wanted.some((w) => w.kind === "signed_application")).toBe(false);
    const fresh = await t.db.withUser(rep, (q) => clientFreshness(q, pizza, t.today));
    expect(fresh.newest).toBe(prev);
  });
});
