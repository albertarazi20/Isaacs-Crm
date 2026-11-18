import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hit,
  ipKey,
  LIMITS,
  limitByIp,
  limitByToken,
  NO_ADDRESS_FACTOR,
  sweepRateLimits,
  tokenKey,
  tooManyRequests,
} from "@/lib/system/ratelimit";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  await t.pool.query("delete from rate_limits");
});
afterAll(async () => {
  await t.drop();
});

interface Row {
  key: string;
  window_start: Date;
  hits: number;
}
const rows = async (): Promise<Row[]> =>
  (
    await t.pool.query<Row>(
      "select key, window_start, hits from rate_limits order by key, window_start",
    )
  ).rows;

/** A clock inside a known ten-minute window: 12:00:00 UTC on a fixed day, so 12:00 to 12:10 is one window. */
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + seconds * 1000);
const WINDOW = 600;

describe("hit(): counting in the database", () => {
  it("counts each hit in one row and allows up to the limit", async () => {
    for (let i = 1; i <= 3; i += 1) {
      const v = await hit("k:count", 3, WINDOW, { db: t.db, now: at(i) });
      expect(v).toMatchObject({ allowed: true, retryAfter: 0, hits: i });
      expect(await rows()).toEqual([{ key: "k:count", window_start: at(0), hits: i }]);
    }
  });

  it("refuses over the limit with the seconds left in the window, and keeps counting without extending it", async () => {
    for (let i = 0; i < 3; i += 1) await hit("k:over", 3, WINDOW, { db: t.db, now: at(10) });
    const fourth = await hit("k:over", 3, WINDOW, { db: t.db, now: at(100) });
    expect(fourth).toEqual({ allowed: false, retryAfter: 500, hits: 4 });
    const fifth = await hit("k:over", 3, WINDOW, { db: t.db, now: at(599) });
    expect(fifth).toEqual({ allowed: false, retryAfter: 1, hits: 5 });
    // still one window, one row: being refused did not push the window forward
    expect(await rows()).toEqual([{ key: "k:over", window_start: at(0), hits: 5 }]);
  });

  it("a new window starts the count again, and the old window's row stays until swept", async () => {
    for (let i = 0; i < 4; i += 1) await hit("k:roll", 3, WINDOW, { db: t.db, now: at(30) });
    expect((await hit("k:roll", 3, WINDOW, { db: t.db, now: at(30) })).allowed).toBe(false);
    const next = await hit("k:roll", 3, WINDOW, { db: t.db, now: at(WINDOW) });
    expect(next).toEqual({ allowed: true, retryAfter: 0, hits: 1 });
    expect(await rows()).toEqual([
      { key: "k:roll", window_start: at(0), hits: 5 },
      { key: "k:roll", window_start: at(WINDOW), hits: 1 },
    ]);
  });

  it("uses the database's own clock when no time is given", async () => {
    const v = await hit("k:real", 5, WINDOW, { db: t.db });
    expect(v).toMatchObject({ allowed: true, hits: 1 });
    const { rows: r } = await t.pool.query<{ ok: boolean }>(
      "select window_start <= now() and window_start + interval '600 seconds' > now() as ok from rate_limits where key = 'k:real'",
    );
    expect(r[0]?.ok).toBe(true);
  });

  it("parallel hits are all counted: no lost updates past the limit check", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hit("k:par", 10, WINDOW, { db: t.db, now: at(5) })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);
    expect((await rows())[0]?.hits).toBe(20);
  });
});

describe("per-address and per-token keys", () => {
  const headersFor = (ip: string) => new Headers(ip ? { "x-nf-client-connection-ip": ip } : {});
  const rule = { limit: 2, windowSeconds: WINDOW };

  it("one address's hits never count against another's", async () => {
    for (let i = 0; i < 3; i += 1)
      await limitByIp("upload", headersFor("203.0.113.1"), rule, { db: t.db, now: at(1) });
    const a = await limitByIp("upload", headersFor("203.0.113.1"), rule, { db: t.db, now: at(2) });
    const b = await limitByIp("upload", headersFor("203.0.113.2"), rule, { db: t.db, now: at(2) });
    expect(a.allowed).toBe(false);
    expect(b).toMatchObject({ allowed: true, hits: 1 });
    expect(await rows()).toEqual([
      { key: "upload:ip:203.0.113.1", window_start: at(0), hits: 4 },
      { key: "upload:ip:203.0.113.2", window_start: at(0), hits: 1 },
    ]);
  });

  it("one route's hits never count against another route's, for the same address", async () => {
    for (let i = 0; i < 3; i += 1)
      await limitByIp("apply", headersFor("203.0.113.1"), rule, { db: t.db, now: at(1) });
    const other = await limitByIp("offer", headersFor("203.0.113.1"), rule, {
      db: t.db,
      now: at(1),
    });
    expect(other.allowed).toBe(true);
    expect((await rows()).map((r) => r.key)).toEqual([
      "apply:ip:203.0.113.1",
      "offer:ip:203.0.113.1",
    ]);
  });

  it("an empty address uses one shared bucket with a limit NO_ADDRESS_FACTOR times higher", async () => {
    expect(ipKey("upload", "")).toBe("upload:no-address");
    const max = rule.limit * NO_ADDRESS_FACTOR;
    // a request that has an address would be over the plain limit by now; the shared bucket is not
    for (let i = 1; i <= max; i += 1) {
      const v = await limitByIp("upload", headersFor(""), rule, { db: t.db, now: at(1) });
      expect(v.allowed, `hit ${i}`).toBe(true);
    }
    const over = await limitByIp("upload", headersFor(""), rule, { db: t.db, now: at(1) });
    expect(over.allowed).toBe(false);
    expect(await rows()).toEqual([
      { key: "upload:no-address", window_start: at(0), hits: max + 1 },
    ]);
    // and a caller WITH an address is unaffected by the full shared bucket
    expect(
      (await limitByIp("upload", headersFor("198.51.100.9"), rule, { db: t.db, now: at(1) }))
        .allowed,
    ).toBe(true);
  });

  it("a token is counted by a hash: the row never holds the link's token itself", async () => {
    const token = "TOKENTOKENTOKENTOKEN12345678";
    const v = await limitByToken("upload", token, rule, { db: t.db, now: at(1) });
    expect(v.allowed).toBe(true);
    const keys = (await rows()).map((r) => r.key);
    expect(keys).toEqual([tokenKey("upload", token)]);
    expect(keys[0]).not.toContain(token);
    expect(tokenKey("upload", token)).not.toBe(tokenKey("upload", `${token}x`));
  });

  it("a very long address header cannot make the key too long to store", async () => {
    const v = await limitByIp("upload", headersFor("1".repeat(500)), rule, {
      db: t.db,
      now: at(1),
    });
    expect(v.hits).toBe(1);
    expect((await rows())[0]?.key.length).toBeLessThanOrEqual(160);
  });
});

describe("the real limits leave a merchant room", () => {
  it("six one-file offer uploads, two retries and the page's reads stay far under every limit", () => {
    expect(LIMITS.uploadToken.limit).toBeGreaterThanOrEqual(6 + 6 + 3);
    expect(LIMITS.uploadIp.limit).toBeGreaterThanOrEqual(LIMITS.uploadToken.limit);
    expect(LIMITS.offerIp.limit).toBeGreaterThanOrEqual(100);
    expect(LIMITS.seenIp.limit).toBeGreaterThanOrEqual(100);
  });
});

describe("a counter that cannot be reached lets the request through", () => {
  it("limitByIp fails open and says so in the log", async () => {
    const broken = {
      withUser: () => Promise.reject(new Error("nope")),
      withSystem: () => Promise.reject(new Error("database down")),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const v = await limitByIp("upload", new Headers(), LIMITS.uploadIp, { db: broken });
    expect(v.allowed).toBe(true);
    expect(log).toHaveBeenCalledWith("rate limit not counted:", expect.any(Error));
    log.mockRestore();
  });
});

describe("the refusal", () => {
  it("is a 429 with Retry-After and a friendly message, as JSON or as text", async () => {
    const json = tooManyRequests(130);
    expect(json.status).toBe(429);
    expect(json.headers.get("retry-after")).toBe("130");
    expect(await json.json()).toEqual({
      error: "Too many requests from your connection. Please wait 3 minutes and try again.",
    });
    const text = tooManyRequests(20, "text");
    expect(text.status).toBe(429);
    expect(text.headers.get("retry-after")).toBe("20");
    expect(await text.text()).toBe(
      "Too many requests from your connection. Please wait a minute and try again.",
    );
  });
});

describe("the sweep", () => {
  it("deletes windows older than a day and keeps recent ones, counted from the table", async () => {
    await t.pool.query(
      `insert into rate_limits (key, window_start, hits) values
         ('old:a', now() - interval '2 days', 5),
         ('old:b', now() - interval '25 hours', 1),
         ('new:a', now() - interval '23 hours', 3),
         ('new:b', now(), 1)`,
    );
    expect(await sweepRateLimits(t.db)).toBe(2);
    expect((await rows()).map((r) => r.key)).toEqual(["new:a", "new:b"]);
    expect(await sweepRateLimits(t.db)).toBe(0);
  });
});

describe("rate_limits is system-only", () => {
  it("row security is on and the app role has no grants: every query from it is refused", async () => {
    const { rows: r } = await t.pool.query<{ rls: boolean; grants: number }>(
      `select c.relrowsecurity as rls,
              (select count(*)::int from information_schema.role_table_grants
                where table_name = 'rate_limits' and grantee = 'isaac_app') as grants
         from pg_class c where c.relname = 'rate_limits'`,
    );
    expect(r[0]).toEqual({ rls: true, grants: 0 });
    const user = await insertUser(t.pool, "rl-owner@x.com");
    await expect(t.db.withUser(user, (q) => q.query("select * from rate_limits"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      t.db.withUser(user, (q) =>
        q.query("insert into rate_limits (key, window_start, hits) values ('x', now(), 1)"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(t.db.withUser(user, (q) => q.query("delete from rate_limits"))).rejects.toThrow(
      /permission denied/,
    );
  });
});
