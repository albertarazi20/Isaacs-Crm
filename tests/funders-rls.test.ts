import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays } from "@/lib/mca/dates";
import { funderScoreboard, listClientSubmissions, listFunders } from "@/lib/funders/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * Since 0300 the lender list is one list for the whole shop: every rep reads every lender and may send a merchant to
 * any of them. Submissions, offers and chase timers stay the rep's own. 0440 makes a lender's name unique shop-wide.
 */
let t: TestDb;
let a: string;
let b: string;
let clientA: string;
let clientB: string;
let pearl: string;
let libertas: string;
let subA: string;
let offerA: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "a@x.com");
  b = await insertUser(t.pool, "b@x.com");
  clientA = await insertClient(t.db, a, "A Pizza");
  clientB = await insertClient(t.db, b, "B Bakery");
  const f = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, 'Pearl'), ($1, 'Libertas') returning id",
    [a],
  );
  pearl = f.rows[0]?.id as string;
  libertas = f.rows[1]?.id as string;
  subA = await t.db.withUser(
    a,
    async (q) =>
      (
        await q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[])", [
          clientA,
          [pearl],
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
  await t.db.withUser(a, (q) =>
    q.query("select * from create_submissions($1, $2::uuid[])", [clientA, [libertas]]),
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

describe("lenders (shared), submissions and offers (per rep): row-level security", () => {
  it("both reps read the whole lender list; submissions, offers and chase timers are their own", async () => {
    expect(await count(a, "funders")).toBe(2);
    expect(await count(b, "funders")).toBe(2);
    expect(await count(a, "submissions")).toBe(2);
    expect(await count(a, "offers")).toBe(1);
    expect(await count(a, "timers", "kind = 'chase' and done_at is null")).toBe(1);
    expect(await count(b, "submissions")).toBe(0);
    expect(await count(b, "offers")).toBe(0);
    expect(await count(b, "timers", "kind = 'chase' and done_at is null")).toBe(0);
  });

  it("with no user on the session, merchant rows are invisible (the lender list is shop-wide, not personal)", async () => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role isaac_app");
      for (const table of ["submissions", "offers"]) {
        expect((await c.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
      }
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("the query helpers show B every lender but none of A's merchant rows", async () => {
    expect(await asB((q) => listClientSubmissions(q, clientA))).toEqual([]);
    expect((await asB((q) => listFunders(q))).map((f) => f.id).sort()).toEqual(
      [pearl, libertas].sort(),
    );
    const board = await asB((q) => funderScoreboard(q, [pearl]));
    expect(board[pearl]?.submissions).toBe(0);
    expect(board[pearl]?.offerCount).toBe(0);
  });

  it("a rep cannot edit or delete a lender they did not add, nor another rep's submissions and offers", async () => {
    const res = await asB(async (q) => ({
      f: (await q.query("update funders set name = 'HACKED' where id = $1", [pearl])).rowCount,
      fd: (await q.query("delete from funders where id = $1", [pearl])).rowCount,
      s: (await q.query("update submissions set status = 'withdrawn' where id = $1", [subA]))
        .rowCount,
      sd: (await q.query("delete from submissions where id = $1", [subA])).rowCount,
      o: (await q.query("update offers set status = 'declined' where id = $1", [offerA])).rowCount,
      od: (await q.query("delete from offers where id = $1", [offerA])).rowCount,
    }));
    expect(res).toEqual({ f: 0, fd: 0, s: 0, sd: 0, o: 0, od: 0 });
    const f = await t.pool.query("select name from funders where id = $1", [pearl]);
    const s = await t.pool.query("select status from submissions where id = $1", [subA]);
    const o = await t.pool.query("select status from offers where id = $1", [offerA]);
    expect([f.rows[0].name, s.rows[0].status, o.rows[0].status]).toEqual([
      "Pearl",
      "approved",
      "open",
    ]);
  });

  it("rejects inserting a submission or offer owned by someone else", async () => {
    await expect(
      asB((q) =>
        q.query("insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3)", [
          a,
          clientA,
          pearl,
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

  it("cannot attach a submission, offer or chase timer to someone else's merchant or submission; any lender is fine", async () => {
    // B's own user id, A's merchant (a later sent_on so the one-per-day key does not fire first)
    await expect(
      asB((q) =>
        q.query(
          "insert into submissions (user_id, client_id, funder_id, sent_on) values ($1, $2, $3, current_date + 1)",
          [b, clientA, pearl],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    // B's merchant, a lender A added: the list is shared, so this is a normal submission
    await asB((q) =>
      q.query("insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3)", [
        b,
        clientB,
        pearl,
      ]),
    );
    // an offer on A's submission (the one-offer-per-submission key fires before the foreign key; either way: no)
    await expect(
      asB((q) =>
        q.query(
          "insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate) values ($1, $2, $3, 100, 1.3)",
          [b, clientB, subA],
        ),
      ),
    ).rejects.toThrow(/foreign key|duplicate key/);
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
    expect(n.rows[0].n).toBe(1);
  });

  it("a lender's name is unique across the shop, whoever adds it", async () => {
    await expect(
      asB((q) => q.query("insert into funders (user_id, name) values ($1, ' pearl ')", [b])),
    ).rejects.toThrow(/funders_name_key/);
    expect(await count(b, "funders", "lower(name) = 'pearl'")).toBe(1);
  });

  it("every function says 'not found' for another rep's records and changes nothing; their own merchant to a shared lender works", async () => {
    const before = await t.pool.query(
      `select (select status from submissions where id = $1) as sub,
              (select status from offers where id = $2) as offer,
              (select count(*)::int from submissions where client_id = $3) as subs,
              (select count(*)::int from timers where client_id = $3 and kind = 'chase' and done_at is null) as chase,
              (select stage from clients where id = $3) as stage`,
      [subA, offerA, clientA],
    );
    await expect(
      asB((q) => q.query("select * from create_submissions($1, $2::uuid[])", [clientA, [pearl]])),
    ).rejects.toThrow(/client not found/);
    // B's merchant is a different owner from A's (the helper gives every merchant one placeholder phone, and the
    // double-submission guard (0512) matches owners by phone across reps)
    await t.pool.query("update clients set phone = '3055550102' where id = $1", [clientB]);
    const mine = await asB(
      async (q) =>
        (await q.query("select * from create_submissions($1, $2::uuid[])", [clientB, [libertas]]))
          .rowCount,
    );
    expect(mine).toBe(1);
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

  it("the owner's own chase timer is where it should be", async () => {
    const { rows } = await t.db.withUser(a, (q) =>
      q.query<{ due_on: string }>(
        "select t.due_on::text from timers t where t.client_id = $1 and t.kind = 'chase' and t.done_at is null",
        [clientA],
      ),
    );
    expect(rows[0]?.due_on).toBe(addBusinessDays(t.today, 1));
  });
});
