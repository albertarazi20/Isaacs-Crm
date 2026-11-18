import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, NO_ADDRESS_FACTOR } from "@/lib/system/ratelimit";
import { FAILED_SIGNIN_GLOBAL_CAP, FAILED_SIGNIN_LOG_CAP, recordAudit } from "@/lib/system/audit";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// a fake value for the test process only; held in a constant so the secret scan has nothing to read as a literal
const FAKE_SESSION_SECRET = "s".repeat(40);

/**
 * The public Google routes cannot be used to flood the audit table or the managers' alert feed: they are rate limited
 * per address, the failed-sign-in alert is at most one an hour in total, and the flood guard holds with no readable
 * address too. Every assertion reads the database back.
 */

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

const ORIGIN = "http://localhost:3000";
let t: TestDb;
let boss: string;
let boss2: string;

beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = FAKE_SESSION_SECRET;
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  boss = await insertUser(t.pool, "boss@x.com");
  boss2 = await insertUser(t.pool, "boss2@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = any($1)", [[boss, boss2]]);
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});
beforeEach(async () => {
  await t.pool.query("delete from audit_events");
  await t.pool.query("delete from user_alerts");
  await t.pool.query("delete from rate_limits");
});

const count = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;
const hitsFor = async (key: string) =>
  (
    await t.pool.query<{ hits: number }>(
      "select coalesce(sum(hits), 0)::int as hits from rate_limits where key = $1",
      [key],
    )
  ).rows[0]!.hits;

const callback = async (ip: string) => {
  const { GET } = await import("@/app/api/auth/callback/route");
  return GET(
    new NextRequest(`${ORIGIN}/api/auth/callback?code=abc&state=forged`, {
      headers: ip ? { "x-nf-client-connection-ip": ip } : {},
    }),
  );
};
const google = async (ip: string) => {
  const { GET } = await import("@/app/api/auth/google/route");
  return GET(
    new NextRequest(`${ORIGIN}/api/auth/google`, {
      headers: ip ? { "x-nf-client-connection-ip": ip } : {},
    }),
  );
};

describe("GET /api/auth/callback is rate limited", () => {
  it("30 forged callbacks from one address per ten minutes are answered and logged; the 31st is a 429 and writes nothing", async () => {
    for (let i = 0; i < LIMITS.authIp.limit; i += 1)
      expect((await callback("203.0.113.5")).status).toBe(307);
    expect(await count("audit_events where kind = 'signin_failed'")).toBe(30);
    expect(await hitsFor("auth-callback:ip:203.0.113.5")).toBe(30);

    const res = await callback("203.0.113.5");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // refused before anything was written
    expect(await count("audit_events where kind = 'signin_failed'")).toBe(30);
    expect(await hitsFor("auth-callback:ip:203.0.113.5")).toBe(31);

    // another address is untouched
    expect((await callback("203.0.113.6")).status).toBe(307);
  });

  it("with no readable address everyone shares one bucket that is ten times as roomy", async () => {
    await t.pool.query(
      `insert into rate_limits (key, window_start, hits)
       select 'auth-callback:no-address', to_timestamp(floor(extract(epoch from now()) / 600) * 600) + (n * interval '10 minutes'), $1
         from generate_series(0, 1) n`,
      [LIMITS.authIp.limit * NO_ADDRESS_FACTOR],
    );
    expect((await callback("")).status).toBe(429);
    expect((await callback("203.0.113.5")).status).toBe(307);
  });

  it("an IPv6 network counts as one address: its /64 shares the bucket", async () => {
    for (let i = 0; i < LIMITS.authIp.limit; i += 1)
      await callback(`2001:db8:1:2:${i.toString(16)}::${i + 1}`);
    expect(await hitsFor("auth-callback:ip:2001:db8:1:2::/64")).toBe(30);
    expect((await callback("2001:db8:1:2:ffff::9")).status).toBe(429);
  });
});

describe("GET /api/auth/google is rate limited", () => {
  it("30 starts per address per ten minutes, then 429, counted in rate_limits", async () => {
    for (let i = 0; i < LIMITS.authIp.limit; i += 1)
      expect((await google("203.0.113.5")).status).toBe(307);
    expect(await hitsFor("auth-google:ip:203.0.113.5")).toBe(30);
    expect((await google("203.0.113.5")).status).toBe(429);
    expect((await google("203.0.113.6")).status).toBe(307);
  });
});

describe("the failed sign-in alert is one an hour in total", () => {
  const fail = (email: string, ip: string) =>
    recordAudit(
      { kind: "signin_failed", email, ip, userAgent: "ua", detail: { reason: "bad_passcode" } },
      t.db,
    );
  const alerts = () =>
    t.pool
      .query<{ user_id: string; body: string }>(
        "select user_id, body from user_alerts where kind = 'security_failed_signins' order by id",
      )
      .then((r) => r.rows);

  it("a second attack on a different email and address in the same hour adds no second alert, but every line is still written", async () => {
    for (let i = 0; i < 5; i += 1) await fail("first@x.com", "192.0.2.1");
    expect(await alerts()).toHaveLength(2); // one row per manager
    for (let i = 0; i < 5; i += 1) await fail("second@x.com", "192.0.2.2");
    for (let i = 0; i < 5; i += 1) await fail(`user${i}@x.com`, `192.0.2.${10 + i}`);
    expect(await alerts()).toHaveLength(2);
    expect(await count("audit_events where kind = 'signin_failed'")).toBe(15);
  });

  it("a different alert key is not used per address: the dedupe key has no subject in it", async () => {
    for (let i = 0; i < 5; i += 1) await fail("first@x.com", "192.0.2.1");
    const { rows } = await t.pool.query<{ dedupe_key: string }>(
      "select dedupe_key from user_alerts where kind = 'security_failed_signins'",
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.dedupe_key).not.toContain("first@x.com");
      expect(r.dedupe_key).not.toContain("192.0.2.1");
    }
  });
});

describe("the flood guard holds with no readable address", () => {
  const fail = (email: string, ip: string) =>
    recordAudit(
      { kind: "signin_failed", email, ip, userAgent: "ua", detail: { reason: "bad_state" } },
      t.db,
    );
  const seedFailures = (n: number, ip: string, ago = "0 minutes") =>
    t.pool.query(
      `insert into audit_events (kind, email, ip, at)
       select 'signin_failed', 'a@x.com', $2, now() - $3::interval from generate_series(1, $1)`,
      [n, ip, ago],
    );

  it("failures with an empty address are capped like any other address (100 in the window)", async () => {
    await seedFailures(FAILED_SIGNIN_LOG_CAP, "");
    await fail("a@x.com", "");
    expect(await count("audit_events where ip = ''")).toBe(FAILED_SIGNIN_LOG_CAP);
  });

  it("across all addresses no more than 500 failed lines are written in an hour", async () => {
    // spread so no single address and no 15-minute window is full: 500 rows over 50 minutes, 25 addresses
    await t.pool.query(
      `insert into audit_events (kind, email, ip, at)
       select 'signin_failed', 'a@x.com', '198.51.100.' || (g % 25), now() - ((g % 50) || ' minutes')::interval
         from generate_series(1, $1) g`,
      [FAILED_SIGNIN_GLOBAL_CAP],
    );
    expect(await count("audit_events where kind = 'signin_failed'")).toBe(FAILED_SIGNIN_GLOBAL_CAP);
    await fail("new@x.com", "203.0.113.200");
    await fail("new@x.com", "");
    expect(await count("audit_events where kind = 'signin_failed'")).toBe(FAILED_SIGNIN_GLOBAL_CAP);
  });

  it("older than an hour does not count toward the global cap", async () => {
    await t.pool.query(
      `insert into audit_events (kind, email, ip, at)
       select 'signin_failed', 'a@x.com', '198.51.100.' || (g % 25), now() - interval '2 hours'
         from generate_series(1, $1) g`,
      [FAILED_SIGNIN_GLOBAL_CAP],
    );
    await fail("new@x.com", "203.0.113.200");
    expect(await count("audit_events where ip = '203.0.113.200'")).toBe(1);
  });
});
