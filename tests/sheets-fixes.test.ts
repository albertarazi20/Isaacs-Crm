import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileNewSheetRows } from "@/lib/sheets/file";
import {
  guessMapping,
  parseMonthsInBusiness,
  parseRow,
  tibUnitFromHeader,
} from "@/lib/sheets/mapping";
import { updateSheetSource } from "@/lib/sheets/sources";
import { syncSheets } from "@/lib/sheets/sync";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

describe("sheet cell parsing", () => {
  it("a bare number takes the header's unit; unnamed keeps the old rule: up to 40 is years, above is months", () => {
    expect(parseMonthsInBusiness("36", 2026, "months")).toBe(36);
    expect(parseMonthsInBusiness("3", 2026, "years")).toBe(36);
    expect(parseMonthsInBusiness("5")).toBe(60);
    expect(parseMonthsInBusiness("13")).toBe(156);
    expect(parseMonthsInBusiness("24")).toBe(288);
    expect(parseMonthsInBusiness("40")).toBe(480);
    expect(parseMonthsInBusiness("41")).toBe(41);
    expect(parseMonthsInBusiness("60")).toBe(60);
    expect(parseMonthsInBusiness("120")).toBe(120);
  });
  it("an implausible number (a pasted phone) is not a business age", () => {
    expect(parseMonthsInBusiness("5551234567")).toBeNull();
    expect(parseMonthsInBusiness("40 years")).toBe(480);
    expect(parseMonthsInBusiness("900 years")).toBeNull();
  });
  it("reads the unit out of the header", () => {
    const header = ["Name", "Phone", "Months in business"];
    const map = guessMapping(header);
    expect(tibUnitFromHeader(header, map)).toBe("months");
    expect(parseRow(["A", "646-555-0113", "36"], map, "months").time_in_business_months).toBe(36);
  });
  it("a revenue that overflows the column is dropped, and line breaks leave names", () => {
    const map = guessMapping(["Business", "Phone", "Revenue", "Notes"]);
    const r = parseRow(["Joe\nPlumbing", "646-555-0113", "99999999999999999999", "a\nb"], map);
    expect(r.monthly_revenue_cents).toBeNull();
    expect(r.business_name).toBe("Joe Plumbing");
    expect(r.notes).toBe("a\nb");
  });
});

describe("sheet sync and filing against a real database", () => {
  let t: TestDb;
  let rep: string;
  let sourceId: string;
  let sheet: string[][] = [];
  const fakeFetch: typeof fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("/values/"))
      return new Response(JSON.stringify({ values: sheet }), { status: 200 });
    return new Response(
      JSON.stringify({
        properties: { title: "L" },
        sheets: [{ properties: { title: "Nov", sheetId: 0 } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const tokenFor = async () => "tok";
  const sync = () => syncSheets({ db: t.db, tokenFor, fetchImpl: fakeFetch });
  const unfiled = async () =>
    (
      await t.pool.query<{ business_name: string }>(
        "select business_name from sheet_rows where filed_at is null and client_id is null order by row_no",
      )
    ).rows.map((r) => r.business_name);

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_sheets) values ($1, 'rep@selectivecap.com', 'enc', 's', 'ok', true)",
      [rep],
    );
    const interested = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]?.id;
    sourceId = (
      await t.pool.query<{ id: string }>(
        "insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, target_bucket_id, auto_file, reader_user_id) values ($1, 'Vendor', 'sheet1', '', $2, true, $1) returning id",
        [rep, interested],
      )
    ).rows[0]?.id as string;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("a lead inserted above a filed row is staged as new, not hidden behind the filed one", async () => {
    sheet = [
      ["Business", "Owner", "Phone", "Email"],
      ["Mikes Pizza", "Mike Ross", "646-555-0101", "mike@x.com"],
    ];
    await sync();
    await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(await unfiled()).toEqual([]);
    // the vendor inserts Acme above Mike: Acme now sits on row 2, Mike on row 3
    sheet = [
      sheet[0] as string[],
      ["Acme Plumbing", "Ann Lee", "212-555-0199", "ann@acme.com"],
      ["Mikes Pizza", "Mike Ross", "646-555-0101", "mike@x.com"],
    ];
    await sync();
    expect(await unfiled()).toContain("Acme Plumbing");
    const f = await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(f.filed).toBe(1);
    const names = (
      await t.pool.query<{ business_name: string }>("select business_name from clients")
    ).rows;
    expect(names.map((n) => n.business_name).sort()).toEqual(["Acme Plumbing", "Mikes Pizza"]);
  });

  it("fixing a filed lead's phone keeps it filed (an edit, not a different lead)", async () => {
    sheet = [
      sheet[0] as string[],
      ["Acme Plumbing", "Ann Lee", "212-555-0188", "ann@acme.com"],
      ["Mikes Pizza", "Mike Ross", "646-555-0101", "mike@x.com"],
    ];
    await sync();
    expect(await unfiled()).toEqual([]);
  });

  it("a mapping fix re-reads staged rows whose cells did not change", async () => {
    await t.pool.query("update sheet_rows set filed_at = null, client_id = null");
    await t.pool.query("update sheet_sources set mapping = $2 where id = $1", [
      sourceId,
      JSON.stringify({ business_name: 0, contact_name: 1, phone: 2, email: 3 }),
    ]);
    // the manager points "Owner" at the business name instead
    await t.pool.query("update sheet_sources set mapping = $2 where id = $1", [
      sourceId,
      JSON.stringify({ business_name: 1, phone: 2, email: 3 }),
    ]);
    const s = await sync();
    expect(s.changed).toBeGreaterThan(0);
    const r = await t.pool.query<{ business_name: string }>(
      "select business_name from sheet_rows where row_no = 3",
    );
    expect(r.rows[0]?.business_name).toBe("Mike Ross");
  });

  it("one row the database refuses is skipped; the rest of the sheet still syncs", async () => {
    await t.pool.query("update sheet_sources set mapping = '{}' where id = $1", [sourceId]);
    sheet = [
      ["Business", "Owner", "Phone", "Email", "Notes"],
      ["Bad Cell Co", "Bo", "305-555-0111", "bo@x.com", "has a null \u0000 byte"],
      ["Good Cell Co", "Gus", "305-555-0112", "gus@x.com", "fine"],
    ];
    const s = await sync();
    expect(s.failed).toEqual([]);
    expect(s.skipped).toBe(1);
    const r = await t.pool.query<{ business_name: string }>(
      "select business_name from sheet_rows where business_name in ('Bad Cell Co', 'Good Cell Co')",
    );
    expect(r.rows.map((x) => x.business_name)).toEqual(["Good Cell Co"]);
  });

  it("a note with an SSN is not copied onto the merchant", async () => {
    sheet = [
      ["Business", "Owner", "Phone", "Email", "Notes"],
      ["Sensitive Co", "Sue", "305-555-0120", "sue@x.com", "SSN 123-45-6789, wants 50k"],
    ];
    await sync();
    await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    const c = await t.pool.query<{ id: string }>(
      "select id from clients where business_name = 'Sensitive Co'",
    );
    expect(c.rows).toHaveLength(1);
    const notes = await t.pool.query(
      "select body from activities where client_id = $1 and body like '%123-45-6789%'",
      [c.rows[0]?.id],
    );
    expect(notes.rows).toHaveLength(0);
  });

  it("settings can clear a sheet's target bucket, and an absent field leaves it alone", async () => {
    const bucket = async () =>
      (
        await t.pool.query<{ target_bucket_id: string | null }>(
          "select target_bucket_id from sheet_sources where id = $1",
          [sourceId],
        )
      ).rows[0]?.target_bucket_id;
    expect(await bucket()).not.toBeNull();
    await t.db.withUser(rep, (q) => updateSheetSource(q, { id: sourceId, autoFile: true }));
    expect(await bucket()).not.toBeNull();
    await t.db.withUser(rep, (q) => updateSheetSource(q, { id: sourceId, targetBucketId: null }));
    expect(await bucket()).toBeNull();
  });
});
