import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbAccess } from "@/lib/db";
import {
  AUDIT_RETENTION_DAYS,
  EXPORT_HOURLY_LIMIT,
  FAILED_SIGNIN_LOG_CAP,
  recordAudit,
  recordExportDownload,
  refuseIfOverExportLimit,
  sweepAuditEvents,
} from "@/lib/system/audit";
import { listAuditEvents } from "@/lib/settings/securityLog";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The audit log against a real database: every assertion reads audit_events or user_alerts back with a plain query.
 */

let t: TestDb;
let boss: string;
let boss2: string;
let gone: string;
let rep: string;

const DEVICE_A = {
  ip: "203.0.113.10",
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36",
};
const DEVICE_B = { ip: "198.51.100.77", userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" };

const events = async (where = "true", params: unknown[] = []) =>
  (
    await t.pool.query<{
      kind: string;
      email: string;
      ip: string;
      user_agent: string;
      user_id: string | null;
      detail: Record<string, unknown>;
    }>(
      `select kind, email, ip, user_agent, user_id, detail from audit_events where ${where} order by at, id`,
      params,
    )
  ).rows;
const alertsOf = async (kind: string) =>
  (
    await t.pool.query<{ user_id: string; title: string; body: string; href: string }>(
      "select user_id, title, body, href from user_alerts where kind = $1 order by user_id, id",
      [kind],
    )
  ).rows;

beforeAll(async () => {
  t = await createTestDb();
  boss = await insertUser(t.pool, "boss@x.com");
  boss2 = await insertUser(t.pool, "boss2@x.com");
  gone = await insertUser(t.pool, "gone@x.com");
  rep = await insertUser(t.pool, "rep@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = any($1)", [
    [boss, boss2, gone],
  ]);
  await t.pool.query("update app_users set active = false where id = $1", [gone]);
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.pool.query("delete from audit_events");
  await t.pool.query("delete from user_alerts");
});

describe("the table: append-only for the app, readable by managers only", () => {
  it("row security is on and the app role can select and nothing else", async () => {
    const { rows } = await t.pool.query<{ rls: boolean }>(
      "select relrowsecurity as rls from pg_class where relname = 'audit_events'",
    );
    expect(rows[0]?.rls).toBe(true);
    const priv = async (p: string) =>
      (
        await t.pool.query<{ ok: boolean }>(
          "select has_table_privilege('isaac_app', 'public.audit_events', $1) as ok",
          [p],
        )
      ).rows[0]?.ok;
    expect(await priv("select")).toBe(true);
    for (const p of ["insert", "update", "delete", "truncate"]) expect(await priv(p)).toBe(false);
  });

  it("a rep reads nothing, a manager reads every line; nobody edits, deletes or inserts as the app", async () => {
    await recordAudit({ kind: "signin_ok", userId: rep, email: "rep@x.com", ...DEVICE_A }, t.db);
    expect(
      await t.db.withUser(rep, async (q) => (await q.query("select * from audit_events")).rowCount),
    ).toBe(0);
    expect((await t.db.withUser(rep, (q) => listAuditEvents(q))).length).toBe(0);
    const seen = await t.db.withUser(boss, (q) => listAuditEvents(q));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "signin_ok", email: "rep@x.com", ip: DEVICE_A.ip });

    for (const sql of [
      "update audit_events set email = 'x'",
      "delete from audit_events",
      "insert into audit_events (kind) values ('signin_ok')",
      "truncate audit_events",
    ]) {
      await expect(
        t.db.withUser(boss, (q) => q.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
    expect(await events()).toHaveLength(1);
  });
});

describe("recordAudit", () => {
  it("writes every field it is given", async () => {
    await recordAudit(
      {
        kind: "team_added",
        userId: boss,
        email: "Boss@X.com",
        ...DEVICE_A,
        detail: { target_email: "new@x.com", role: "rep" },
        clientId: "11111111-1111-4111-8111-111111111111",
      },
      t.db,
    );
    const { rows } = await t.pool.query(
      "select kind, user_id, email, ip, user_agent, detail, client_id, at from audit_events",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "team_added",
      user_id: boss,
      email: "boss@x.com",
      ip: DEVICE_A.ip,
      user_agent: DEVICE_A.userAgent,
      detail: { target_email: "new@x.com", role: "rep" },
      client_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(Math.abs(Date.now() - new Date(rows[0].at).getTime())).toBeLessThan(60_000);
  });

  it("an oversized detail is replaced, not stored", async () => {
    await recordAudit({ kind: "settings_shop_saved", detail: { big: "x".repeat(20_000) } }, t.db);
    expect((await events())[0]?.detail).toEqual({ truncated: true });
  });

  it("never throws when the database is down, and says what failed without echoing the detail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dead: DbAccess = {
      withUser: () => Promise.reject(new Error("nope")),
      withSystem: () => Promise.reject(new Error("connection refused")),
    };
    await expect(
      recordAudit({ kind: "signin_ok", userId: boss, detail: { secret: "hunter2" } }, dead),
    ).resolves.toBeUndefined();
    await expect(
      recordAudit({ kind: "signin_failed", email: "a@b.c", ip: "1.2.3.4" }, dead),
    ).resolves.toBeUndefined();
    await expect(
      recordExportDownload({ userId: boss, email: "b", what: "x", rows: 1 }, dead),
    ).resolves.toBeNull();
    await expect(refuseIfOverExportLimit({ userId: boss, email: "b" }, dead)).resolves.toBeNull();
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("signin_ok");
    expect(logged).toContain("connection refused");
    expect(logged).not.toContain("hunter2");
    spy.mockRestore();
  });

  it("never throws when the insert itself is refused by the database (a bad kind)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordAudit({ kind: "Not A Kind" as never, userId: boss }, t.db),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(await events()).toHaveLength(0);
  });
});

describe("alert: a sign-in from a device never seen before", () => {
  const signin = (device = DEVICE_A, userId = rep) =>
    recordAudit({ kind: "signin_ok", userId, email: "rep@x.com", ...device }, t.db);

  it("the first sign-in ever raises nothing", async () => {
    await signin(DEVICE_A);
    expect(await events("kind = 'signin_ok'")).toHaveLength(1);
    expect(await alertsOf("security_new_device")).toEqual([]);
  });

  it("the same device again raises nothing; a new one tells every active manager once", async () => {
    await signin(DEVICE_A);
    await signin(DEVICE_A);
    expect(await alertsOf("security_new_device")).toEqual([]);
    await signin(DEVICE_B);
    await signin(DEVICE_B);
    const alerts = await alertsOf("security_new_device");
    // two active managers; the switched-off manager and the rep hear nothing
    expect(alerts.map((a) => a.user_id).sort()).toEqual([boss, boss2].sort());
    expect(alerts[0]).toMatchObject({ href: "/settings/security" });
    expect(alerts[0]?.title).toContain("rep@x.com");
    expect(alerts[0]?.body).toContain(DEVICE_B.ip);
    expect(alerts[0]?.body).toContain("Safari on iPhone");
  });

  it("a device last seen more than 90 days ago counts as new again", async () => {
    await signin(DEVICE_A);
    await t.pool.query("update audit_events set at = now() - interval '100 days'");
    await signin(DEVICE_A);
    expect(await alertsOf("security_new_device")).toHaveLength(2);
  });

  it("a different person on the same device is judged on their own history", async () => {
    await signin(DEVICE_A, rep);
    await recordAudit({ kind: "signin_ok", userId: boss, email: "boss@x.com", ...DEVICE_A }, t.db);
    expect(await alertsOf("security_new_device")).toEqual([]);
  });
});

describe("alert: exports", () => {
  const who = () => ({ userId: rep, email: "rep@x.com", ...DEVICE_A });

  it("one export of more than 500 rows alerts the managers; 500 does not", async () => {
    expect(await recordExportDownload({ ...who(), what: "clients", rows: 500 }, t.db)).toBeNull();
    expect(await alertsOf("security_export")).toEqual([]);
    expect(await recordExportDownload({ ...who(), what: "clients", rows: 501 }, t.db)).toBeNull();
    const alerts = await alertsOf("security_export");
    expect(alerts.map((a) => a.user_id).sort()).toEqual([boss, boss2].sort());
    expect(alerts[0]?.title).toBe("Large export by rep@x.com");
    expect(alerts[0]?.body).toContain("501 rows");
    const lines = await events("kind = 'export_download'");
    expect(lines.map((l) => l.detail)).toEqual([
      { export: "clients", rows: 500 },
      { export: "clients", rows: 501 },
    ]);
  });

  it("more than 5 exports in an hour alert once, however many follow", async () => {
    for (let i = 0; i < 5; i += 1)
      await recordExportDownload({ ...who(), what: "notes", rows: 3 }, t.db);
    expect(await alertsOf("security_export")).toEqual([]);
    await recordExportDownload({ ...who(), what: "notes", rows: 3 }, t.db);
    await recordExportDownload({ ...who(), what: "notes", rows: 3 }, t.db);
    const alerts = await alertsOf("security_export");
    expect(alerts).toHaveLength(2); // one row per manager, not one per export
    expect(alerts[0]?.title).toBe("Many exports by rep@x.com");
    expect(alerts[0]?.body).toContain("6 export downloads");
  });
});

describe("alert: repeated failed sign-ins", () => {
  const fail = (email: string, ip: string) =>
    recordAudit(
      { kind: "signin_failed", email, ip, userAgent: "ua", detail: { reason: "bad_passcode" } },
      t.db,
    );

  it("five for the same email in 15 minutes alert the managers once", async () => {
    for (let i = 0; i < 4; i += 1) await fail("target@x.com", `10.0.0.${i}`);
    expect(await alertsOf("security_failed_signins")).toEqual([]);
    await fail("target@x.com", "10.0.0.9");
    await fail("target@x.com", "10.0.0.10");
    const alerts = await alertsOf("security_failed_signins");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.body).toContain("the email target@x.com");
    expect(alerts[0]?.body).not.toContain("the address");
    expect(await events("kind = 'signin_failed'")).toHaveLength(6);
  });

  it("five from the same address, whatever the email, alert too", async () => {
    for (let i = 0; i < 5; i += 1) await fail(`user${i}@x.com`, "192.0.2.50");
    const alerts = await alertsOf("security_failed_signins");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.body).toContain("the address 192.0.2.50");
  });

  it("failures older than 15 minutes do not count", async () => {
    for (let i = 0; i < 4; i += 1) await fail("slow@x.com", `10.1.0.${i}`);
    await t.pool.query("update audit_events set at = now() - interval '20 minutes'");
    await fail("slow@x.com", "10.1.0.99");
    expect(await alertsOf("security_failed_signins")).toEqual([]);
  });

  it("an address that has filled the window is not written down again (a flood guard)", async () => {
    await t.pool.query(
      `insert into audit_events (kind, email, ip) select 'signin_failed', 'a@x.com', '203.0.113.99' from generate_series(1, $1)`,
      [FAILED_SIGNIN_LOG_CAP],
    );
    await fail("a@x.com", "203.0.113.99");
    expect(await events("ip = '203.0.113.99'")).toHaveLength(FAILED_SIGNIN_LOG_CAP);
    await fail("a@x.com", "203.0.113.100");
    expect(await events("ip = '203.0.113.100'")).toHaveLength(1);
  });
});

describe("the export limit", () => {
  const who = () => ({ userId: rep, email: "rep@x.com", ...DEVICE_A });
  const fill = (n: number, user = rep, ago = "0 minutes") =>
    t.pool.query(
      `insert into audit_events (user_id, email, kind, at, detail)
       select $1, 'rep@x.com', 'export_download', now() - $3::interval, '{"export":"x","rows":1}' from generate_series(1, $2)`,
      [user, n, ago],
    );

  it("19 recent downloads: allowed. 20: the next is refused with a 429, a wait time and plain words", async () => {
    await fill(EXPORT_HOURLY_LIMIT - 1);
    expect(await refuseIfOverExportLimit(who(), t.db)).toBeNull();
    await fill(1, rep, "50 minutes");
    const res = await refuseIfOverExportLimit(who(), t.db);
    expect(res?.status).toBe(429);
    expect(await res?.text()).toMatch(/already made 20 exports in the last hour/);
    const wait = Number(res?.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    // the oldest line is 50 minutes old: about 10 minutes to wait
    expect(wait).toBeLessThanOrEqual(600);
    expect(wait).toBeGreaterThan(540);
  });

  it("downloads older than an hour, and other people's, do not count", async () => {
    await fill(EXPORT_HOURLY_LIMIT, rep, "61 minutes");
    await fill(EXPORT_HOURLY_LIMIT, boss);
    expect(await refuseIfOverExportLimit(who(), t.db)).toBeNull();
  });

  it("the refusal is logged, once in ten minutes, and counts for nothing", async () => {
    await fill(EXPORT_HOURLY_LIMIT);
    await refuseIfOverExportLimit(who(), t.db);
    await refuseIfOverExportLimit(who(), t.db);
    const lines = await events("kind = 'export_blocked'");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ user_id: rep, ip: DEVICE_A.ip });
    expect(await events("kind = 'export_download'")).toHaveLength(EXPORT_HOURLY_LIMIT);
  });

  it("recording a download re-checks under a lock: past the limit it writes nothing and answers 429", async () => {
    await fill(EXPORT_HOURLY_LIMIT);
    const res = await recordExportDownload({ ...who(), what: "clients", rows: 9 }, t.db);
    expect(res?.status).toBe(429);
    expect(await events("kind = 'export_download'")).toHaveLength(EXPORT_HOURLY_LIMIT);
  });

  it("parallel downloads cannot slip under the limit", async () => {
    await fill(EXPORT_HOURLY_LIMIT - 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordExportDownload({ ...who(), what: "clients", rows: 1 }, t.db),
      ),
    );
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r?.status === 429)).toHaveLength(5);
    expect(await events("kind = 'export_download'")).toHaveLength(EXPORT_HOURLY_LIMIT);
  });
});

describe("the retention sweep", () => {
  it("deletes lines older than 180 days and keeps the rest", async () => {
    await t.pool.query(
      `insert into audit_events (kind, email, at) values
         ('signin_ok', 'old@x.com', now() - interval '181 days'),
         ('signin_ok', 'older@x.com', now() - interval '400 days'),
         ('signin_ok', 'edge@x.com', now() - interval '179 days'),
         ('signin_ok', 'new@x.com', now())`,
    );
    expect(AUDIT_RETENTION_DAYS).toBe(180);
    expect(await sweepAuditEvents(t.db)).toBe(2);
    expect((await events()).map((e) => e.email).sort()).toEqual(["edge@x.com", "new@x.com"]);
    expect(await sweepAuditEvents(t.db)).toBe(0);
  });
});
