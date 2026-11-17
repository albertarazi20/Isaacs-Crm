import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "@/lib/db/pg";
import { migrate } from "@/lib/db/migrate";
import { STAGE_KEYS } from "@/lib/mca/stages";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let clientA: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "a@x.com");
  b = await insertUser(t.pool, "b@x.com");
  clientA = await insertClient(t.db, a, "A Pizza");
});
afterAll(async () => {
  await t.drop();
});

const count = async (userId: string, table: string) =>
  t.db.withUser(
    userId,
    async (q) =>
      (await q.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n,
  );

describe("migrations", () => {
  it("are idempotent — a second run applies nothing", async () => {
    const c = await t.pool.connect();
    try {
      expect(await migrate(c, join(process.cwd(), "db", "migrations"))).toEqual([]);
    } finally {
      c.release();
    }
  });
  it("seed exactly the stage keys the TypeScript vocabulary knows", async () => {
    const { rows } = await t.pool.query<{ key: string }>("select key from stages order by sort");
    expect(rows.map((r) => r.key)).toEqual([...STAGE_KEYS]);
  });
});

describe("row-level security", () => {
  it("shows each user only their own rows", async () => {
    expect(await count(a, "clients")).toBe(1);
    expect(await count(b, "clients")).toBe(0);
    expect(await count(b, "client_cards")).toBe(0);
    expect(await count(b, "timers")).toBe(0);
    expect(await count(b, "activities")).toBe(0);
  });
  it("shows nothing when no user is set on the session", async () => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role isaac_app");
      expect((await c.query("select count(*)::int as n from clients")).rows[0].n).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("does not leak the user id into the next transaction on the same connection", async () => {
    await count(a, "clients");
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role isaac_app");
      expect((await c.query("select count(*)::int as n from clients")).rows[0].n).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
  it("blocks another user's update and delete, and the row really is untouched", async () => {
    const res = await t.db.withUser(b, async (q) => ({
      upd: (await q.query("update clients set business_name = 'HACKED' where id = $1", [clientA]))
        .rowCount,
      del: (await q.query("delete from clients where id = $1", [clientA])).rowCount,
    }));
    expect(res).toEqual({ upd: 0, del: 0 });
    const { rows } = await t.pool.query("select business_name from clients where id = $1", [
      clientA,
    ]);
    expect(rows).toEqual([{ business_name: "A Pizza" }]);
  });
  it("rejects inserting a row owned by someone else", async () => {
    await expect(
      t.db.withUser(b, (q) =>
        q.query("insert into clients (user_id, business_name) values ($1, 'Evil')", [a]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it("rejects attaching a note to someone else's client", async () => {
    await expect(
      t.db.withUser(b, (q) =>
        q.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'note', 'hi')",
          [b, clientA],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
  it("makes move_client invisible-not-found for another user's client and changes nothing", async () => {
    await expect(
      t.db.withUser(b, (q) =>
        q.query("select * from move_client($1, 'dead', $2::jsonb)", [
          clientA,
          JSON.stringify([{ kind: "follow_up", due_on: t.today }]),
        ]),
      ),
    ).rejects.toThrow(/client not found/);
    const { rows } = await t.pool.query("select stage from clients where id = $1", [clientA]);
    expect(rows[0].stage).toBe("name_in");
  });
  it("gives the browser-facing role no access to tokens or reminder state", async () => {
    await expect(
      t.db.withUser(a, (q) => q.query("select * from gmail_connections")),
    ).rejects.toThrow(/permission denied/);
    await expect(t.db.withUser(a, (q) => q.query("select * from reminders_sent"))).rejects.toThrow(
      /permission denied/,
    );
  });
  it("makes the activity timeline append-only", async () => {
    await expect(
      t.db.withUser(a, (q) => q.query("update activities set body = 'edited'")),
    ).rejects.toThrow(/permission denied/);
    await expect(t.db.withUser(a, (q) => q.query("delete from activities"))).rejects.toThrow(
      /permission denied/,
    );
  });
  it("lets a user change their timezone but not their email or id", async () => {
    await t.db.withUser(a, (q) =>
      q.query("update app_users set timezone = 'America/Chicago' where id = $1", [a]),
    );
    expect(
      (await t.pool.query("select timezone from app_users where id = $1", [a])).rows[0].timezone,
    ).toBe("America/Chicago");
    await expect(
      t.db.withUser(a, (q) => q.query("update app_users set email = 'z@x.com' where id = $1", [a])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("withUser", () => {
  it("runs as isaac_app, not the owner", async () => {
    const who = await t.db.withUser(
      a,
      async (q) => (await q.query("select current_user as u")).rows[0].u,
    );
    expect(who).toBe("isaac_app");
  });
  it("rolls everything back when the callback throws", async () => {
    await expect(
      t.db.withUser(a, async (q) => {
        await q.query("insert into clients (user_id, business_name) values ($1, 'Ghost')", [a]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      (await t.pool.query("select count(*)::int as n from clients where business_name = 'Ghost'"))
        .rows[0].n,
    ).toBe(0);
  });
});

describe("constraints", () => {
  it("rejects a blank business name", async () => {
    await expect(
      t.db.withUser(a, (q) =>
        q.query("insert into clients (user_id, business_name) values ($1, '  ')", [a]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
  it("rejects a non-lowercase email", async () => {
    await expect(
      t.pool.query("insert into app_users (email) values ('Mixed@Case.com')"),
    ).rejects.toThrow(/check constraint/);
  });
  it("is a pg client with the date parser installed", async () => {
    const c = new pg.Client({ connectionString: t.pool.options.connectionString });
    await c.connect();
    expect((await c.query("select date '2026-10-23' as d")).rows[0].d).toBe("2026-10-23");
    await c.end();
  });
});
