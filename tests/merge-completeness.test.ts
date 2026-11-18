import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "rep@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

describe("merge_clients keeps everything that hangs off the dropped card", () => {
  it("every table that references clients is handled by the function (a new one must be added)", async () => {
    const refs = await t.pool.query<{ tbl: string }>(
      `select distinct c.conrelid::regclass::text as tbl from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'public.clients'::regclass`,
    );
    const def = (
      await t.pool.query<{ d: string }>(
        "select pg_get_functiondef('public.merge_clients(uuid, uuid)'::regprocedure) as d",
      )
    ).rows[0]?.d as string;
    // access_log is an append-only audit trail: its rows are deliberately never rewritten by a merge
    const auditOnly = new Set(["access_log"]);
    const unhandled = refs.rows
      .map((r) => r.tbl)
      .filter((n) => !auditOnly.has(n))
      .filter((n) => !new RegExp(`\\b${n}\\b`).test(def));
    expect(unhandled).toEqual([]);
  });

  it("no helper that re-points system-only rows is left callable by any rep session", async () => {
    const r = await t.pool.query("select 1 from pg_proc where proname = 'merge_move_system_rows'");
    expect(r.rowCount).toBe(0);
  });

  it("does not rewrite audit rows: access_log keeps what it recorded (the dropped card's rows end up unlinked)", async () => {
    const keep = await insertClient(t.db, a, "Audit Keep");
    const drop = await insertClient(t.db, a, "Audit Drop");
    const ins = await t.pool.query<{ id: string }>(
      `insert into access_log (user_id, action, client_id, detail)
       values ($1, 'view_contact', $2, 'looked at the drop card') returning id`,
      [a, drop],
    );
    const logId = ins.rows[0]?.id;
    await t.db.withUser(a, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));
    const row = (
      await t.pool.query<{ client_id: string | null; detail: string }>(
        "select client_id, detail from access_log where id = $1",
        [logId],
      )
    ).rows[0];
    expect(row?.detail).toBe("looked at the drop card");
    expect(row?.client_id).toBeNull();
    const onKeep = await t.pool.query("select 1 from access_log where client_id = $1", [keep]);
    expect(onKeep.rowCount).toBe(0);
  });

  it("documents, link opens, a live enrolment and the second phone and email move to the kept card", async () => {
    const keep = await insertClient(t.db, a, "Keep Pizza");
    const drop = await insertClient(t.db, a, "Drop Pizza");
    await t.pool.query(
      "update clients set phone2 = '3055550111', email2 = 'x2@x.com', looking_for = 'a truck' where id = $1",
      [drop],
    );
    await t.pool.query(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
       values ($1, $2, 'bank_statement', 'jan.pdf', 'application/pdf', 10, repeat('a', 64), 'k/jan', 'upload_link')`,
      [a, drop],
    );
    await t.pool.query("insert into link_opens (client_id, kind) values ($1, 'upload')", [drop]);
    const bucket = (
      await t.pool.query<{ id: string }>("select id from buckets where key = 'interested'")
    ).rows[0]?.id;
    await t.pool.query("select enroll_in_bucket($1, $2, 'moved')", [drop, bucket]);

    await t.db.withUser(a, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));

    const n = async (sql: string) =>
      Number((await t.pool.query<{ n: string }>(sql, [keep])).rows[0]?.n);
    expect(
      await n("select count(*) as n from documents where client_id = $1 and filename = 'jan.pdf'"),
    ).toBe(1);
    expect(await n("select count(*) as n from link_opens where client_id = $1")).toBe(1);
    expect(
      await n("select count(*) as n from enrollments where client_id = $1 and stopped_at is null"),
    ).toBe(1);
    const c = (
      await t.pool.query<{ phone2: string; email2: string; looking_for: string }>(
        "select phone2, email2, looking_for from clients where id = $1",
        [keep],
      )
    ).rows[0];
    expect(c).toEqual({ phone2: "3055550111", email2: "x2@x.com", looking_for: "a truck" });
  });
});
