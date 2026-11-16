import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDeal, listDeals, openDealFor } from "@/lib/deals/queries";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let rep2: string;
let ops: string;
let manager: string;
let pizza: string;

const as = <T>(
  user: string,
  fn: Parameters<typeof t.db.withUser>[1] & ((q: never) => Promise<T>),
) => t.db.withUser(user, fn as Parameters<typeof t.db.withUser>[1]) as Promise<T>;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  rep2 = await insertUser(t.pool, "rep2@x.com");
  ops = await insertUser(t.pool, "ops@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'ops' where id = $1", [ops]);
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  pizza = await insertClient(t.db, rep, "Pizza Palace");
});
afterAll(async () => {
  await t.drop();
});

describe("roles in the database", () => {
  it("a rep cannot promote themselves; a manager can change roles; nobody changes their own", async () => {
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update app_users set role = 'manager' where id = $1", [rep]),
      ),
    ).rejects.toThrow(/only a manager/);
    await t.db.withUser(manager, (q) =>
      q.query("update app_users set role = 'ops' where id = $1", [rep2]),
    );
    const { rows } = await t.pool.query("select role from app_users where id = $1", [rep2]);
    expect(rows[0].role).toBe("ops");
    await t.db.withUser(manager, (q) =>
      q.query("update app_users set role = 'rep' where id = $1", [rep2]),
    );
    await expect(
      t.db.withUser(manager, (q) =>
        q.query("update app_users set role = 'rep' where id = $1", [manager]),
      ),
    ).rejects.toThrow(/own role/);
  });
  it("a manager sees every rep's merchants; a rep sees only their own", async () => {
    const n = (u: string) =>
      t.db.withUser(
        u,
        async (q) =>
          (await q.query<{ n: number }>("select count(*)::int as n from clients")).rows[0]?.n,
      );
    expect(await n(rep)).toBe(1);
    expect(await n(rep2)).toBe(0);
    expect(await n(manager)).toBe(1);
    expect(await n(ops)).toBe(0);
  });
});

describe("the ops loop", () => {
  let dealId: string;
  it("submit to ops creates one open deal, logs it, and moves the merchant to Application in", async () => {
    const d = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ id: string; number: number; ops_status: string }>(
            "select * from submit_to_ops($1, 'new', $2, 'new truck', 'clean file')",
            [pizza, 5_000_000],
          )
        ).rows[0],
    );
    if (!d) throw new Error("no deal row");
    dealId = d.id;
    expect(d.ops_status).toBe("queued");
    expect(d.number).toBeGreaterThan(0);
    const { rows } = await t.pool.query("select stage from clients where id = $1", [pizza]);
    expect(rows[0].stage).toBe("application_in");
    const act = await t.pool.query(
      "select body from activities where client_id = $1 and body like 'Submitted to ops as deal%'",
      [pizza],
    );
    expect(act.rows[0]?.body).toMatch(/Submitted to ops as deal D-\d+/);
    expect(
      (await openDealFor(await t.pool.connect().then((c) => (c.release(), c)), pizza))?.id,
    ).toBe(dealId);
  });
  it("a second submit while one is open is refused", async () => {
    await expect(
      t.db.withUser(rep, (q) => q.query("select * from submit_to_ops($1)", [pizza])),
    ).rejects.toThrow(/already has an open deal/);
  });
  it("ops sees the queued deal and the merchant behind it; another rep sees neither", async () => {
    const opsDeals = await t.db.withUser(ops, (q) => listDeals(q, "working_ops"));
    expect(opsDeals.map((d) => d.id)).toEqual([dealId]);
    expect(opsDeals[0]?.business_name).toBe("Pizza Palace");
    expect(opsDeals[0]?.status).toBe("working_ops");
    const opsClients = await t.db.withUser(
      ops,
      async (q) =>
        (await q.query<{ n: number }>("select count(*)::int as n from clients")).rows[0]?.n,
    );
    expect(opsClients).toBe(1);
    expect(await t.db.withUser(rep2, (q) => listDeals(q, "all"))).toEqual([]);
    expect(await t.db.withUser(rep2, (q) => getDeal(q, dealId))).toBeNull();
  });
  it("ops kicks it back with a reason; the rep sees the reason and the count", async () => {
    await t.db.withUser(ops, (q) =>
      q.query("select * from kick_back_deal($1, 'missing_statement_month', 'October is missing')", [
        dealId,
      ]),
    );
    const d = await t.db.withUser(rep, (q) => getDeal(q, dealId));
    expect(d?.status).toBe("kicked_back");
    expect(d?.kickback_reason).toBe("missing_statement_month");
    expect(d?.kickback_count).toBe(1);
    expect(d?.blocker).toMatch(/Kicked back by ops/);
  });
  it("the rep resubmits: the same deal goes back to the queue, blocker cleared", async () => {
    const d = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ id: string; ops_status: string; blocker: string }>(
            "select * from submit_to_ops($1)",
            [pizza],
          )
        ).rows[0],
    );
    if (!d) throw new Error("no deal row");
    expect(d.id).toBe(dealId);
    expect(d.ops_status).toBe("queued");
    expect(d.blocker).toBe("");
  });
  it("ops sends it: a lender row stamps the deal id and the status rolls up to pending_lenders", async () => {
    const funder = await t.pool.query<{ id: string }>(
      "insert into funders (user_id, name) values ($1, 'Pearl') returning id",
      [manager],
    );
    await t.db.withUser(manager, (q) =>
      q.query("select * from create_submissions($1, $2::uuid[])", [pizza, [funder.rows[0]?.id]]),
    );
    await t.db.withUser(ops, (q) => q.query("select * from mark_deal_sent($1)", [dealId]));
    const sub = await t.pool.query("select deal_id, status from submissions where client_id = $1", [
      pizza,
    ]);
    expect(sub.rows[0].deal_id).toBe(dealId);
    const d = await t.db.withUser(manager, (q) => getDeal(q, dealId));
    expect(d?.status).toBe("pending_lenders");
    expect(d?.lenders_sent).toBe(1);
  });
  it("an approval makes it needs_pitch; a decline from every lender makes it declined_by_all", async () => {
    const sub = await t.pool.query<{ id: string }>(
      "select id from submissions where client_id = $1",
      [pizza],
    );
    await t.db.withUser(manager, (q) =>
      q.query("select * from set_submission_status($1, 'approved')", [sub.rows[0]?.id]),
    );
    expect((await t.db.withUser(rep, (q) => getDeal(q, dealId)))?.status).toBe("needs_pitch");
    await t.db.withUser(manager, (q) =>
      q.query("select * from set_submission_status($1, 'declined', 'low_balances')", [
        sub.rows[0]?.id,
      ]),
    );
    expect((await t.db.withUser(rep, (q) => getDeal(q, dealId)))?.status).toBe("declined_by_all");
    expect(await t.db.withUser(rep, (q) => listDeals(q, "reshop"))).toHaveLength(1);
  });
  it("closing the deal records the outcome and frees the merchant for a new deal", async () => {
    await t.db.withUser(rep, (q) =>
      q.query("select * from close_deal($1, 'declined', 'everyone passed')", [dealId]),
    );
    expect((await t.db.withUser(rep, (q) => getDeal(q, dealId)))?.status).toBe("declined");
    const again = await t.db.withUser(
      rep,
      async (q) =>
        (
          await q.query<{ id: string; kind: string }>("select * from submit_to_ops($1, 'reshop')", [
            pizza,
          ])
        ).rows[0],
    );
    if (!again) throw new Error("no deal row");
    expect(again.id).not.toBe(dealId);
    expect(again.kind).toBe("reshop");
  });
});
