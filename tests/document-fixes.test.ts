import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectedMonth } from "@/lib/docs/freshness";
import { labelFile, periodFromName, readPeriod } from "@/lib/docs/label";
import { LocalStore } from "@/lib/docs/storage";
import { addDocument, deleteDocument, relabelDocument } from "@/lib/docs/upload";
import { handOff } from "@/lib/followup/handoff";
import { addDays } from "@/lib/mca/dates";
import { defaultStips } from "@/lib/mca/stips";
import { runStatementClock } from "@/lib/system/statements";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Documents and statements (db/migrations/0544): the checklist follows a relabel or a delete, the newest-statement
 * clock runs over merchants, a US date in a file name is read month first, and a checklist never asks for a
 * statement that does not exist yet. Every database claim is read back from the database.
 */

const TODAY = "2026-11-17";

describe("statement month from a file name", () => {
  const cases: [name: string, period: string | null, certain: boolean | null][] = [
    // US order, month first; a day of 12 or less could be the month, so the reading is not certain
    ["Statement_12-01-2025.pdf", "2025-12-01", false],
    ["statement_10-01-2025.pdf", "2025-10-01", false],
    ["stmt 11-05-2026.pdf", "2026-11-01", false],
    ["Chase statement 09-12-2026.pdf", "2026-09-01", false],
    ["Statement 3/4/2026.pdf", "2026-03-01", false],
    ["stmt_12-01-25.pdf", "2025-12-01", false],
    // a day over 12 cannot be the month: certain
    ["statement_10-31-2026.pdf", "2026-10-01", true],
    ["Statement 9_30_2026.pdf", "2026-09-01", true],
    ["Statement 7-15-26.pdf", "2026-07-01", true],
    // the same number both ways reads the same either way
    ["stmt 10-10-2026.pdf", "2026-10-01", true],
    // day first is the only reading when the first part is over 12
    ["stmt 31-10-2026.pdf", "2026-10-01", true],
    // ISO, month-year and month names are unchanged
    ["statement 2026-10-31.pdf", "2026-10-01", true],
    ["20260831_stmt.pdf", "2026-08-01", true],
    ["09-2026 BofA.pdf", "2026-09-01", true],
    ["Chase_Statement_Oct_2026.pdf", "2026-10-01", true],
    ["stmt_10_26.pdf", "2026-10-01", true],
    // a whole date in the future is not a statement month, and the month-year rule must not read "05-2026" from it
    ["stmt 12-05-2026.pdf", null, null],
    ["stmt 13-13-2026.pdf", null, null],
    ["scan0001.pdf", null, null],
  ];
  it.each(cases)("%s", (name, period, certain) => {
    expect(periodFromName(name, TODAY)).toBe(period);
    const r = readPeriod(name, TODAY);
    expect(r?.certain ?? null).toBe(certain);
  });

  it("an uncertain month goes below the confirm threshold (0.8); a certain one does not", () => {
    const amb = labelFile("Statement_12-01-2025.pdf", "application/pdf", TODAY);
    expect(amb).toMatchObject({ kind: "bank_statement", period: "2025-12-01" });
    expect(amb.confidence).toBeLessThan(0.8);
    const sure = labelFile("statement_10-31-2026.pdf", "application/pdf", TODAY);
    expect(sure).toMatchObject({ kind: "bank_statement", period: "2026-10-01", confidence: 0.9 });
    expect(labelFile("stmt 11-05-2026.pdf", "application/pdf", TODAY).confidence).toBeLessThan(0.8);
  });
});

describe("a new checklist asks for statements that exist", () => {
  const months = (asOf: string) =>
    defaultStips(asOf)
      .filter((s) => s.kind === "bank_statement")
      .map((s) => s.period);

  it("the 1st to the 4th end at the month before last; the 5th on ends at last month", () => {
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"])
      expect(months(d)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    for (const d of ["2026-11-05", "2026-11-17", "2026-11-30"])
      expect(months(d)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
  });
  it("across the year boundary", () => {
    expect(months("2026-01-04")).toEqual(["2025-08-01", "2025-09-01", "2025-10-01", "2025-11-01"]);
    expect(months("2026-01-05")).toEqual(["2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01"]);
  });
  it("the newest month asked for is always the newest month expected, every day of the year", () => {
    for (let d = "2026-01-01"; d <= "2026-12-31"; d = addDays(d, 1)) {
      const ms = months(d);
      expect(ms.at(-1)).toBe(expectedMonth(d));
      expect(ms).toHaveLength(4);
    }
  });
});

describe("the checklist follows the files (database)", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let phone = 3055550200;
  let seed = 0;

  const pdf = () =>
    new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% file ${(seed += 1)}\n%%EOF\n`);
  const jpeg = () => {
    const b = new Uint8Array(64);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    b[40] = (seed += 1) % 256;
    b[41] = Math.floor(seed / 256) % 256;
    return b;
  };
  const merchant = async (name: string, userId = rep) => {
    phone += 1;
    return (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', $3, $4, 'FL') returning id",
        [userId, name, String(phone), `o${phone}@x.com`],
      )
    ).rows[0]!.id;
  };
  const checklist = (id: string, stips: { kind: string; period: string | null }[]) =>
    t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify(stips.map((s) => ({ ...s, required: true }))),
      ]),
    );
  const upload = (
    id: string,
    a: {
      filename: string;
      kind?: "signed_application" | "bank_statement" | "drivers_license" | "voided_check";
      period?: string;
      image?: boolean;
    },
  ) =>
    t.db.withUser(rep, (q) =>
      addDocument(q, store, {
        clientId: id,
        filename: a.filename,
        contentType: a.image ? "image/jpeg" : "application/pdf",
        bytes: a.image ? jpeg() : pdf(),
        uploadedBy: rep,
        today: TODAY,
        ...(a.kind ? { kind: a.kind, period: a.period ?? null } : {}),
      }),
    );
  /** kind(:period) -> received, straight from the stips table */
  const ticked = async (id: string) =>
    Object.fromEntries(
      (
        await t.pool.query<{ k: string; got: boolean }>(
          "select kind || coalesce(':' || period::text, '') as k, received_at is not null as got from stips where client_id = $1 and required",
          [id],
        )
      ).rows.map((r) => [r.k, r.got]),
    );
  const liveBucket = async (id: string) =>
    (
      await t.pool.query<{ key: string | null }>(
        "select b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
        [id],
      )
    ).rows[0]?.key ?? null;
  const bucketId = async (key: string) =>
    (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!
      .id;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-docfix-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a photo auto-labelled as the ID and corrected to a voided check un-ticks the ID", async () => {
    const id = await merchant("Relabel Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
      { kind: "drivers_license", period: null },
      { kind: "voided_check", period: null },
    ]);
    const photo = await upload(id, { filename: "IMG_2041.jpg", image: true });
    expect(photo.kind).toBe("drivers_license");
    expect((await ticked(id))["drivers_license"]).toBe(true);

    await t.db.withUser(rep, (q) => relabelDocument(q, photo.documentId, "voided_check", null));
    expect(await ticked(id)).toMatchObject({ drivers_license: false, voided_check: true });
    const key = await t.pool.query<{ doc_key: string | null }>(
      "select doc_key from stips where client_id = $1 and kind = 'drivers_license'",
      [id],
    );
    expect(key.rows[0]!.doc_key).toBeNull();

    // the application and the statement arrive: the merchant still has no ID, so they are not ready
    await upload(id, { filename: "app.pdf", kind: "signed_application" });
    await upload(id, { filename: "oct.pdf", kind: "bank_statement", period: "2026-10-01" });
    expect(await liveBucket(id)).toBe("missing_id");
  });

  it("relabelling a statement's month moves the tick to the new month", async () => {
    const id = await merchant("Month Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-09-01" },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    await upload(id, { filename: "app.pdf", kind: "signed_application" });
    await upload(id, { filename: "sep.pdf", kind: "bank_statement", period: "2026-09-01" });
    const wrong = await upload(id, { filename: "Statement_10-01-2026.pdf" });
    expect(wrong.period).toBe("2026-10-01");
    expect(await liveBucket(id)).toBe("ready_for_ops");
    // the rep reads it: it is the September statement again (a second copy), so October is still missing
    await t.db.withUser(rep, (q) =>
      relabelDocument(q, wrong.documentId, "bank_statement", "2026-09-01"),
    );
    expect(await ticked(id)).toMatchObject({
      "bank_statement:2026-09-01": true,
      "bank_statement:2026-10-01": false,
    });
    expect(await liveBucket(id)).toBe("missing_newest");
  });

  it("deleting the only statement un-ticks it and the bucket follows; a second copy keeps it ticked", async () => {
    const id = await merchant("Delete Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
      { kind: "drivers_license", period: null },
      { kind: "voided_check", period: null },
    ]);
    await upload(id, { filename: "app.pdf", kind: "signed_application" });
    await upload(id, { filename: "id.pdf", kind: "drivers_license" });
    await upload(id, { filename: "check.pdf", kind: "voided_check" });
    const first = await upload(id, {
      filename: "oct.pdf",
      kind: "bank_statement",
      period: "2026-10-01",
    });
    const copy = await upload(id, {
      filename: "oct-again.pdf",
      kind: "bank_statement",
      period: "2026-10-01",
    });
    expect(await liveBucket(id)).toBe("ready_for_ops");

    await t.db.withUser(rep, (q) => deleteDocument(q, store, copy.documentId, rep));
    expect((await ticked(id))["bank_statement:2026-10-01"]).toBe(true);
    const backing = await t.pool.query<{ doc_key: string; storage_key: string }>(
      `select s.doc_key, d.storage_key from stips s, documents d
        where s.client_id = $1 and s.kind = 'bank_statement' and d.id = $2`,
      [id, first.documentId],
    );
    expect(backing.rows[0]!.doc_key).toBe(backing.rows[0]!.storage_key);
    expect(await liveBucket(id)).toBe("ready_for_ops");

    await t.db.withUser(rep, (q) => deleteDocument(q, store, first.documentId, rep));
    expect((await ticked(id))["bank_statement:2026-10-01"]).toBe(false);
    expect(await liveBucket(id)).toBe("missing_statements");
    const note = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Stip marked missing%'",
      [id],
    );
    expect(note.rows.map((r) => r.body)).toEqual([
      "Stip marked missing: Oct 2026 bank statement — oct.pdf was deleted",
    ]);
  });

  it("a brought-in merchant's box un-ticks but they are not put back in a bucket", async () => {
    const id = await merchant("Done Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    await upload(id, { filename: "app.pdf", kind: "signed_application" });
    const s = await upload(id, {
      filename: "oct.pdf",
      kind: "bank_statement",
      period: "2026-10-01",
    });
    await t.db.withUser(rep, (q) => handOff(q, id));
    expect(await liveBucket(id)).toBeNull();
    await t.db.withUser(rep, (q) => deleteDocument(q, store, s.documentId, rep));
    expect((await ticked(id))["bank_statement:2026-10-01"]).toBe(false);
    expect(await liveBucket(id)).toBeNull();
  });

  describe("the newest-statement clock", () => {
    /** A merchant whose checklist was started on `startedOn`, with every required box received. */
    const complete = async (name: string, startedOn: string) => {
      const id = await merchant(name);
      await t.db.withUser(rep, (q) =>
        q.query("select add_stips($1, $2::jsonb)", [id, JSON.stringify(defaultStips(startedOn))]),
      );
      for (const s of defaultStips(startedOn).filter((x) => x.required))
        await upload(id, {
          filename: `${s.kind}-${s.period ?? "x"}.pdf`,
          kind: s.kind as
            "signed_application" | "bank_statement" | "drivers_license" | "voided_check",
          ...(s.period ? { period: s.period } : {}),
        });
      expect(await liveBucket(id)).toBe("ready_for_ops");
      return id;
    };
    const statements = async (id: string) =>
      (
        await t.pool.query<{ p: string }>(
          "select period::text as p from stips where client_id = $1 and kind = 'bank_statement' and required order by period",
          [id],
        )
      ).rows.map((r) => r.p);

    it("asks for the new month once the 5th has passed, once, and moves the merchant to Need newest statement", async () => {
      const id = await complete("Fresh Co", "2026-10-10"); // June to September
      expect(await runStatementClock(t.db, "2026-11-04")).toBe(0);
      expect(await statements(id)).toEqual([
        "2026-06-01",
        "2026-07-01",
        "2026-08-01",
        "2026-09-01",
      ]);

      expect(await runStatementClock(t.db, TODAY)).toBeGreaterThanOrEqual(1);
      expect(await statements(id)).toEqual([
        "2026-06-01",
        "2026-07-01",
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
      ]);
      expect((await ticked(id))["bank_statement:2026-10-01"]).toBe(false);
      expect(await liveBucket(id)).toBe("missing_newest");
      const asked = await t.pool.query<{ body: string }>(
        "select body from activities where client_id = $1 and body like 'The month turned%'",
        [id],
      );
      expect(asked.rows.map((r) => r.body)).toEqual([
        "The month turned: asked for the October 2026 statement",
      ]);

      // once: the next night adds nothing
      const before = await t.pool.query(
        "select count(*)::int as n from stips where client_id = $1",
        [id],
      );
      await runStatementClock(t.db, addDays(TODAY, 1));
      const after = await t.pool.query(
        "select count(*)::int as n from stips where client_id = $1",
        [id],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);

      // the merchant sends October: ready again
      await upload(id, { filename: "oct.pdf", kind: "bank_statement", period: "2026-10-01" });
      expect(await liveBucket(id)).toBe("ready_for_ops");
    });

    it("a checklist months behind gets every month the file needs, and lands in Missing statements", async () => {
      const id = await complete("Stale Co", "2026-08-10"); // April to July
      await runStatementClock(t.db, TODAY);
      expect((await statements(id)).slice(-3)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
      expect(await liveBucket(id)).toBe("missing_statements");
    });

    it("leaves brought-in, trashed, Cold and paused merchants alone", async () => {
      const done = await complete("Handed Co", "2026-10-10");
      await t.db.withUser(rep, (q) => handOff(q, done));
      const trashed = await complete("Trash Co", "2026-10-10");
      await t.db.withUser(rep, (q) => q.query("select trash_client($1)", [trashed]));
      const cold = await complete("Cold Co", "2026-10-10");
      await t.pool.query("select enroll_in_bucket($1, $2)", [cold, await bucketId("cold")]);
      const paused = await complete("Paused Co", "2026-10-10");
      await t.pool.query(
        "update enrollments set paused = true where client_id = $1 and stopped_at is null",
        [paused],
      );

      await runStatementClock(t.db, TODAY);
      for (const id of [done, trashed, cold, paused])
        expect((await statements(id)).at(-1)).toBe("2026-09-01");
      expect(await liveBucket(done)).toBeNull();
      expect(await liveBucket(cold)).toBe("cold");
      expect(await liveBucket(paused)).toBe("ready_for_ops");
    });

    it("a rep cannot run the clock", async () => {
      await expect(
        t.db.withUser(rep, (q) => q.query("select request_new_month_statements()")),
      ).rejects.toThrow(/only a manager/);
    });
  });
});
