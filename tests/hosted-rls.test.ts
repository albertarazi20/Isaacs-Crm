import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  // What Supabase does: an event trigger turns row-level security on for every table as it is created.
  await t.pool.query(`
    do $$
    declare r record;
    begin
      for r in select relname from pg_class
               where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity
      loop
        execute format('alter table %I enable row level security', r.relname);
      end loop;
    end $$
  `);
});
afterAll(async () => {
  await t.drop();
});

const stagesSeenByApp = () =>
  t.db.withUser(a, async (q) =>
    Number((await q.query<{ n: string }>("select count(*) as n from stages")).rows[0]?.n),
  );

describe("shared reference data stays readable when the host forces row-level security on", () => {
  it("precondition: with RLS on and no policy the app role sees no stages at all", async () => {
    await t.pool.query("drop policy stages_read on stages");
    expect(await stagesSeenByApp()).toBe(0);
  });

  it("the migration gives the app role read access and nothing more", async () => {
    const sql = await readFile(
      join(process.cwd(), "db/migrations/0230_stages_readable.sql"),
      "utf8",
    );
    await t.pool.query(sql);
    expect(await stagesSeenByApp()).toBe(23);
    await expect(
      t.db.withUser(a, (q) => q.query("update stages set label = 'x' where key = 'lost'")),
    ).rejects.toThrow(/permission denied/);
  });
});
