import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileNewSheetRows } from "@/lib/sheets/file";
import {
  guessMapping,
  isLeadRow,
  parseMonthsInBusiness,
  parseRow,
  spreadsheetIdFrom,
  gidFrom,
} from "@/lib/sheets/mapping";
import { syncSheets } from "@/lib/sheets/sync";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

describe("sheet mapping (pure)", () => {
  it("guesses columns from a vendor's header row", () => {
    const m = guessMapping([
      "Date",
      "Business Name",
      "Owner",
      "Cell Phone",
      "Email Address",
      "Industry",
      "State",
      "Monthly Revenue",
      "Years in Business",
      "Amount Requested",
      "Notes",
      "Phone 2",
    ]);
    expect(m).toEqual({
      business_name: 1,
      contact_name: 2,
      phone: 3,
      email: 4,
      industry: 5,
      state: 6,
      monthly_revenue: 7,
      time_in_business: 8,
      wanted: 9,
      notes: 10,
      phone2: 11,
    });
  });
  it("parses a row: phone key is the last ten digits, state is normalised, revenue to cents", () => {
    const m = guessMapping([
      "First Name",
      "Last Name",
      "Phone",
      "Email",
      "State",
      "Revenue",
      "TIB",
    ]);
    const r = parseRow(
      ["Mike", "Ross", "(305) 555-0100", "MIKE@X.COM", "florida", "$45,000", "3 years"],
      m,
    );
    expect(r.contact_name).toBe("Mike Ross");
    expect(r.business_name).toBe("Mike Ross");
    expect(r.phone_key).toBe("3055550100");
    expect(r.email).toBe("mike@x.com");
    expect(r.state).toBe("FL");
    expect(r.monthly_revenue_cents).toBe(4_500_000);
    expect(r.time_in_business_months).toBe(36);
    expect(isLeadRow(r)).toBe(true);
    expect(isLeadRow(parseRow(["", "", "", "", "", "", ""], m))).toBe(false);
  });
  it("time in business in the shapes vendors use", () => {
    expect(parseMonthsInBusiness("2 yrs 4 mos")).toBe(28);
    expect(parseMonthsInBusiness("18 months")).toBe(18);
    expect(parseMonthsInBusiness("2019", 2026)).toBe(84);
    expect(parseMonthsInBusiness("")).toBeNull();
  });
  it("reads the id and tab out of a pasted link", () => {
    expect(
      spreadsheetIdFrom(
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=1234",
      ),
    ).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(gidFrom("https://docs.google.com/spreadsheets/d/x/edit#gid=1234")).toBe(1234);
    expect(spreadsheetIdFrom("not a link")).toBeNull();
  });
});

describe("sync and file, from a real database with a fake Google", () => {
  let t: TestDb;
  let rep: string;
  let sourceId: string;
  const sheet: string[][] = [
    ["Business", "Owner", "Phone", "Email", "State", "Amount"],
    ["Sunrise Dental", "Alan Weiss", "646-555-0113", "alan@sunrise.com", "NY", "120k"],
    ["Golden Wok", "David Chen", "(212) 555-0182", "david@wok.com", "NY", "80k"],
    ["", "", "", "", "", ""],
  ];
  const fakeFetch: typeof fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/values/"))
      return new Response(JSON.stringify({ values: sheet }), { status: 200 });
    return new Response(
      JSON.stringify({
        properties: { title: "Leads" },
        sheets: [{ properties: { title: "Nov", sheetId: 0 } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const tokenFor = async () => "tok";

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    await t.pool.query(
      "update app_users set application_link = 'https://apply.test/x', name = 'Sam' where id = $1",
      [rep],
    );
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_sheets) values ($1, 'rep@selectivecap.com', 'enc', 's', 'ok', true)",
      [rep],
    );
    const interested = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]?.id;
    sourceId = (
      await t.pool.query<{ id: string }>(
        "insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, target_bucket_id, auto_file, reader_user_id) values ($1, 'Vendor A', 'sheet1', '', $2, true, $1) returning id",
        [rep, interested],
      )
    ).rows[0]?.id as string;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("the first sync stages every lead row, guesses the mapping, and skips blank rows", async () => {
    const s = await syncSheets({ db: t.db, tokenFor, fetchImpl: fakeFetch });
    expect(s).toMatchObject({ sources: 1, rows: 2, added: 2, changed: 0, failed: [] });
    const rows = await t.pool.query<{ phone_key: string; business_name: string; state: string }>(
      "select phone_key, business_name, state from sheet_rows order by row_no",
    );
    expect(rows.rows).toEqual([
      { phone_key: "6465550113", business_name: "Sunrise Dental", state: "NY" },
      { phone_key: "2125550182", business_name: "Golden Wok", state: "NY" },
    ]);
    const src = await t.pool.query<{
      mapping: Record<string, number>;
      sheet_title: string;
      row_count: number;
    }>("select mapping, sheet_title, row_count from sheet_sources where id = $1", [sourceId]);
    expect(src.rows[0]?.mapping.phone).toBe(2);
    expect(src.rows[0]?.sheet_title).toBe("Nov");
    expect(src.rows[0]?.row_count).toBe(2);
  });
  it("a second sync with no changes adds nothing; an edited row counts as changed", async () => {
    let s = await syncSheets({ db: t.db, tokenFor, fetchImpl: fakeFetch });
    expect(s).toMatchObject({ added: 0, changed: 0 });
    sheet[2] = ["Golden Wok", "David Chen", "(212) 555-0182", "david@goldenwok.com", "NY", "80k"];
    s = await syncSheets({ db: t.db, tokenFor, fetchImpl: fakeFetch });
    expect(s).toMatchObject({ added: 0, changed: 1 });
  });
  it("the lookup finds a row by any spelling of the number", async () => {
    const r = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ business_name: string }>("select business_name from sheet_lookup($1)", [
            "+1 (646) 555 0113",
          ])
        ).rows[0],
    );
    expect(r?.business_name).toBe("Sunrise Dental");
  });
  it("the daily loop files new rows into the bucket with a welcome email on the intake lane, once", async () => {
    const f = await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(f).toMatchObject({ filed: 2, duplicates: 0 });
    const clients = await t.pool.query<{
      business_name: string;
      lead_source_kind: string;
      source: string;
    }>("select business_name, lead_source_kind, source from clients order by business_name");
    expect(clients.rows).toEqual([
      { business_name: "Golden Wok", lead_source_kind: "sheet", source: "Vendor A" },
      { business_name: "Sunrise Dental", lead_source_kind: "sheet", source: "Vendor A" },
    ]);
    const enrol = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from enrollments where stopped_at is null",
    );
    expect(enrol.rows[0]?.n).toBe(2);
    const ob = await t.pool.query<{ lane: string; status: string; subject: string }>(
      "select lane, status, subject from outbox order by created_at",
    );
    expect(ob.rows).toHaveLength(2);
    expect(ob.rows.every((o) => o.lane === "intake")).toBe(true);
    expect(ob.rows[0]?.subject).toContain("Sunrise Dental");
    // run again: nothing new
    expect(await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" })).toMatchObject({
      filed: 0,
    });
  });
  it("a vendor re-sending the same number is a duplicate, not a second merchant", async () => {
    sheet.push([
      "Sunrise Dental Group",
      "A. Weiss",
      "646.555.0113",
      "alan@sunrise.com",
      "NY",
      "150k",
    ]);
    await syncSheets({ db: t.db, tokenFor, fetchImpl: fakeFetch });
    const f = await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(f).toMatchObject({ filed: 0, duplicates: 1 });
    expect(
      (await t.pool.query<{ n: number }>("select count(*)::int as n from clients")).rows[0]?.n,
    ).toBe(2);
  });
  it("a sheet the account cannot read is reported, not crashed", async () => {
    const deny: typeof fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    const s = await syncSheets({ db: t.db, tokenFor, fetchImpl: deny });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]?.error).toMatch(/can't read that sheet/);
    const src = await t.pool.query<{ last_error: string }>(
      "select last_error from sheet_sources where id = $1",
      [sourceId],
    );
    expect(src.rows[0]?.last_error).toMatch(/can't read/);
  });
});
