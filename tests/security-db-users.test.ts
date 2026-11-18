import { mkdtempSync, readdirSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "@/lib/db/pg";
import { migrate } from "@/lib/db/migrate";
import { userContext } from "@/lib/data/queries";
import { listTeam } from "@/lib/settings/team";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/postgres";
const MIGRATIONS = join(process.cwd(), "db", "migrations");

let t: TestDb;
let a: string;
let b: string;
let boss: string;
let bClient: string;

/** Columns another person's row may show a signed-in user (0576). */
const GRANTED = [
  "id",
  "email",
  "name",
  "role",
  "active",
  "invited_by",
  "created_at",
  "last_login_at",
  "signature",
  "application_link",
  "phone",
];
/** Columns that are private to their owner. */
const PRIVATE = [
  "timezone",
  "digest_enabled",
  "digest_hour",
  "notify_email",
  "session_epoch",
  "offboarded_at",
  "offboarded_by",
  "policy_accepted_at",
];

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "rep-a@x.com", "America/Chicago");
  b = await insertUser(t.pool, "rep-b@x.com", "Pacific/Honolulu");
  boss = await insertUser(t.pool, "boss@x.com", "America/Denver");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  await t.pool.query(
    `update app_users set name = 'Bea Rep', notify_email = 'bea-private@x.com', signature = 'Bea, Selective',
            phone = '+13055550142', digest_hour = 5, session_epoch = 7, policy_accepted_at = now() where id = $1`,
    [b],
  );
  bClient = await insertClient(t.db, b, "Bea's Bakery");
});
afterAll(async () => {
  await t.drop();
});

const asRep = <T>(fn: (q: pg.PoolClient) => Promise<T>) => t.db.withUser(a, fn);

describe("about other people, a session sees the team columns and nothing private", () => {
  it("rep A can read the granted columns of rep B, and they are B's real values", async () => {
    const { rows } = await asRep((q) =>
      q.query<Record<string, unknown>>(
        `select ${GRANTED.join(", ")} from app_users where id = $1`,
        [b],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: b,
      email: "rep-b@x.com",
      name: "Bea Rep",
      role: "rep",
      active: true,
      signature: "Bea, Selective",
      phone: "+13055550142",
    });
    // the whole team is listed with the same columns
    const all = await asRep((q) => q.query("select id, name, email, role, active from app_users"));
    expect(all.rows.map((r: { id: string }) => r.id).sort()).toEqual([a, b, boss].sort());
  });

  it.each(PRIVATE)("rep A cannot select %s about rep B", async (col) => {
    await expect(
      asRep((q) => q.query(`select ${col} from app_users where id = $1`, [b])),
    ).rejects.toThrow(/permission denied for table app_users/);
  });

  it("a wildcard, a to_jsonb of the row, a join and a WHERE on a private column are all refused", async () => {
    for (const sql of [
      "select * from app_users",
      "select to_jsonb(u) from app_users u",
      "select u.id from app_users u join clients c on c.user_id = u.id where u.timezone = 'Pacific/Honolulu'",
      "select id from app_users where notify_email = 'bea-private@x.com'",
      "select id from app_users order by session_epoch",
    ]) {
      await expect(
        asRep((q) => q.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("not even a manager reads another person's private columns, and not even one's own through the table", async () => {
    await expect(
      t.db.withUser(boss, (q) => q.query("select notify_email from app_users where id = $1", [b])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRep((q) => q.query("select timezone from app_users where id = $1", [a])),
    ).rejects.toThrow(/permission denied/);
  });

  it("the stored values never reach the app role's other doors either (a view over the table is the only one)", async () => {
    const { rows } = await t.pool.query<{ relname: string }>(
      `select c.relname from pg_class c
        where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace) and c.relkind in ('v', 'm')
          and has_table_privilege('isaac_app', c.oid, 'select')
          and pg_get_viewdef(c.oid) ~* 'app_users'`,
    );
    expect(rows.map((r) => r.relname)).toEqual(["my_user"]);
  });
});

describe("a person's own row, through app.my_user", () => {
  it("is the caller's row with every column, and only that row", async () => {
    const mine = await asRep((q) =>
      q.query<{ id: string; timezone: string }>("select * from app.my_user"),
    );
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ id: a, timezone: "America/Chicago" });
    const bs = await t.db.withUser(b, (q) =>
      q.query<{ notify_email: string; digest_hour: number; session_epoch: number }>(
        "select notify_email, digest_hour, session_epoch from app.my_user",
      ),
    );
    expect(bs.rows).toEqual([
      { notify_email: "bea-private@x.com", digest_hour: 5, session_epoch: 7 },
    ]);
  });

  it("shows nothing at all with no signed-in user, and cannot be written through", async () => {
    // a session whose user id is not set sees no row (the system connection never uses the view)
    const none = await t.pool.query("select * from app.my_user");
    expect(none.rows).toEqual([]);
    await expect(asRep((q) => q.query("update app.my_user set timezone = 'UTC'"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("a predicate on a private column is never run against someone else's row (security barrier)", async () => {
    const { rows } = await t.pool.query<{ opts: string[] | null }>(
      "select reloptions as opts from pg_class where oid = 'app.my_user'::regclass",
    );
    expect(rows[0]?.opts).toContain("security_barrier=true");
    // B's value would divide by zero if the predicate ran on B's row; it runs on A's only
    const probe = await asRep((q) =>
      q.query(
        "select 1 / (case when notify_email = 'bea-private@x.com' then 0 else 1 end) as x from app.my_user",
      ),
    );
    expect(probe.rows).toHaveLength(1);
  });

  it("is not reachable by the hosted public roles", async () => {
    const { rows } = await t.pool.query<{ pub: boolean }>(
      `select exists (select 1 from aclexplode((select relacl from pg_class where oid = 'app.my_user'::regclass)) a
                       where a.grantee = 0) as pub`,
    );
    expect(rows[0]?.pub).toBe(false);
  });
});

describe("the app still works for what it does with app_users", () => {
  it("the session's day is the person's own zone, not a silent UTC fallback", async () => {
    const zone = await asRep(
      async (q) =>
        (await q.query<{ tz: string }>("select current_setting('timezone') as tz")).rows[0]?.tz,
    );
    expect(zone).toBe("America/Chicago");
    const other = await t.db.withUser(
      b,
      async (q) =>
        (await q.query<{ tz: string }>("select current_setting('timezone') as tz")).rows[0]?.tz,
    );
    expect(other).toBe("Pacific/Honolulu");
  });

  it("userContext reads the person's own zone", async () => {
    expect((await t.db.withUser(a, (q) => userContext(q))).timezone).toBe("America/Chicago");
    expect((await t.db.withUser(b, (q) => userContext(q))).timezone).toBe("Pacific/Honolulu");
  });

  it("a person still updates their own settings, and the database really changed", async () => {
    await asRep((q) =>
      q.query(
        "update app_users set timezone = 'America/New_York', digest_enabled = false, digest_hour = 7 where id = app.current_user_id()",
      ),
    );
    const row = await t.pool.query(
      "select timezone, digest_enabled, digest_hour from app_users where id = $1",
      [a],
    );
    expect(row.rows[0]).toEqual({
      timezone: "America/New_York",
      digest_enabled: false,
      digest_hour: 7,
    });
    // and cannot touch anyone else's row, or a column that was never writable
    const other = await asRep((q) =>
      q.query("update app_users set phone = 'x' where id = $1", [b]),
    );
    expect(other.rowCount).toBe(0);
    await expect(
      asRep((q) => q.query("update app_users set notify_email = 'evil@x.com' where id = $1", [a])),
    ).rejects.toThrow(/permission denied/);
    await t.pool.query("update app_users set timezone = 'America/Chicago' where id = $1", [a]);
  });

  it("the team list works for a rep and a manager (names, roles, last sign-in, clients)", async () => {
    for (const who of [a, boss]) {
      const team = await t.db.withUser(who, (q) => listTeam(q));
      expect(team.map((m) => m.email).sort()).toEqual(["boss@x.com", "rep-a@x.com", "rep-b@x.com"]);
    }
  });

  it("a merchant's time zone falls back to its rep's: a rep sees their own, a manager another rep's, never a stranger's", async () => {
    const zoneOf = (who: string, client: string) =>
      t.db.withUser(
        who,
        async (q) =>
          (
            await q.query<{ tz: string }>(
              "select app.client_timezone(c) as tz from clients c where c.id = $1",
              [client],
            )
          ).rows[0]?.tz,
      );
    expect(await zoneOf(b, bClient)).toBe("Pacific/Honolulu");
    expect(await zoneOf(boss, bClient)).toBe("Pacific/Honolulu");
    // rep A cannot see B's merchant at all
    expect(await zoneOf(a, bClient)).toBeUndefined();
    const direct = (who: string, target: string) =>
      t.db.withUser(
        who,
        async (q) =>
          (await q.query<{ tz: string | null }>("select app.user_timezone($1) as tz", [target]))
            .rows[0]?.tz,
      );
    expect(await direct(a, a)).toBe("America/Chicago");
    expect(await direct(a, b)).toBeNull();
    expect(await direct(boss, b)).toBe("Pacific/Honolulu");
    // a forged merchant row naming B as its owner does not get B's zone out of client_timezone for a rep
    const forged = (who: string) =>
      t.db.withUser(
        who,
        async (q) =>
          (
            await q.query<{ tz: string }>(
              "select app.client_timezone(jsonb_populate_record(null::clients, jsonb_build_object('user_id', $1::text))) as tz",
              [b],
            )
          ).rows[0]?.tz,
      );
    expect(await forged(a)).toBe("America/New_York");
    expect(await forged(boss)).toBe("Pacific/Honolulu");
  });

  it("schedule_call, which reads the owner's zone, still works for the owner and a manager", async () => {
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await t.db.withUser(b, (q) =>
      q.query("select schedule_call($1, $2, 'ring him')", [bClient, at]),
    );
    const row = await t.pool.query("select scheduled_call_at from clients where id = $1", [
      bClient,
    ]);
    expect(row.rows[0]?.scheduled_call_at).not.toBeNull();
    const timers = await t.pool.query(
      "select count(*)::int as n from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null",
      [bClient],
    );
    expect(timers.rows[0]?.n).toBe(1);
    await t.db.withUser(boss, (q) =>
      q.query("select schedule_call($1, $2, 'boss moved it')", [bClient, at]),
    );
    const after = await t.pool.query(
      "select count(*)::int as n from timers where client_id = $1 and kind = 'scheduled_call' and done_at is null and note = 'boss moved it'",
      [bClient],
    );
    expect(after.rows[0]?.n).toBe(1);
  });
});

describe("the migration on a database that already has rows", () => {
  const name = `isaac_test_${randomBytes(6).toString("hex")}`;
  let dir: string;
  let admin: pg.Client;
  let conn: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    conn = new pg.Client({ connectionString: url.toString() });
    await conn.connect();
    // production is at an older migration: everything before 0576
    dir = mkdtempSync(join(tmpdir(), "isaac-mig-"));
    for (const f of readdirSync(MIGRATIONS).filter((x) => x < "0576"))
      copyFileSync(join(MIGRATIONS, f), join(dir, f));
    await migrate(conn, dir);
  });
  afterAll(async () => {
    await conn.end();
    await admin.query(`drop database ${name} with (force)`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every row, applies cleanly, and a second run changes nothing", async () => {
    const u = (
      await conn.query<{ id: string }>(
        "insert into app_users (email, timezone, notify_email) values ('old@x.com', 'America/Chicago', 'old-private@x.com') returning id",
      )
    ).rows[0]!.id;
    await conn.query("select set_config('app.user_id', $1, false)", [u]);
    const c = (
      await conn.query<{ id: string }>(
        `select id from create_client('{"business_name":"Old Deli","contact_name":"O","phone":"5551234567"}'::jsonb,
                                     jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', (current_date + 1)::text)))`,
      )
    ).rows[0]!.id;
    await conn.query("select set_config('app.user_id', '', false)");
    await conn.query(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status, scanned_at)
       values ($1, $2, 'other', 'old.pdf', 'application/pdf', 10, repeat('a', 64), $3, 'staff', 'clean', now())`,
      [u, c, `${c}/old.pdf`],
    );
    const applied = await migrate(conn, MIGRATIONS);
    expect(applied).toEqual(
      expect.arrayContaining(["0576_tighter_access.sql", "0577_tighter_documents.sql"]),
    );
    const doc = await conn.query("select scan_status from documents where client_id = $1", [c]);
    expect(doc.rows).toEqual([{ scan_status: "clean" }]);
    expect((await conn.query("select count(*)::int as n from app_users")).rows[0]?.n).toBe(1);
    expect((await conn.query("select notify_email from app_users")).rows[0]?.notify_email).toBe(
      "old-private@x.com",
    );
    for (const f of ["0576_tighter_access.sql", "0577_tighter_documents.sql"]) {
      await conn.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    expect((await conn.query("select count(*)::int as n from documents")).rows[0]?.n).toBe(1);
    // the old row works through the new door
    await conn.query("begin");
    await conn.query("set local role isaac_app");
    await conn.query("select set_config('app.user_id', $1, true)", [u]);
    expect((await conn.query("select timezone from app.my_user")).rows[0]?.timezone).toBe(
      "America/Chicago",
    );
    await conn.query("rollback");
  });
});
