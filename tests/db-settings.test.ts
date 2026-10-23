import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let u: string;
beforeAll(async () => {
  t = await createTestDb();
  u = await insertUser(t.pool, "isaac@x.com");
});
afterAll(async () => {
  await t.drop();
});

const settings = (q: { query: (sql: string) => Promise<{ rows: Record<string, string>[] }> }) =>
  q.query(
    "select current_setting('jit') as jit, current_setting('statement_timeout') as timeout, current_user as who, current_setting('app.user_id', true) as uid",
  );

describe("every request's connection settings", () => {
  it("a user request runs as the app role, with JIT off, a 15 s cap and the user id set", async () => {
    const [row] = (await t.db.withUser(u, (q) => settings(q))).rows;
    expect(row).toEqual({ jit: "off", timeout: "15s", who: "isaac_app", uid: u });
  });
  it("a system request has JIT off too, and is NOT the app role", async () => {
    const [row] = (await t.db.withSystem((q) => settings(q))).rows;
    expect(row?.jit).toBe("off");
    expect(row?.who).not.toBe("isaac_app");
  });
  it("the settings don't leak to the next request on the same pooled connection", async () => {
    await t.db.withUser(u, async () => undefined);
    const { rows } = await t.pool.query(
      "select current_setting('jit') as jit, current_setting('statement_timeout') as t",
    );
    expect(rows[0]?.t).not.toBe("15s");
    expect(rows[0]?.jit).toBe("on");
  });
});
