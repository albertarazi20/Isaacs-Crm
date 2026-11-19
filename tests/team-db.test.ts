import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let rep: string;
let rep2: string;
let manager: string;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  rep2 = await insertUser(t.pool, "rep2@x.com");
  manager = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  await insertClient(t.db, rep, "Pizza Palace");
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
      q.query("update app_users set role = 'manager' where id = $1", [rep2]),
    );
    const { rows } = await t.pool.query("select role from app_users where id = $1", [rep2]);
    expect(rows[0].role).toBe("manager");
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
  });
});

describe("the team: add, change role, disable", () => {
  it("managers add people and change roles; reps cannot; nobody demotes themselves", async () => {
    const added = await t.db.withUser(manager, (q) =>
      q.query<{ id: string; role: string }>(
        "select * from add_team_member('New.Rep@SelectiveCap.com', 'New Rep', 'rep')",
      ),
    );
    const id = added.rows[0]!.id;
    expect(added.rows[0]?.role).toBe("rep");
    expect(
      (await t.pool.query("select email, name, role, active from app_users where id = $1", [id]))
        .rows[0],
    ).toEqual({ email: "new.rep@selectivecap.com", name: "New Rep", role: "rep", active: true });
    await expect(
      t.db.withUser(rep, (q) => q.query("select add_team_member('x@y.com', 'X', 'rep')")),
    ).rejects.toThrow(/only a manager/);
    await expect(
      t.db.withUser(rep, (q) => q.query("select set_team_member($1, 'manager', true)", [rep])),
    ).rejects.toThrow(/only a manager/);
    await expect(
      t.db.withUser(manager, (q) => q.query("select set_team_member($1, 'rep', true)", [manager])),
    ).rejects.toThrow(/yourself/);
    // "Add person" with your own address and a lower role would demote you: refused, and the row is untouched
    const mine = (
      await t.pool.query<{ email: string }>("select email from app_users where id = $1", [manager])
    ).rows[0]!.email;
    await expect(
      t.db.withUser(manager, (q) => q.query("select add_team_member($1, 'Me', 'rep')", [mine])),
    ).rejects.toThrow(/yourself/);
    expect(
      (await t.pool.query("select role, active from app_users where id = $1", [manager])).rows[0],
    ).toEqual({ role: "manager", active: true });
    // a role change signs the person out everywhere (the session epoch moves on)
    await t.db.withUser(manager, (q) =>
      q.query("select set_team_member($1, 'manager', true)", [id]),
    );
    expect(
      (
        await t.pool.query<{ role: string; session_epoch: number }>(
          "select role, session_epoch from app_users where id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ role: "manager", session_epoch: 1 });
    // disabling kills the login and revokes their lead-intake tokens
    await t.db.withUser(manager, (q) => q.query("select set_team_member($1, 'rep', false)", [id]));
    expect(
      (
        await t.pool.query<{ active: boolean; session_epoch: number }>(
          "select active, session_epoch from app_users where id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ active: false, session_epoch: 2 });
  });
});
