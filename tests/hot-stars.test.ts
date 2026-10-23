import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importHot, setHot } from "@/lib/data/mutations";
import { buildBackup } from "@/lib/export/backup";
import { mergeHot } from "@/components/power/prefs";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  b = await insertUser(t.pool, "other@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

const hotOf = async (id: string) =>
  (await t.pool.query<{ hot: boolean }>("select hot from clients where id = $1", [id])).rows[0]
    ?.hot;

describe("stars live on the merchant", () => {
  it("a new merchant is not starred; starring and unstarring change the row", async () => {
    const id = await insertClient(t.db, a, "Star Pizza");
    expect(await hotOf(id)).toBe(false);
    await t.db.withUser(a, (q) => setHot(q, { clientId: id, hot: true }));
    expect(await hotOf(id)).toBe(true);
    await t.db.withUser(a, (q) => setHot(q, { clientId: id, hot: false }));
    expect(await hotOf(id)).toBe(false);
  });

  it("a merchant that is gone is told so; another user's merchant can't be starred", async () => {
    const theirs = await insertClient(t.db, b, "Not Yours");
    await expect(
      t.db.withUser(a, (q) => setHot(q, { clientId: theirs, hot: true })),
    ).rejects.toThrow(/no longer exists/);
    expect(await hotOf(theirs)).toBe(false);
  });

  it("the shell hands the page exactly the starred ids (and nobody else's)", async () => {
    const one = await insertClient(t.db, a, "Shell One");
    const two = await insertClient(t.db, a, "Shell Two");
    const theirs = await insertClient(t.db, b, "Shell Theirs");
    await t.db.withUser(a, (q) => setHot(q, { clientId: one, hot: true }));
    await t.pool.query("update clients set hot = true where id = $1", [theirs]);
    const rows = await t.db.withUser(a, (q) =>
      q.query<{ id: string }>("select id from clients where hot"),
    );
    const ids = rows.rows.map((r) => r.id);
    expect(ids).toContain(one);
    expect(ids).not.toContain(two);
    expect(ids).not.toContain(theirs);
  });

  it("importing a browser's old stars stars only the user's own merchants, once", async () => {
    const mine = await insertClient(t.db, a, "Import Mine");
    const theirs = await insertClient(t.db, b, "Import Theirs");
    const n = await t.db.withUser(a, (q) =>
      importHot(q, [mine, theirs, "00000000-0000-4000-8000-000000000000"]),
    );
    expect(n).toBe(1);
    expect(await hotOf(mine)).toBe(true);
    expect(await hotOf(theirs)).toBe(false);
    expect(await t.db.withUser(a, (q) => importHot(q, [mine]))).toBe(0); // already starred: nothing to do
  });

  it("the backup carries the star, and merging two cards keeps it if either had it", async () => {
    const keep = await insertClient(t.db, a, "Merge Keep");
    const drop = await insertClient(t.db, a, "Merge Drop");
    await t.db.withUser(a, (q) => setHot(q, { clientId: drop, hot: true }));
    const backup = await t.db.withUser(a, (q) => buildBackup(q));
    expect(backup.tables.clients?.find((c) => c.id === drop)?.hot).toBe(true);
    await t.db.withUser(a, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
    expect(await hotOf(keep)).toBe(true);
  });
});

describe("what the page shows while a tap is on its way", () => {
  it("a pending star is added, a pending unstar removed, and the server's list is not touched", () => {
    const server = ["a", "b"];
    expect([...mergeHot(server, [["c", true]])].sort()).toEqual(["a", "b", "c"]);
    expect([...mergeHot(server, [["a", false]])].sort()).toEqual(["b"]);
    expect([...mergeHot(server, new Map())].sort()).toEqual(["a", "b"]);
    expect(server).toEqual(["a", "b"]);
  });
});
