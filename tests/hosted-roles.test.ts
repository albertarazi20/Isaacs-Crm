import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "@/lib/db/pg";
import { createTestDb, type TestDb } from "./helpers/db";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/postgres";
const ROLES = ["anon", "authenticated"];
let t: TestDb;

const can = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query<{ ok: boolean }>(`select ${sql} as ok`, params)).rows[0]?.ok;

beforeAll(async () => {
  // Hosted Postgres ships these roles. Create them the way a hosted database already has them.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const role of ROLES) {
    await admin.query(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`,
    );
  }
  await admin.end();
  t = await createTestDb();
  // Simulate the hosted default: everything in public is granted to them, now and for future tables.
  await t.pool.query(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;
  `);
});
afterAll(async () => {
  await t.drop();
});

const reach = (role: string, table: string) =>
  can(`has_table_privilege($1, 'public.${table}', 'select')`, [role]);

describe("hosted-Postgres public roles are locked out of merchant data", () => {
  it("precondition: the simulated hosted default really does expose the tables", async () => {
    for (const role of ROLES) expect(await reach(role, "clients")).toBe(true);
  });

  it("after the migration, neither role can touch any table, view or later table", async () => {
    const sql = await readFile(
      join(process.cwd(), "db/migrations/0060_lock_hosted_roles.sql"),
      "utf8",
    );
    await t.pool.query(sql);
    await t.pool.query("create table later_table (id int)");
    const { rows } = await t.pool.query<{ relname: string }>(
      "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v')",
    );
    expect(rows.length).toBeGreaterThan(8);
    for (const role of ROLES) {
      for (const { relname } of rows) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          expect(
            await can(`has_table_privilege($1, 'public.${relname}', '${priv}')`, [role]),
            `${role} ${priv} ${relname}`,
          ).toBe(false);
        }
      }
    }
  });

  it("running it twice changes nothing, and the app role still works", async () => {
    const sql = await readFile(
      join(process.cwd(), "db/migrations/0060_lock_hosted_roles.sql"),
      "utf8",
    );
    await t.pool.query(sql);
    expect(await can("has_table_privilege('isaac_app', 'public.clients', 'select')")).toBe(true);
    expect(await can("has_table_privilege('isaac_app', 'public.client_cards', 'select')")).toBe(
      true,
    );
  });
});
