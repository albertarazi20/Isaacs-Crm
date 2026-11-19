import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRawRows } from "@/lib/data/import";
import { findDuplicates } from "@/lib/data/queries";
import { isUuid, newClientSchema } from "@/lib/data/schemas";
import { addDays } from "@/lib/mca/dates";
import { LocalStore, safeName } from "@/lib/docs/storage";
import {
  acceptUpload,
  builtinScanner,
  mintUploadSession,
  openUploadPage,
  scanPending,
} from "@/lib/docs/upload";
import { buildRows, guessMapping, parseStageWord, statusNoteFor } from "@/lib/import/map";
import { intakeSchema } from "@/lib/leads/form";
import { leadSchema } from "@/lib/leads/schema";
import { normalizeUS } from "@/lib/mca/phone";
import { fileOneRow, type PendingRow } from "@/lib/sheets/file";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const pdf = (text = "hello") =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% ${text}\n%%EOF\n`);

describe("safeName keeps the extension", () => {
  it.each([
    ["照片.jpg", "file.jpg"],
    ["Фото.pdf", "file.pdf"],
    ["_.pdf", "file.pdf"],
    [".pdf", "file.pdf"],
    ["Фото банка Oct.pdf", "Oct.pdf"],
    ["../../etc/passwd", "passwd"],
    ['Oct "Stmt".pdf', "Oct Stmt.pdf"],
  ])("%s -> %s", (input, out) => {
    expect(safeName(input)).toBe(out);
  });
  it("truncates a long name's base, never its extension", () => {
    const out = safeName(`${"a".repeat(130)}.pdf`);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(safeName(`${"é".repeat(5)}${"b".repeat(200)}.jpeg`)).toMatch(/\.jpeg$/);
  });
  it("never returns only an extension", () => {
    for (const n of ["照片.jpg", "...jpg", "-.png", "__.pdf", "   .pdf"])
      expect(safeName(n)).toMatch(/^[A-Za-z0-9].*\.[a-z]+$/);
  });
  it("the built-in scanner trusts the stored type, not the cleaned display name", async () => {
    const v = await builtinScanner(pdf(), "application/pdf", "jpg");
    expect(v.clean).toBe(true);
    // the bytes still have to match the stored type
    expect(
      (await builtinScanner(new Uint8Array([1, 2, 3, 4]), "application/pdf", "x.pdf")).clean,
    ).toBe(false);
  });
});

describe("status words: a merchant who said no is never a fresh lead", () => {
  it.each([
    "Declined offer",
    "Withdrew offer",
    "Lost to competitor offer",
    "Denied - not approved",
    "Rejected the contract",
    "Withdrawn after approval",
  ])("%s -> dead", (w) => {
    expect(parseStageWord(w)).toEqual({ stage: "dead", unsupported: false });
  });
  it("not interested wins over a worked-elsewhere word", () => {
    expect(parseStageWord("Not interested in the offer")).toEqual({
      stage: "not_interested",
      unsupported: false,
    });
  });
  it("still holds back real worked-elsewhere statuses and keeps plain ones", () => {
    expect(parseStageWord("Offer sent")).toEqual({ stage: null, unsupported: true });
    expect(parseStageWord("Funded")).toEqual({ stage: null, unsupported: true });
    expect(parseStageWord("Interested").stage).toBe("interested");
    expect(parseStageWord("Declined").stage).toBe("dead");
  });
  it("a declined-offer row imports as dead with the long wait, not name_in tomorrow", () => {
    const m = guessMapping(["Business", "Phone", "Status"]);
    const { rows } = buildRows([["A", "3055550142", "Declined offer"]], m, {
      today: "2026-11-15",
      spreadDays: 3,
    });
    expect(rows[0]?.stage).toBe("dead");
    expect((rows[0]?.followUpOn ?? "") > "2026-12-15").toBe(true);
  });
});

describe("normalizeUS", () => {
  it.each([
    "0000000000",
    "1111111111",
    "2222222222",
    "1234567890",
    "0123456789",
    "9876543210",
    "(000) 000-0000",
    "+1 111 111 1111",
    "1-800-000-0000",
    "305-055-0100",
  ])("%s is not a number", (raw) => {
    expect(normalizeUS(raw)).toBeNull();
  });
  it.each([
    ["(305) 555-0100", "+13055550100"],
    ["1-305-555-0100", "+13055550100"],
    ["3055550100", "+13055550100"],
    ["(555) 123-4567", "+15551234567"],
    ["+1 (561) 915-1002", "+15619151002"],
  ])("%s still works", (raw, out) => {
    expect(normalizeUS(raw)).toBe(out);
  });
  it.each([
    "305-555-0100 x12",
    "(305) 555-0100 ext. 2",
    "305-555-0100 ext 45",
    "305.555.0100 Extension 7",
    "3055550100x9",
    "1 (305) 555-0100, ext. 12",
  ])("%s has its extension stripped", (raw) => {
    expect(normalizeUS(raw)).toBe("+13055550100");
  });
  it("two leads with the same junk number are not one merchant", () => {
    expect(normalizeUS("0000000000")).toBe(normalizeUS("1234567890"));
  });
});

describe("state spelling", () => {
  it("the client, lead and intake schemas store the two-letter code", () => {
    const base = { businessName: "A", followUpOn: "2026-11-20", stage: "name_in" as const };
    expect(newClientSchema.parse({ ...base, state: "Florida" }).state).toBe("FL");
    expect(newClientSchema.parse({ ...base, state: "fl" }).state).toBe("FL");
    expect(newClientSchema.parse({ ...base, state: "Atlantis" }).state).toBe("ATLANTIS");
    expect(
      leadSchema.parse({ phone: "3055550142", businessName: "A", state: "new york" }).state,
    ).toBe("NY");
    expect(intakeSchema.parse({ phone: "3055550142", state: "Florida" }).state).toBe("FL");
  });
});

describe("a long or multi-line status cell cannot fail a row", () => {
  it("statusNoteFor fits the 200 character note field on one line", () => {
    const n = statusNoteFor(`Offer out\n\n${"x".repeat(400)}\tmore`);
    expect(n.length).toBeLessThanOrEqual(200);
    expect(n).not.toMatch(/[\n\t]/);
    expect(n.startsWith("Imported status: Offer out x")).toBe(true);
  });
});

describe("uuid guard", () => {
  it("refuses dashes and hex runs that are not uuids", () => {
    expect(isUuid(randomUUID())).toBe(true);
    expect(isUuid(randomUUID().toUpperCase())).toBe(true);
    expect(isUuid("-".repeat(36))).toBe(false);
    expect(isUuid("a".repeat(36))).toBe(false);
    expect(isUuid("0123456789abcdef0123456789abcdef0123")).toBe(false);
  });
});

describe("database behaviour", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-review-docs-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uploads with Cyrillic, CJK, 130-character and underscore names end clean, not rejected", async () => {
    const client = await insertClient(t.db, rep, "Names Co");
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    const names = ["Фото.pdf", "照片.pdf", "_.pdf", `${"a".repeat(130)}.pdf`];
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, 1, 2, 3]);
    const sent = [
      ...names.map((filename, i) => ({
        filename,
        contentType: "application/pdf",
        bytes: pdf(`n${i}`),
      })),
      { filename: "照片.png", contentType: "image/png", bytes: png(9) },
    ];
    const ids: string[] = [];
    for (const f of sent) {
      ids.push((await acceptUpload(t.db, store, { token, today: t.today, ...f })).documentId);
    }
    const scan = await scanPending(t.db, store, undefined, 50, ids);
    expect(scan).toMatchObject({ scanned: 5, clean: 5, rejected: 0, errors: 0 });
    const { rows } = await t.pool.query<{ filename: string; scan_status: string }>(
      "select filename, scan_status from documents where client_id = $1 order by created_at",
      [client],
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.scan_status).toBe("clean");
      expect(r.filename).toMatch(/^[A-Za-z0-9].*\.(pdf|png)$/);
    }
  });

  it("the upload page's still-needed list drops what is already on file", async () => {
    const client = await insertClient(t.db, rep, "Needs Co");
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        client,
        JSON.stringify([{ kind: "signed_application" }, { kind: "voided_check" }]),
      ]),
    );
    const tok = (
      await t.pool.query<{ u: string }>("select upload_token as u from clients where id = $1", [
        client,
      ])
    ).rows[0]!.u;
    const first = await openUploadPage(t.db, tok, t.today);
    expect(first!.wanted.map((w) => w.kind)).toEqual(
      expect.arrayContaining(["signed_application", "voided_check"]),
    );
    await acceptUpload(t.db, store, {
      token: first!.token,
      filename: "Signed MCA Application.pdf",
      contentType: "application/pdf",
      bytes: pdf("signed"),
      today: t.today,
    });
    // the same session, asked again (a reload, or the page's refresh after the upload)
    const again = await openUploadPage(t.db, first!.token, t.today);
    expect(again!.wanted.map((w) => w.kind)).not.toContain("signed_application");
    expect(again!.wanted.map((w) => w.kind)).toContain("voided_check");
    // the stored list was minted before the upload: the answer is recomputed, not read back
    const stored = await t.pool.query<{ w: { kind: string }[] }>(
      "select wanted as w from upload_sessions where token = $1",
      [first!.token],
    );
    expect(stored.rows[0]!.w.map((w) => w.kind)).toContain("signed_application");
  });

  it("different leads with the same junk number are not merged", async () => {
    await t.pool.query(
      "insert into clients (user_id, business_name, contact_name, phone) values ($1, 'Junk One', 'A', '0000000000')",
      [rep],
    );
    const dupes = await t.db.withUser(rep, (q) =>
      findDuplicates(q, { phone: "0000000000", businessName: "Junk Two" }),
    );
    expect(dupes).toEqual([]);
    // a real number still matches however it is typed, and an extension does not hide it
    await t.pool.query(
      "insert into clients (user_id, business_name, contact_name, phone) values ($1, 'Real One', 'A', '(305) 555-0188')",
      [rep],
    );
    const real = await t.db.withUser(rep, (q) =>
      findDuplicates(q, { phone: "305-555-0188 x12", businessName: "Other" }),
    );
    expect(real.map((m) => m.business_name)).toEqual(["Real One"]);
  });

  it("import stores the two-letter state and a long multi-line status cell imports", async () => {
    const m = guessMapping(["Business", "Phone", "State", "Status"]);
    const { rows } = buildRows(
      [
        ["State Co", "3055550177", "Florida", `Offer sent\nawaiting reply ${"y".repeat(300)}`],
        ["Dead Co", "3055550178", "fl", "Declined offer"],
      ],
      m,
      { today: t.today, spreadDays: 3 },
    );
    expect(rows).toHaveLength(2);
    const result = await t.db.withUser(rep, (q) =>
      importRawRows(q, { rows }, { today: t.today, timezone: "UTC" }),
    );
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(2);
    const db = await t.pool.query<{ business_name: string; state: string; stage: string }>(
      "select business_name, state, stage from clients where business_name in ('State Co','Dead Co') order by business_name",
    );
    expect(db.rows).toEqual([
      { business_name: "Dead Co", state: "FL", stage: "dead" },
      { business_name: "State Co", state: "FL", stage: "name_in" },
    ]);
    expect(addDays(t.today, 0)).toBe(t.today);
  });

  it("a sheet row is a duplicate by email, and by its second number when the first is unusable", async () => {
    const owner = await insertUser(t.pool, "sheet@x.com", "America/New_York");
    const withEmail = await t.db.withUser(owner, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "select id from create_client($1::jsonb, $2::jsonb)",
        [
          JSON.stringify({
            business_name: "Email Match Co",
            contact_name: "E",
            phone: "3055550311",
            email: "owner@emailmatch.com",
          }),
          JSON.stringify([{ kind: "follow_up", due_on: addDays(t.today, 1) }]),
        ],
      );
      return rows[0]!.id;
    });
    const row = (over: Partial<PendingRow>): PendingRow => ({
      id: randomUUID(),
      source_id: randomUUID(),
      owner_id: owner,
      target_bucket_id: null,
      business_name: "Totally Different Name",
      contact_name: "",
      email: "",
      email2: "",
      phone: "",
      phone2: "",
      industry: "",
      state: "",
      monthly_revenue_cents: null,
      time_in_business_months: null,
      wanted: "",
      notes: "",
      source_name: "Sheet",
      ...over,
    });
    const byEmail = await t.db.withUser(owner, (q) =>
      fileOneRow(
        q,
        row({ phone: "0000000000", email: "Owner@EmailMatch.com" }),
        "https://crm.test",
      ),
    );
    expect(byEmail).toMatchObject({ result: "duplicate", clientId: withEmail });
    const byPhone2 = await t.db.withUser(owner, (q) =>
      fileOneRow(q, row({ phone: "n/a", phone2: "(305) 555-0311" }), "https://crm.test"),
    );
    expect(byPhone2).toMatchObject({ result: "duplicate", clientId: withEmail });
    const n = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from clients where business_name = 'Totally Different Name'",
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});
