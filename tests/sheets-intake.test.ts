import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import { intakeLead, intakeSchema } from "@/lib/leads/form";
import {
  fileNewSheetRows,
  fileOneRow,
  PENDING_ROW_COLUMNS,
  type PendingRow,
} from "@/lib/sheets/file";
import {
  connectSheet,
  connectSheetSchema,
  sheetNameFor,
  updateSheetSchema,
  updateSheetSource,
} from "@/lib/sheets/sources";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Pass 2 of the manual plan (docs/ISSUES.md): P2-15 connect with no name, P2-16 toggles with no mapping,
 * P2-8 a sheet lead whose "looking for" is a sentence, P2-17 revenue already in cents, P2-21 junk amounts,
 * P2-9 whose duplicate it is, P2-10 the stamped time zone.
 */

let t: TestDb;
let rep: string;
let sourceId: string;
let statements: string;

const fakeFetch: typeof fetch = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes("/values/"))
    return new Response(JSON.stringify({ values: [["Business", "Phone"]] }), { status: 200 });
  return new Response(
    JSON.stringify({
      properties: { title: "Leads — Vendor B" },
      sheets: [{ properties: { title: "Nov", sheetId: 0 } }],
    }),
    { status: 200 },
  );
}) as typeof fetch;
const tokenFor = async () => "tok";

const asRep = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(rep, fn);
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows[0];

async function stageRow(fields: Partial<PendingRow> & { row_no: number }): Promise<string> {
  const r = await one<{ id: string }>(
    `insert into sheet_rows (source_id, row_no, phone_key, business_name, contact_name, email, email2, phone, phone2,
                             industry, state, monthly_revenue_cents, wanted, notes, row_hash)
     values ($1, $2, right(regexp_replace($3, '\\D', '', 'g'), 10), $4, $5, $6, $7, $3, $8, $9, $10, $11, $12, $13, md5(($2::int)::text))
     returning id`,
    [
      sourceId,
      fields.row_no,
      fields.phone ?? "",
      fields.business_name ?? "",
      fields.contact_name ?? "",
      fields.email ?? "",
      fields.email2 ?? "",
      fields.phone2 ?? "",
      fields.industry ?? "",
      fields.state ?? "",
      fields.monthly_revenue_cents ?? null,
      fields.wanted ?? "",
      fields.notes ?? "",
    ],
  );
  return r?.id as string;
}
const pendingRow = (id: string) =>
  asRep(
    async (q) =>
      (
        await q.query<PendingRow>(
          `select app.current_user_id() as owner_id, ${PENDING_ROW_COLUMNS}
             from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
          [id],
        )
      ).rows[0] as PendingRow,
  );

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "sam@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rivera' where id = $1",
    [rep],
  );
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_sheets) values ($1, 'sam@selectivecap.com', 'enc', 's', 'ok', true)",
    [rep],
  );
  statements = (
    await one<{ id: string }>("select id from buckets where key = 'missing_statements'")
  )?.id as string;
  sourceId = (
    await one<{ id: string }>(
      `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, mapping, target_bucket_id, auto_file, reader_user_id)
       values ($1, 'Vendor A', 'sheetA', 'Nov', '{"business_name": 0, "phone": 2}', null, true, $1) returning id`,
      [rep],
    )
  )?.id as string;
});
afterAll(async () => {
  await t.drop();
});

describe("P2-15: Connect without a name", () => {
  it("the panel's payload (no name) passes the schema", () => {
    const i = connectSheetSchema.parse({
      url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0",
      tab: "",
      targetBucketId: null,
      autoFile: false,
      shared: false,
    });
    expect(i.name).toBe("");
  });
  it("the name falls back to the spreadsheet's title, then the tab", () => {
    expect(sheetNameFor("", "Leads — Vendor B", "Nov")).toBe("Leads — Vendor B");
    expect(sheetNameFor("", "", "Nov")).toBe("Nov");
    expect(sheetNameFor("", "", "")).toBe("Sheet");
    expect(sheetNameFor("Mine", "Leads", "Nov")).toBe("Mine");
    expect(sheetNameFor("", "x".repeat(100), "")).toHaveLength(80);
  });
  it("connecting with no name creates the source named after the spreadsheet and syncs it", async () => {
    const r = await connectSheet({
      db: t.db,
      userId: rep,
      input: connectSheetSchema.parse({
        url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0",
      }),
      tokenFor,
      fetchImpl: fakeFetch,
    });
    expect(r.tabs).toEqual(["Nov"]);
    const src = await one<{
      name: string;
      sheet_title: string;
      owner_id: string;
      mapping: unknown;
    }>("select name, sheet_title, owner_id, mapping from sheet_sources where id = $1", [r.id]);
    expect(src).toMatchObject({ name: "Leads — Vendor B", sheet_title: "Nov", owner_id: rep });
    expect(src?.mapping).toEqual({ business_name: 0, phone: 1 });
  });
});

describe("P2-16: Auto-file / Turn off keep the column mapping", () => {
  it("a toggle with no mapping passes the schema; a partial mapping passes; a bad column does not", () => {
    expect(updateSheetSchema.parse({ id: crypto.randomUUID(), autoFile: true }).mapping).toBe(
      undefined,
    );
    expect(
      updateSheetSchema.parse({ id: crypto.randomUUID(), mapping: { phone: 3 } }).mapping,
    ).toEqual({
      phone: 3,
    });
    expect(() =>
      updateSheetSchema.parse({ id: crypto.randomUUID(), mapping: { phone: -1 } }),
    ).toThrow();
    expect(() =>
      updateSheetSchema.parse({ id: crypto.randomUUID(), mapping: { nope: 1 } }),
    ).toThrow();
  });
  it("auto-file off, then the sheet off, leave the stored mapping as it was", async () => {
    await asRep((q) => updateSheetSource(q, { id: sourceId, autoFile: false }));
    let src = await one<{ auto_file: boolean; active: boolean; mapping: unknown }>(
      "select auto_file, active, mapping from sheet_sources where id = $1",
      [sourceId],
    );
    expect(src).toEqual({
      auto_file: false,
      active: true,
      mapping: { business_name: 0, phone: 2 },
    });
    await asRep((q) => updateSheetSource(q, { id: sourceId, active: false }));
    src = await one("select auto_file, active, mapping from sheet_sources where id = $1", [
      sourceId,
    ]);
    expect(src).toEqual({
      auto_file: false,
      active: false,
      mapping: { business_name: 0, phone: 2 },
    });
    // back on for the filing tests below
    await asRep((q) => updateSheetSource(q, { id: sourceId, active: true, autoFile: true }));
  });
  it("a mapping that is sent replaces the stored one", async () => {
    await asRep((q) =>
      updateSheetSource(q, { id: sourceId, mapping: { business_name: 1, phone: 0 } }),
    );
    const src = await one<{ mapping: unknown }>("select mapping from sheet_sources where id = $1", [
      sourceId,
    ]);
    expect(src?.mapping).toEqual({ business_name: 1, phone: 0 });
  });
});

describe("P2-8 / P2-17 / P2-10: a lead that autofilled from a sheet row", () => {
  let rowId: string;
  let clientId: string;
  beforeAll(async () => {
    rowId = await stageRow({
      row_no: 2,
      business_name: "Harbor Tacos",
      contact_name: "Rosa Diaz",
      phone: "(310) 555-0199",
      email: "rosa@harbortacos.com",
      state: "CA",
      industry: "Restaurant",
      monthly_revenue_cents: 6_500_000,
      wanted: "$60k for a second truck",
      notes: "Called twice, wants a callback after 3pm",
    });
  });

  it("is filed as a merchant: looking_for is the sentence, the typed amount is the ask, revenue stays in cents", async () => {
    const out = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({
          firstName: "Rosa",
          lastName: "Diaz",
          businessName: "Harbor Tacos",
          phone: "3105550199",
          email: "rosa@harbortacos.com",
          phone2: "3105550200",
          email2: "rosa.d@gmail.com",
          state: "CA",
          lookingFor: "$60k for a second truck",
          wantedAmount: "60k",
          bucketId: statements,
          sheetRowId: rowId,
        }),
        "https://crm.test",
      ),
    );
    expect(out).toMatchObject({
      result: "filed",
      businessName: "Harbor Tacos",
      bucketName: "Missing statements",
      welcomeSent: true,
      existing: null,
    });
    clientId = out.clientId;
    const c = await one<Record<string, unknown>>(
      `select business_name, contact_name, phone, phone2, email, email2, looking_for, state, industry, source,
              lead_source_kind, monthly_revenue_cents::int as monthly_revenue_cents, timezone, timezone_source
         from clients where id = $1`,
      [clientId],
    );
    expect(c).toEqual({
      business_name: "Harbor Tacos",
      contact_name: "Rosa Diaz",
      phone: "3105550199",
      phone2: "3105550200",
      email: "rosa@harbortacos.com",
      email2: "rosa.d@gmail.com",
      looking_for: "$60k for a second truck",
      state: "CA",
      industry: "Restaurant",
      source: "Vendor A",
      lead_source_kind: "sheet",
      monthly_revenue_cents: 6_500_000, // P2-17: not ×100
      timezone: "America/Los_Angeles", // P2-10: from the state
      timezone_source: "state",
    });
    const ask = await one<{ cents: number }>(
      "select wanted_amount_cents::int as cents from client_asks where client_id = $1",
      [clientId],
    );
    expect(ask?.cents).toBe(6_000_000);
    const row = await one<{ client_id: string | null; filed: boolean }>(
      "select client_id, filed_at is not null as filed from sheet_rows where id = $1",
      [rowId],
    );
    expect(row).toEqual({ client_id: clientId, filed: true });
    const enrol = await one<{ n: number }>(
      "select count(*)::int as n from enrollments where client_id = $1 and bucket_id = $2 and stopped_at is null",
      [clientId, statements],
    );
    expect(enrol?.n).toBe(1);
    const ob = await one<{ lane: string; status: string; subject: string }>(
      "select lane, status, subject from outbox where client_id = $1",
      [clientId],
    );
    expect(ob).toMatchObject({ lane: "intake", status: "queued" });
    expect(ob?.subject).toContain("Harbor Tacos");
    const note = await one<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'note'",
      [clientId],
    );
    expect(note?.body).toBe("From the sheet: Called twice, wants a callback after 3pm");
  });

  it("P2-9: the same number again is a duplicate that says whose it is and where it sits", async () => {
    const out = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({ phone: "310-555-0199", businessName: "Harbor Tacos LLC" }),
        "https://crm.test",
      ),
    );
    expect(out).toEqual({
      clientId,
      businessName: "Harbor Tacos",
      result: "duplicate",
      welcomeSent: false,
      bucketName: null,
      existing: { ownerName: "Sam Rivera", place: "Missing statements" },
    });
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))?.n).toBe(1);
  });

  it("a sheet amount that is a plain number becomes the ask by itself, and the area code gives the zone", async () => {
    const id = await stageRow({
      row_no: 3,
      business_name: "Golden Wok",
      contact_name: "David Chen",
      phone: "2125550182",
      wanted: "80k",
    });
    const out = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({ phone: "2125550182", lookingFor: "", sheetRowId: id }),
        "https://crm.test",
      ),
    );
    expect(out.result).toBe("filed");
    const c = await one<Record<string, unknown>>(
      `select c.looking_for, c.timezone, c.timezone_source, a.wanted_amount_cents::int as ask
         from clients c left join client_asks a on a.client_id = c.id where c.id = $1`,
      [out.clientId],
    );
    expect(c).toEqual({
      looking_for: "",
      timezone: "America/New_York",
      timezone_source: "area_code",
      ask: 8_000_000,
    });
  });

  it("when the merchant cannot be made, the row stays unfiled and the reason comes back in words", async () => {
    const id = await stageRow({
      row_no: 4,
      business_name: "Bad\u0001Row",
      contact_name: "Ctrl Char",
      phone: "7025550111",
    });
    const err = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({ phone: "7025550111", sheetRowId: id }),
        "https://crm.test",
      ),
    ).catch((e: unknown) => e);
    expect(toActionError(err)).toBe("That field can't contain line breaks or control characters");
    const row = await one<{ client_id: string | null; filed_at: string | null }>(
      "select client_id, filed_at from sheet_rows where id = $1",
      [id],
    );
    expect(row).toEqual({ client_id: null, filed_at: null });
    expect(
      (await one<{ n: number }>("select count(*)::int as n from clients where phone like '%0111'"))
        ?.n,
    ).toBe(0);
  });

  it("the daily loop counts such a row as skipped and leaves it for a corrected sheet, filing the rest", async () => {
    await stageRow({
      row_no: 5,
      business_name: "Sunrise Dental",
      contact_name: "Alan Weiss",
      phone: "6465550113",
      monthly_revenue_cents: 4_500_000,
      wanted: "120k",
    });
    const f = await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(f).toMatchObject({ filed: 1, duplicates: 0, skipped: 1 });
    const bad = await one<{ filed_at: string | null }>(
      "select filed_at from sheet_rows where row_no = 4 and source_id = $1",
      [sourceId],
    );
    expect(bad?.filed_at).toBeNull();
    const dental = await one<{ cents: number; looking_for: string }>(
      "select monthly_revenue_cents::int as cents, looking_for from clients where business_name = 'Sunrise Dental'",
    );
    expect(dental).toEqual({ cents: 4_500_000, looking_for: "" });
  });

  it("fileOneRow reports a duplicate with the match, and marks the row as that merchant's", async () => {
    const id = await stageRow({ row_no: 6, business_name: "Harbor Tacos", phone: "3105550199" });
    const out = await asRep(async (q) => fileOneRow(q, await pendingRow(id), "https://crm.test"));
    expect(out).toMatchObject({
      result: "duplicate",
      clientId,
      match: {
        business_name: "Harbor Tacos",
        owner_name: "Sam Rivera",
        bucket_name: "Missing statements",
      },
    });
    const row = await one<{ client_id: string | null }>(
      "select client_id from sheet_rows where id = $1",
      [id],
    );
    expect(row?.client_id).toBe(clientId);
  });
});

describe("P2-21 / P2-10: the typed-in lead", () => {
  it("junk in 'Amount they want' is refused with the money message, not dropped", () => {
    const err = (() => {
      try {
        intakeSchema.parse({ phone: "3055550100", wantedAmount: "lots" });
      } catch (e) {
        return toActionError(e);
      }
      return null;
    })();
    expect(err).toBe("Enter an amount like 50k or $75,000");
    expect(intakeSchema.parse({ phone: "3055550100", wantedAmount: "" }).wantedAmount).toBeNull();
    expect(intakeSchema.parse({ phone: "3055550100" }).wantedAmount ?? null).toBeNull();
    expect(intakeSchema.parse({ phone: "3055550100", wantedAmount: "50k" }).wantedAmount).toBe(
      5_000_000,
    );
  });
  it("a lead typed in with no state gets its zone from the area code; with neither, none is stamped", async () => {
    const miami = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({ phone: "(305) 555-0100", businessName: "Bella Nails", state: "" }),
        "https://crm.test",
      ),
    );
    expect(miami.result).toBe("created");
    expect(
      await one("select timezone, timezone_source, lead_source_kind from clients where id = $1", [
        miami.clientId,
      ]),
    ).toEqual({
      timezone: "America/New_York",
      timezone_source: "area_code",
      lead_source_kind: "own_form",
    });
    const nowhere = await asRep((q) =>
      intakeLead(
        q,
        intakeSchema.parse({ phone: "5550100", businessName: "Short Number Co" }),
        "https://crm.test",
      ),
    );
    expect(
      await one("select timezone, timezone_source from clients where id = $1", [nowhere.clientId]),
    ).toEqual({ timezone: null, timezone_source: null });
  });
});
