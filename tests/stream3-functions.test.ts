import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

/** The SQL functions stream 3 added. Replaced functions (submit_to_ops, confirm_funding…) keep their 0300/0350 mode. */
const NEW_FUNCTIONS = [
  ["public", "accept_policy"],
  ["public", "close_month"],
  ["public", "correct_funding"],
  ["public", "start_renewal"],
  ["public", "set_winback_reason"],
  ["public", "review_winback_opener"],
  ["app", "alert"],
  ["app", "alert_managers"],
] as const;

describe("stream 3 functions on a hosted database", () => {
  it("are SECURITY DEFINER with a pinned search_path, executable by isaac_app and not by PUBLIC", async () => {
    const { rows } = await t.pool.query<{
      schema: string;
      name: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      app_may: boolean;
      public_may: boolean;
    }>(
      `select n.nspname as schema, p.proname as name, p.prosecdef, p.proconfig,
              has_function_privilege('isaac_app', p.oid, 'execute') as app_may,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_may
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname, p.proname) in (${NEW_FUNCTIONS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ")})`,
      NEW_FUNCTIONS.flat(),
    );
    expect(rows.map((r) => `${r.schema}.${r.name}`).sort()).toEqual(
      NEW_FUNCTIONS.map(([s, n]) => `${s}.${n}`).sort(),
    );
    for (const r of rows) {
      expect(r.prosecdef, r.name).toBe(true);
      expect(r.proconfig?.join(","), r.name).toMatch(/search_path=public, pg_temp/);
      expect(r.app_may, r.name).toBe(true);
      expect(r.public_may, r.name).toBe(false);
    }
  });
  it("the new tables have row-level security on and only the grants they need", async () => {
    const { rows } = await t.pool.query<{ name: string; rls: boolean; privs: string }>(
      `select c.relname as name, c.relrowsecurity as rls,
              concat_ws(',',
                case when has_table_privilege('isaac_app', c.oid, 'select') then 's' end,
                case when has_table_privilege('isaac_app', c.oid, 'insert') then 'i' end,
                case when has_table_privilege('isaac_app', c.oid, 'update') then 'u' end,
                case when has_table_privilege('isaac_app', c.oid, 'delete') then 'd' end) as privs
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname in ('commission_closes', 'commission_statements', 'fundings_corrections', 'winback_reasons', 'rescue_nudges', 'backdoor_reports')
        order by c.relname`,
    );
    expect(rows).toEqual([
      { name: "backdoor_reports", rls: true, privs: "s,i,u" },
      { name: "commission_closes", rls: true, privs: "s" },
      { name: "commission_statements", rls: true, privs: "s" },
      { name: "fundings_corrections", rls: true, privs: "s" },
      { name: "rescue_nudges", rls: true, privs: "s" },
      { name: "winback_reasons", rls: true, privs: "s" },
    ]);
  });
});
