import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importClients } from "@/lib/data/import";
import { importSchema } from "@/lib/data/schemas";
import type { UserContext } from "@/lib/data/types";
import { addDays } from "@/lib/mca/dates";
import { chunk, emptyImportResult, IMPORT_BATCH, mergeImportResults } from "@/lib/import/batches";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  ctx = { today: t.today, timezone: "America/New_York" };
});
afterAll(async () => {
  await t.drop();
});

const row = (n: number, over: Record<string, unknown> = {}) => ({
  line: n + 1,
  businessName: `Merchant ${n}`,
  contactName: "",
  phone: `+1305555${String(n).padStart(4, "0")}`,
  email: "",
  wantedAmount: "",
  industry: "",
  state: "",
  notes: "",
  stage: "name_in",
  followUpOn: addDays(t.today, 1 + (n % 10)),
  statusNote: "",
  ...over,
});

/** What the import page does: one server call per slice, results added up. */
async function importInSlices(rows: ReturnType<typeof row>[]) {
  let r = emptyImportResult();
  for (const slice of chunk(rows, IMPORT_BATCH)) {
    const got = await t.db.withUser(a, (q) =>
      importClients(q, importSchema.parse({ rows: slice }).rows, ctx),
    );
    r = mergeImportResults(r, got);
  }
  return r;
}

const count = async (sql: string) => Number((await t.pool.query<{ n: string }>(sql)).rows[0]?.n);

/** The same file every time: 250 rows, one duplicate phone in a later slice, one row the database refuses. */
const file = () => {
  const rows = Array.from({ length: 250 }, (_, i) => row(i + 1));
  rows[220] = row(222, { phone: rows[3]?.phone ?? "" });
  rows[149] = row(150, { followUpOn: addDays(t.today, -30) });
  return rows;
};

describe("a big file imported in slices", () => {
  it("adds every row once, a duplicate in a later slice is skipped, a bad row keeps its file line", async () => {
    const r = await importInSlices(file());
    expect(r.created).toBe(248);
    expect(r.skippedExisting).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.line).toBe(151);
    expect(await count("select count(*) as n from clients")).toBe(248);
    // every merchant has a next date (the product's rule), checked in the database
    expect(
      await count(
        "select count(*) as n from clients c where not exists (select 1 from timers t where t.client_id = c.id and t.done_at is null)",
      ),
    ).toBe(0);
  });

  it("running the same file again changes nothing", async () => {
    const before = await count("select count(*) as n from clients");
    const r = await importInSlices(file());
    expect(r.created).toBe(0);
    expect(r.skippedExisting).toBe(248 + 1);
    expect(r.failed).toHaveLength(1);
    expect(await count("select count(*) as n from clients")).toBe(before);
  });
});
