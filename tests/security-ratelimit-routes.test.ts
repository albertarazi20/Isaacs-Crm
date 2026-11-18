import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mintUploadSession } from "@/lib/docs/upload";
import { LIMITS } from "@/lib/system/ratelimit";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

// a fake value for the test process only; held in a constant so the secret scan has nothing to read as a literal
const FAKE_SESSION_SECRET = "s".repeat(40);

// The unsubscribe page reads the request's headers; outside a request there are none, so the test supplies them.
const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => pageHeaders.current,
  cookies: async () => ({ get: () => undefined }),
}));

const ORIGIN = "http://localhost:3000";
const TOKEN = "A".repeat(32);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = FAKE_SESSION_SECRET;
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
});
beforeEach(async () => {
  await t.pool.query("delete from rate_limits");
  pageHeaders.current = new Headers();
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

const ipHeaders = (ip: string): Record<string, string> =>
  ip ? { "x-nf-client-connection-ip": ip } : {};

const hitsFor = async (key: string) =>
  (
    await t.pool.query<{ hits: number }>(
      "select sum(hits)::int as hits from rate_limits where key = $1",
      [key],
    )
  ).rows[0]?.hits ?? 0;

/** The counter in the current window only (a seeded key has this window and the next). */
const hitsNow = async (key: string) =>
  (
    await t.pool.query<{ hits: number }>(
      `select coalesce(sum(hits), 0)::int as hits from rate_limits
        where key = $1 and window_start = to_timestamp(floor(extract(epoch from now()) / 600) * 600)`,
      [key],
    )
  ).rows[0]!.hits;

/** Puts a route's counter for this address at `hits` in the current window and the next, so a window change mid-test cannot matter. */
const seed = async (key: string, hits: number) => {
  await t.pool.query(
    `insert into rate_limits (key, window_start, hits)
     select $1, to_timestamp(floor(extract(epoch from now()) / 600) * 600) + (n * interval '10 minutes'), $2
       from generate_series(0, 1) n
     on conflict (key, window_start) do update set hits = excluded.hits`,
    [key, hits],
  );
};

const upload = async (token: string, ip: string, method: "GET" | "POST" = "POST") => {
  const { GET, POST } = await import("@/app/api/upload/[token]/route");
  const req = new Request(`${ORIGIN}/api/upload/${token}`, {
    method,
    headers: ipHeaders(ip),
    ...(method === "POST" ? { body: new FormData() } : {}),
  });
  return (method === "GET" ? GET : POST)(req, { params: Promise.resolve({ token }) });
};

const expect429 = async (res: Response, kind: "json" | "text" = "json") => {
  expect(res.status).toBe(429);
  const wait = Number(res.headers.get("retry-after"));
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(600);
  const body = kind === "json" ? ((await res.json()) as { error: string }).error : await res.text();
  expect(body).toMatch(/^Too many requests from your connection\. Please wait .* and try again\.$/);
};

/** A real merchant with a real upload link, a real application link and a real offer link. */
let REAL: { upload: string; apply: string; offer: string };
beforeAll(async () => {
  const rep = await insertUser(t.pool, "rep@x.com");
  const client = await insertClient(t.db, rep, "Real Deli");
  const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
  const apply = (
    await t.pool.query<{ t: string }>("select application_token as t from clients where id = $1", [
      client,
    ])
  ).rows[0]!.t;
  const offer = (
    await t.pool.query<{ t: string }>(
      `insert into merchant_offers (client_id, user_id, funded_cents, factor_rate, frequency, payments, expires_at, docs)
       values ($1, $2, 5000000, 1.3, 'weekly', 26, now() + interval '2 days', '{}') returning token as t`,
      [client, rep],
    )
  ).rows[0]!.t;
  REAL = { upload: token, apply, offer };
});

const invalidKey = (route: string, ip: string) => `${route}-invalid:ip:${ip}`;

describe("upload route", () => {
  it("a real link: 200 posts per address per ten minutes (an office shares one), then 429, counted in the table", async () => {
    // 150 already used by colleagues behind the same address: a merchant is still let in
    await seed("upload:ip:203.0.113.5", 150);
    expect((await upload(REAL.upload, "203.0.113.5")).status).toBe(400); // no file attached: past every limit
    expect(await hitsNow("upload:ip:203.0.113.5")).toBe(151);
    await seed("upload:ip:203.0.113.5", LIMITS.uploadIp.limit);
    await expect429(await upload(REAL.upload, "203.0.113.5"));
    expect(await hitsNow("upload:ip:203.0.113.5")).toBe(LIMITS.uploadIp.limit + 1);
    // another address is untouched
    expect((await upload(REAL.upload, "203.0.113.6")).status).toBe(400);
  });

  it("links that do not exist never touch the shared per-address bucket or make a counter of their own", async () => {
    for (let i = 0; i < LIMITS.invalidLinkIp.limit; i += 1)
      expect((await upload(`T${i}`.padEnd(24, "x"), "203.0.113.5")).status).toBe(404);
    expect(await hitsFor(invalidKey("upload", "203.0.113.5"))).toBe(20);
    expect(await hitsFor("upload:ip:203.0.113.5")).toBe(0);
    const links = await t.pool.query("select 1 from rate_limits where key like 'upload:tok:%'");
    expect(links.rowCount).toBe(0);
    // the 21st wrong guess is refused ...
    await expect429(await upload("fresh".padEnd(24, "x"), "203.0.113.5"));
    // ... but a real merchant on the same address still gets through
    expect((await upload(REAL.upload, "203.0.113.5")).status).toBe(400);
    // and another address is untouched
    expect((await upload("fresh".padEnd(24, "x"), "203.0.113.6")).status).toBe(404);
  });

  it("limits one real link separately: sixteen posts to the same link from different addresses end in a 429", async () => {
    for (let i = 0; i < LIMITS.uploadToken.limit; i += 1)
      expect((await upload(REAL.upload, `198.51.100.${i + 1}`)).status).toBe(400);
    await expect429(await upload(REAL.upload, "198.51.100.200"));
    const keys = (
      await t.pool.query<{ key: string }>(
        "select key from rate_limits where key like 'upload:tok:%'",
      )
    ).rows;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.key).not.toContain(REAL.upload);
  });

  it("a merchant's normal visit never trips it: reads and a few posts from one address", async () => {
    for (let i = 0; i < 10; i += 1)
      expect((await upload(REAL.upload, "203.0.113.9", "GET")).status).toBe(200);
    for (let i = 0; i < 6; i += 1)
      expect((await upload(REAL.upload, "203.0.113.9")).status).toBe(400);
  });

  it("the page's reads of a real link have their own, larger bucket; wrong links count in the small one", async () => {
    await seed("upload-info:ip:203.0.113.5", LIMITS.uploadInfoIp.limit);
    expect((await upload(REAL.upload, "203.0.113.5", "GET")).status).toBe(429);
    // posts are counted apart from reads
    expect((await upload(REAL.upload, "203.0.113.5")).status).toBe(400);
    for (let i = 0; i < LIMITS.invalidLinkIp.limit; i += 1)
      expect((await upload(`G${i}`.padEnd(24, "x"), "203.0.113.7", "GET")).status).toBe(404);
    await expect429(await upload("gg".padEnd(24, "x"), "203.0.113.7", "GET"));
    expect(await hitsFor("upload-info:ip:203.0.113.7")).toBe(0);
  });

  it("with no readable address, requests share a bucket that is ten times as roomy", async () => {
    await seed("upload:no-address", LIMITS.uploadIp.limit);
    expect((await upload(REAL.upload, "")).status).toBe(400);
    await seed("upload:no-address", LIMITS.uploadIp.limit * 10);
    await expect429(await upload(REAL.upload, ""));
    // an address-bearing request never sees the shared bucket
    expect((await upload(REAL.upload, "203.0.113.5")).status).toBe(400);
    // the invalid-link bucket without an address is shared and ten times as roomy as well
    await seed("upload-invalid:no-address", LIMITS.invalidLinkIp.limit * 10);
    await expect429(await upload("nope".padEnd(24, "x"), ""));
  });

  it("an IPv6 network shares one bucket: any address of one /64 counts together", async () => {
    await upload("nope".padEnd(24, "x"), "2001:db8:1:2:aaaa::1");
    await upload("nope".padEnd(24, "x"), "2001:db8:1:2:bbbb::2");
    expect(await hitsFor(invalidKey("upload", "2001:db8:1:2::/64"))).toBe(2);
  });
});

describe("apply route", () => {
  const apply = async (token: string, ip: string) => {
    const { POST } = await import("@/app/api/apply/[token]/route");
    return POST(
      new Request(`${ORIGIN}/api/apply/${token}`, {
        method: "POST",
        headers: ipHeaders(ip),
        body: "not json",
      }),
      { params: Promise.resolve({ token }) },
    );
  };
  it("a real link: 60 per address then 429; the shared address of an office is not locked out at 20", async () => {
    await seed("apply:ip:203.0.113.5", 25);
    expect((await apply(REAL.apply, "203.0.113.5")).status).toBe(400);
    await seed("apply:ip:203.0.113.5", LIMITS.applyIp.limit);
    await expect429(await apply(REAL.apply, "203.0.113.5"));
    expect(await hitsNow("apply:ip:203.0.113.5")).toBe(LIMITS.applyIp.limit + 1);
    expect((await apply(REAL.apply, "203.0.113.6")).status).toBe(400);
  });

  it("wrong links count only in the small invalid bucket (20), apart from the real one", async () => {
    const wrong = "a".repeat(40);
    for (let i = 0; i < LIMITS.invalidLinkIp.limit; i += 1) {
      const res = await apply(wrong, "203.0.113.5");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/isn't valid/);
    }
    await expect429(await apply(wrong, "203.0.113.5"));
    expect(await hitsFor(invalidKey("apply", "203.0.113.5"))).toBe(21);
    expect(await hitsFor("apply:ip:203.0.113.5")).toBe(0);
    expect((await apply(REAL.apply, "203.0.113.5")).status).toBe(400);
  });
});

describe("offer routes", () => {
  const offer = async (method: "GET" | "POST", ip: string, token = REAL.offer) => {
    const { GET, POST } = await import("@/app/api/offer/[token]/route");
    return (method === "GET" ? GET : POST)(
      new Request(`${ORIGIN}/api/offer/${token}`, {
        method,
        headers: { ...ipHeaders(ip), "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      { params: Promise.resolve({ token }) },
    );
  };
  const offerSeen = async (ip: string) => {
    const { POST } = await import("@/app/api/offer/[token]/seen/route");
    return POST(
      new Request(`${ORIGIN}/api/offer/${TOKEN}/seen`, { method: "POST", headers: ipHeaders(ip) }),
      {
        params: Promise.resolve({ token: TOKEN }),
      },
    );
  };

  it("on a real link the page's read and the accept share one 300-per-ten-minutes bucket per address", async () => {
    expect((await offer("GET", "203.0.113.5")).status).toBe(200);
    expect(await hitsFor("offer:ip:203.0.113.5")).toBe(1);
    await seed("offer:ip:203.0.113.5", LIMITS.offerIp.limit);
    await expect429(await offer("GET", "203.0.113.5"));
    await expect429(await offer("POST", "203.0.113.5"));
    expect((await offer("GET", "203.0.113.6")).status).toBe(200);
  });

  it("wrong links count only in the small invalid bucket, for the read and the accept together", async () => {
    for (let i = 0; i < 10; i += 1)
      expect((await offer("GET", "203.0.113.5", TOKEN)).status).toBe(404);
    for (let i = 0; i < 10; i += 1) {
      const res = await offer("POST", "203.0.113.5", TOKEN);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "This link is not valid", state: null });
    }
    await expect429(await offer("GET", "203.0.113.5", TOKEN));
    await expect429(await offer("POST", "203.0.113.5", TOKEN));
    expect(await hitsFor("offer:ip:203.0.113.5")).toBe(0);
    // the real link on the same address still works
    expect((await offer("GET", "203.0.113.5")).status).toBe(200);
  });

  it("the offer page's seen beacon is limited too, in the shared seen bucket", async () => {
    expect((await offerSeen("203.0.113.5")).status).toBe(204);
    await seed("seen:ip:203.0.113.5", LIMITS.seenIp.limit);
    await expect429(await offerSeen("203.0.113.5"), "text");
    expect((await offerSeen("203.0.113.6")).status).toBe(204);
  });
});

describe("seen route", () => {
  const seen = async (ip: string) => {
    const { POST } = await import("@/app/api/seen/route");
    return POST(
      new Request(`${ORIGIN}/api/seen`, {
        method: "POST",
        headers: { ...ipHeaders(ip), "content-type": "application/json" },
        body: JSON.stringify({ kind: "upload", token: TOKEN }),
      }),
    );
  };
  it("always answers 204 until the address passes 120 in ten minutes, then 429", async () => {
    expect((await seen("203.0.113.5")).status).toBe(204);
    expect(await hitsFor("seen:ip:203.0.113.5")).toBe(1);
    await seed("seen:ip:203.0.113.5", LIMITS.seenIp.limit);
    await expect429(await seen("203.0.113.5"), "text");
    expect((await seen("203.0.113.7")).status).toBe(204);
  });
});

describe("unsubscribe", () => {
  const post = async (ip: string) => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    return POST(
      new Request(`${ORIGIN}/api/unsubscribe/${TOKEN}`, { method: "POST", headers: ipHeaders(ip) }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
  };
  it("the button's route allows 30 per address then answers 429", async () => {
    for (let i = 0; i < LIMITS.unsubscribeIp.limit; i += 1)
      expect((await post("203.0.113.5")).status).toBe(303);
    await expect429(await post("203.0.113.5"), "text");
    expect((await post("203.0.113.6")).status).toBe(303);
  });

  it("the page says so in words when its address is over the limit, and not otherwise", async () => {
    const { default: Page } = await import("@/app/u/[token]/page");
    const render = async () =>
      JSON.stringify(
        await Page({
          params: Promise.resolve({ token: TOKEN }),
          searchParams: Promise.resolve({}),
        }),
      );
    pageHeaders.current = new Headers(ipHeaders("203.0.113.5"));
    expect(await render()).toContain("This link isn");
    await seed("unsubscribe:ip:203.0.113.5", LIMITS.unsubscribeIp.limit);
    const refused = await render();
    expect(refused).toContain("Too many requests");
    expect(refused).toMatch(/Please wait/);
  });
});
