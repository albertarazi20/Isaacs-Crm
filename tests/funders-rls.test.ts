import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays } from "@/lib/mca/dates";
import { funderScoreboard, listClientSubmissions, listFunders } from "@/lib/funders/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let clientA: string;
let clientB: string;
let funderA: string;
let funderB: string;
let subA: string;
let offerA: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "a@x.com");
  b = await insertUser(t.pool, "b@x.com");
  clientA = await insertClient(t.db, a, "A Pizza");
  clientB = await insertClient(t.db, b, "B Bakery");
  const f = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, 'Pearl'), ($2, 'Pearl') returning id, user_id",
    [a, b],
  );
  funderA = f.rows[0]?.id as string;
  funderB = f.rows[1]?.id as string;
  subA = await t.db.withUser(
    a,
    async (q) =>
      (
        await q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[])", [
          clientA,
          [funderA],
        ])
      ).rows[0]?.id as string,
  );
  offerA = await t.db.withUser(
    a,
    async (q) =>
      (
        await q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
          subA,
          JSON.stringify({ amount_cents: 4_500_000, factor_rate: 1.34 }),
        ])
      ).rows[0]?.id as string,
  );
  // a second, still-waiting submission so A has an open chase timer to protect
  const f2 = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, 'Libertas') returning id",
    [a],
  );
  await t.db.withUser(a, (q) =>
    q.query("select * from create_submissions($1, $2::uuid[])", [clientA, [f2.rows[0]?.id]]),
  );
});
afterAll(async () => {
  await t.drop();
});

const asB = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(b, fn);
const count = async (userId: string, table: string, where = "true") =>
  t.db.withUser(
    userId,
    async (q) =>
      (await q.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))
        .rows[0]?.n,
  );

describe("funders, submissions and offers: row-level security", () => {
  it("shows each user only their own rows (the lender list itself is shared across the shop)", async () => {
    // Lenders are one list for the whole shop since 0300: both users read all three. Submissions and offers stay per user.
    expect(await count(a, "funders")).toBe(3);
    expect(await count(a, "submissions")).toBe(2);
    expect(await count(a, "offers")).toBe(1);
    expect(await count(a, "timers", "kind = 'chase' and done_at is null")).toBe(1);
    expect(await count(b, "funders")).toBe(3);
    expect(await count(b, "submissions")).toBe(0);
    expect(await count(b, "offers")).toBe(0);
    expect(await count(b, "timers", "kind = 'chase' and done_at is null")).toBe(0);
  });

  it("shows nothing when no user is set on the session", async () => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role isaac_app");
      for (const table of ["funders", "submissions", "offers"]) {
        expect((await c.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
      }
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("the query helpers return nothing for another user's merchant or funders", async () => {
    expect(await asB((q) => listClientSubmissions(q, clientA))).toEqual([]);
    expect((await asB((q) => listFunders(q))).map((f) => f.id)).toEqual([funderB]);
    const board = await asB((q) => funderScoreboard(q, [funderA, funderB]));
    expect(board[funderA]?.submissions).toBe(0);
    expect(board[funderA]?.offerCount).toBe(0);
    const own = await asB(async (q) => listClientSubmissions(q, clientA));
    expect(own).toEqual([]);
  });

  it("blocks another user's update and delete on funders, submissions and offers; the rows are untouched", async () => {
    const res = await asB(async (q) => ({
      f: (await q.query("update funders set name = 'HACKED' where id = $1", [funderA])).rowCount,
      fd: (await q.query("delete from funders where id = $1", [funderA])).rowCount,
      s: (await q.query("update submissions set status = 'withdrawn' where id = $1", [subA]))
        .rowCount,
      sd: (await q.query("delete from submissions where id = $1", [subA])).rowCount,
      o: (await q.query("update offers set status = 'declined' where id = $1", [offerA])).rowCount,
      od: (await q.query("delete from offers where id = $1", [offerA])).rowCount,
    }));
    expect(res).toEqual({ f: 0, fd: 0, s: 0, sd: 0, o: 0, od: 0 });
    const f = await t.pool.query("select name from funders where id = $1", [funderA]);
    const s = await t.pool.query("select status from submissions where id = $1", [subA]);
    const o = await t.pool.query("select status from offers where id = $1", [offerA]);
    expect([f.rows[0].name, s.rows[0].status, o.rows[0].status]).toEqual([
      "Pearl",
      "approved",
      "open",
    ]);
  });

  it("rejects inserting a row owned by someone else", async () => {
    await expect(
      asB((q) => q.query("insert into funders (user_id, name) values ($1, 'Evil')", [a])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asB((q) =>
        q.query("insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3)", [
          a,
          clientA,
          funderA,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asB((q) =>
        q.query(
          "insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate) values ($1, $2, $3, 100, 1.3)",
          [a, clientA, subA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot attach a submission, offer or chase timer to someone else's merchant, funder or submission", async () => {
    // B's own user id, A's merchant
    await expect(
      asB((q) =>
        q.query("insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3)", [
          b,
          clientA,
          funderB,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    // B's merchant, A's funder
    await expect(
      asB((q) =>
        q.query("insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3)", [
          b,
          clientB,
          funderA,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    // an offer on A's submission
    await expect(
      asB((q) =>
        q.query(
          "insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate) values ($1, $2, $3, 100, 1.3)",
          [b, clientB, subA],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    // a chase timer pointing at A's submission
    await expect(
      asB((q) =>
        q.query(
          "insert into timers (user_id, client_id, kind, due_on, submission_id) values ($1, $2, 'chase', current_date, $3)",
          [b, clientB, subA],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    const n = await t.pool.query("select count(*)::int as n from submissions where user_id = $1", [
      b,
    ]);
    expect(n.rows[0].n).toBe(0);
  });

  it("both users can have a funder with the same name", async () => {
    expect(await count(a, "funders", "lower(name) = 'pearl'")).toBe(1);
    expect(await count(b, "funders", "lower(name) = 'pearl'")).toBe(1);
  });

  it("every function says 'not found' for another user's records and changes nothing", async () => {
    const before = await t.pool.query(
      `select (select status from submissions where id = $1) as sub,
              (select status from offers where id = $2) as offer,
              (select count(*)::int from submissions where client_id = $3) as subs,
              (select count(*)::int from timers where client_id = $3 and kind = 'chase' and done_at is null) as chase,
              (select stage from clients where id = $3) as stage`,
      [subA, offerA, clientA],
    );
    await expect(
      asB((q) => q.query("select * from create_submissions($1, $2::uuid[])", [clientA, [funderB]])),
    ).rejects.toThrow(/client not found/);
    await expect(
      asB((q) => q.query("select * from create_submissions($1, $2::uuid[])", [clientB, [funderA]])),
    ).rejects.toThrow(/funder not found/);
    await expect(
      asB((q) =>
        q.query("select * from set_submission_status($1, 'declined', 'credit', '')", [subA]),
      ),
    ).rejects.toThrow(/submission not found/);
    await expect(
      asB((q) =>
        q.query("select * from record_offer($1, $2::jsonb)", [
          subA,
          JSON.stringify({ amount_cents: 100, factor_rate: 1.3 }),
        ]),
      ),
    ).rejects.toThrow(/submission not found/);
    await expect(asB((q) => q.query("select * from accept_offer($1)", [offerA]))).rejects.toThrow(
      /offer not found/,
    );
    await expect(
      asB((q) => q.query("select * from set_offer_status($1, 'declined')", [offerA])),
    ).rejects.toThrow(/offer not found/);
    await expect(asB((q) => q.query("select remove_submission($1)", [subA]))).rejects.toThrow(
      /submission not found/,
    );
    const after = await t.pool.query(
      `select (select status from submissions where id = $1) as sub,
              (select status from offers where id = $2) as offer,
              (select count(*)::int from submissions where client_id = $3) as subs,
              (select count(*)::int from timers where client_id = $3 and kind = 'chase' and done_at is null) as chase,
              (select stage from clients where id = $3) as stage`,
      [subA, offerA, clientA],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].chase).toBe(1);
  });

  it("the owner's own call still works (the failures above are about B, not the setup)", async () => {
    const { rows } = await t.db.withUser(a, (q) =>
      q.query<{ due_on: string }>(
        "select t.due_on::text from timers t where t.client_id = $1 and t.kind = 'chase' and t.done_at is null",
        [clientA],
      ),
    );
    expect(rows[0]?.due_on).toBe(addBusinessDays(t.today, 1));
  });
});
