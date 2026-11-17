import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import { intakeLead, intakeSchema } from "@/lib/leads/form";
import { OwnedElsewhereError, ownedElsewhereMessage, touchedAgo } from "@/lib/leads/owner";
import {
  fileManyRows,
  fileNewSheetRows,
  fileOneRow,
  PENDING_ROW_COLUMNS,
  type PendingRow,
} from "@/lib/sheets/file";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Stream 1 (docs/AUTOMATION-AUDIT.md): intake.
 *   S1-3  Cross-rep duplicate block: a rep is refused in words; a manager gets the ordinary duplicate outcome.
 *   S1-10 The intake form's own path opens the "call now" task due today.
 *   S1-9  Time in business is copied from the sheet row.
 */

let t: TestDb;
let mike: string;
let dana: string;
let manager: string;
let danasSheet: string;
let statements: string;
let harbor: string;

const as = <T>(
  user: string,
  fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>,
) => t.db.withUser(user, fn);
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows[0];

async function stageRow(
  source: string,
  fields: Partial<PendingRow> & { row_no: number },
): Promise<string> {
  const r = await one<{ id: string }>(
    `insert into sheet_rows (source_id, row_no, phone_key, business_name, contact_name, email, phone, state,
                             time_in_business_months, row_hash)
     values ($1, $2, right(regexp_replace($3, '\\D', '', 'g'), 10), $4, $5, $6, $3, $7, $8, md5(($2::int)::text))
     returning id`,
    [
      source,
      fields.row_no,
      fields.phone ?? "",
      fields.business_name ?? "",
      fields.contact_name ?? "",
      fields.email ?? "",
      fields.state ?? "",
      fields.time_in_business_months ?? null,
    ],
  );
  return r!.id;
}
const pendingRow = (user: string, id: string) =>
  as(
    user,
    async (q) =>
      (
        await q.query<PendingRow>(
          `select app.current_user_id() as owner_id, ${PENDING_ROW_COLUMNS}
             from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
          [id],
        )
      ).rows[0]!,
  );

beforeAll(async () => {
  t = await createTestDb();
  mike = await insertUser(t.pool, "mike@x.com");
  dana = await insertUser(t.pool, "dana@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set name = 'Mike Jones' where id = $1", [mike]);
  await t.pool.query("update app_users set name = 'Dana Lee' where id = $1", [dana]);
  await t.pool.query("update app_users set role = 'manager', name = 'Pat Boss' where id = $1", [
    manager,
  ]);
  statements = (await one<{ id: string }>(
    "select id from buckets where key = 'missing_statements'",
  ))!.id;
  danasSheet = (await one<{ id: string }>(
    `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, mapping, target_bucket_id, auto_file, reader_user_id)
       values ($1, 'Dana vendor', 'sheetD', 'Nov', '{"business_name": 0, "phone": 1}', $2, true, $1) returning id`,
    [dana, statements],
  ))!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("S1-10: a lead typed into the form is a call to make today", () => {
  it("creates the merchant with one open follow-up due today, 'New lead — call now'", async () => {
    const out = await as(mike, (q) =>
      intakeLead(
        q,
        intakeSchema.parse({
          firstName: "Rosa",
          lastName: "Diaz",
          businessName: "Harbor Tacos",
          phone: "3105550199",
          email: "rosa@harbortacos.com",
          state: "CA",
          bucketId: statements,
        }),
        "https://crm.test",
      ),
    );
    expect(out.result).toBe("created");
    harbor = out.clientId;
    const timers = await t.pool.query<{ kind: string; due_on: string; note: string }>(
      "select kind, due_on::text, note from timers where client_id = $1 and done_at is null",
      [harbor],
    );
    expect(timers.rows).toEqual([
      { kind: "follow_up", due_on: t.today, note: "New lead — call now" },
    ]);
  });
});

describe("S1-3: a merchant another rep owns", () => {
  it("the wording", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(touchedAgo("2026-11-16T09:00:00Z", now)).toBe("today");
    expect(touchedAgo("2026-11-15T09:00:00Z", now)).toBe("yesterday");
    expect(touchedAgo("2026-11-13T11:00:00Z", now)).toBe("3 days ago");
    expect(touchedAgo(null, now)).toBe("never");
    expect(
      ownedElsewhereMessage(
        {
          client_id: "c",
          owner_id: "u",
          owner_name: "mike jones",
          owner_email: "mike@x.com",
          business_name: "Harbor Tacos",
          bucket_name: null,
          stage: "application_in",
          last_touch_at: "2026-11-15T09:00:00Z",
          matched_on: "phone",
        },
        now,
      ),
    ).toBe("Already in the system: Mike's lead, in Application in, touched yesterday");
  });

  it("the intake form refuses another rep with the owner, the bucket and the last touch; nothing is written", async () => {
    await t.pool.query(
      "update activities set occurred_at = now() - interval '3 days' where client_id = $1",
      [harbor],
    );
    const attempt = (user: string, phone: string, email = "") =>
      as(user, (q) =>
        intakeLead(
          q,
          intakeSchema.parse({ businessName: "Harbor Tacos LLC", phone, email }),
          "https://crm.test",
        ),
      );
    const err = await attempt(dana, "(310) 555-0199").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnedElsewhereError);
    expect(toActionError(err)).toBe(
      "Already in the system: Mike's lead, in Missing statements, touched 3 days ago",
    );
    // the same merchant by email alone is refused too
    await expect(attempt(dana, "2125550100", "ROSA@harbortacos.com")).rejects.toThrow(
      /Already in the system: Mike's lead/,
    );
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))?.n).toBe(1);
    // a merchant that left a bucket is placed by stage; the lead_owner answer carries no contact details
    const answer = await as(
      dana,
      async (q) => (await q.query("select * from lead_owner($1, '')", ["3105550199"])).rows[0],
    );
    expect(answer).toMatchObject({ owner_name: "Mike Jones", bucket_name: "Missing statements" });
    expect(Object.keys(answer as object)).not.toContain("phone");
    expect(Object.keys(answer as object)).not.toContain("email");
  });

  it("the same rep gets the ordinary duplicate outcome; so does a manager (allowed through)", async () => {
    const again = (user: string) =>
      as(user, (q) =>
        intakeLead(
          q,
          intakeSchema.parse({ businessName: "Harbor Tacos LLC", phone: "310-555-0199" }),
          "https://crm.test",
        ),
      );
    expect(await again(mike)).toMatchObject({
      clientId: harbor,
      result: "duplicate",
      existing: { ownerName: "Mike Jones", place: "Missing statements" },
    });
    expect(await again(manager)).toMatchObject({
      clientId: harbor,
      result: "duplicate",
      existing: { ownerName: "Mike Jones", place: "Missing statements" },
    });
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))?.n).toBe(1);
  });

  it("filing a sheet row refuses the rep too; the daily loop marks the row as the other rep's merchant and moves on", async () => {
    const rowId = await stageRow(danasSheet, {
      row_no: 2,
      business_name: "Harbor Tacos",
      contact_name: "Rosa",
      phone: "3105550199",
    });
    await expect(
      as(dana, async (q) => fileOneRow(q, await pendingRow(dana, rowId), "https://crm.test")),
    ).rejects.toThrow(/Already in the system: Mike's lead, in Missing statements/);
    let row = await one<{ filed_at: string | null; client_id: string | null }>(
      "select filed_at, client_id from sheet_rows where id = $1",
      [rowId],
    );
    expect(row).toEqual({ filed_at: null, client_id: null });
    const s = await fileNewSheetRows({ db: t.db, appUrl: "https://crm.test" });
    expect(s).toMatchObject({ filed: 0, duplicates: 1, skipped: 0 });
    row = await one("select filed_at, client_id from sheet_rows where id = $1", [rowId]);
    expect(row?.filed_at).not.toBeNull();
    expect(row?.client_id).toBe(harbor);
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))?.n).toBe(1);
  });
});

describe("S1-9: time in business comes off the sheet row", () => {
  it("lands on the merchant", async () => {
    const rowId = await stageRow(danasSheet, {
      row_no: 3,
      business_name: "Golden Wok",
      contact_name: "David Chen",
      phone: "2125550182",
      state: "NY",
      time_in_business_months: 18,
    });
    const out = await as(dana, async (q) =>
      fileOneRow(q, await pendingRow(dana, rowId), "https://crm.test"),
    );
    expect(out.result).toBe("filed");
    const c = await one<{ time_in_business_months: number | null; lead_source_kind: string }>(
      "select time_in_business_months, lead_source_kind from clients where id = $1",
      [out.clientId],
    );
    expect(c).toEqual({ time_in_business_months: 18, lead_source_kind: "sheet" });
  });
});

describe("S1-13: bulk intake files N staged rows into one bucket, one transaction each, and reports every row", () => {
  it("filed, the rep's own duplicate, another rep's merchant, a row that cannot be a merchant, a row that is gone", async () => {
    const fresh = await stageRow(danasSheet, {
      row_no: 10,
      business_name: "Blue Bakery",
      contact_name: "Ana Ruiz",
      phone: "2125550190",
      email: "ana@bluebakery.com",
    });
    const mine = await stageRow(danasSheet, {
      row_no: 11,
      business_name: "Golden Wok",
      phone: "2125550182",
    });
    const mikes = await stageRow(danasSheet, {
      row_no: 12,
      business_name: "Harbor Tacos",
      phone: "3105550199",
    });
    const nameless = await stageRow(danasSheet, { row_no: 13, phone: "2125550177" });
    const gone = "00000000-0000-0000-0000-000000000001";
    const before = (await one<{ n: number }>("select count(*)::int as n from clients"))!.n;
    const report = await fileManyRows({
      db: t.db,
      userId: dana,
      rowIds: [fresh, mine, mikes, nameless, gone],
      bucketId: statements,
      appUrl: "https://crm.test",
    });
    expect(report.map((r) => [r.rowId, r.result])).toEqual([
      [fresh, "filed"],
      [mine, "duplicate"],
      [mikes, "duplicate"],
      [nameless, "refused"],
      [gone, "missing"],
    ]);
    expect(report[0]?.message).toBe("Filed, welcome email queued");
    expect(report[1]?.message).toBe(
      "Already in the system: Dana Lee's lead, in Missing statements",
    );
    expect(report[2]?.message).toBe(
      "Already in the system: Mike's lead, in Missing statements, touched 3 days ago",
    );
    expect(report[2]?.clientId).toBe(harbor);
    expect(report[3]?.message).not.toBe("");
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))!.n).toBe(
      before + 1,
    );
    const bakery = report[0]!.clientId!;
    const enrolled = await one<{ key: string }>(
      "select b.key from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null",
      [bakery],
    );
    expect(enrolled).toEqual({ key: "missing_statements" });
    const welcome = await one<{ lane: string; status: string }>(
      "select lane, status from outbox where client_id = $1",
      [bakery],
    );
    expect(welcome).toEqual({ lane: "intake", status: "queued" });
    // the welcome email's upload link is the merchant's upload link (it once carried the unsubscribe token: a dead link)
    const link = await one<{ text_body: string; upload_token: string; unsubscribe_token: string }>(
      `select o.text_body, c.upload_token, c.unsubscribe_token
         from outbox o join clients c on c.id = o.client_id where o.client_id = $1`,
      [bakery],
    );
    expect(link!.text_body).toContain(`/upload/${link!.upload_token}`);
    expect(link!.text_body).not.toContain(link!.unsubscribe_token);
    // the same rows again: nothing is made twice
    const again = await fileManyRows({
      db: t.db,
      userId: dana,
      rowIds: [fresh, mikes],
      bucketId: statements,
      appUrl: "https://crm.test",
    });
    expect(again.map((r) => r.result)).toEqual(["already_filed", "already_filed"]);
    expect((await one<{ n: number }>("select count(*)::int as n from clients"))!.n).toBe(
      before + 1,
    );
  });
});
