import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

/** The alert functions stream 3 added, which the follow-up system still writes its alerts through. */
const NEW_FUNCTIONS = [
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
});
