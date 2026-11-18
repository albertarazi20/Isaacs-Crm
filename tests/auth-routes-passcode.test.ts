import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientIp } from "@/lib/docs/clientIp";
import {
  claimPasscodeAttempt,
  clearPasscodeAttempts,
  PASSCODE_LOCK_SECONDS,
  PASSCODE_MAX_ATTEMPTS,
} from "@/lib/system/users";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const PASSCODE = "correct horse battery staple";
const ORIGIN = "http://localhost:3000";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
  process.env.ACCESS_PASSCODE = PASSCODE;
  await insertUser(t.pool, "owner@x.com");
});
beforeEach(async () => {
  await t.pool.query("delete from passcode_attempts");
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

const post = async (
  passcode: string | null,
  {
    ip = "203.0.113.7",
    origin = ORIGIN as string | null,
    raw,
  }: { ip?: string; origin?: string | null; raw?: string } = {},
) => {
  const { POST } = await import("@/app/api/auth/passcode/route");
  const headers: Record<string, string> = { "x-nf-client-connection-ip": ip };
  if (origin !== null) headers.origin = origin;
  let body: BodyInit;
  if (raw !== undefined) {
    headers["content-type"] = "multipart/form-data; boundary=zzz";
    body = raw;
  } else {
    const form = new FormData();
    if (passcode !== null) form.set("passcode", passcode);
    body = form;
  }
  return POST(new NextRequest(`${ORIGIN}/api/auth/passcode`, { method: "POST", headers, body }));
};
const attempts = async () =>
  (
    await t.pool.query<{ key: string; failures: number; locked: boolean }>(
      "select key, failures, locked_until > now() as locked from passcode_attempts order by key",
    )
  ).rows;

describe("passcode route: malformed requests", () => {
  it("a malformed Origin is a 403, not a crash, and counts as no attempt", async () => {
    expect((await post(PASSCODE, { origin: "null" })).status).toBe(403);
    expect((await post(PASSCODE, { origin: "not a url" })).status).toBe(403);
    expect((await post(PASSCODE, { origin: null })).status).toBe(403);
    expect((await post(PASSCODE, { origin: "https://evil.example" })).status).toBe(403);
    expect(await attempts()).toEqual([]);
  });
  it("a malformed form body is a 400 and counts as no attempt", async () => {
    const res = await post(null, { raw: "this is not multipart" });
    expect(res.status).toBe(400);
    expect(await attempts()).toEqual([]);
  });
});

describe("passcode route: persistent limit", () => {
  it("a right passcode signs in, sets the session cookie and leaves no row behind", async () => {
    const res = await post(PASSCODE);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(res.cookies.get("isaac_session")?.value).toBeTruthy();
    expect(await attempts()).toEqual([]);
  });

  it("each wrong guess is counted in the database; the fifth locks the address with a 429", async () => {
    for (let i = 1; i < PASSCODE_MAX_ATTEMPTS; i += 1) {
      const res = await post("wrong guess here");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=bad_passcode");
      expect(await attempts()).toEqual([{ key: "ip:203.0.113.7", failures: i, locked: null }]);
    }
    const fifth = await post("wrong guess here");
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(fifth.headers.get("retry-after"))).toBeLessThanOrEqual(PASSCODE_LOCK_SECONDS);
    expect(await fifth.text()).toMatch(
      /too many sign-in attempts[\s\S]*wait <strong>\d+ minutes<\/strong>/i,
    );
    expect((await attempts())[0]?.locked).toBe(true);
  });

  it("a locked address is refused before the passcode is compared: even the RIGHT passcode gets a 429, no cookie", async () => {
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i += 1) await post("wrong guess here");
    const res = await post(PASSCODE);
    expect(res.status).toBe(429);
    expect(res.cookies.get("isaac_session")).toBeUndefined();
    // a refused attempt does not extend the lock
    const [row] = (
      await t.pool.query<{ secs: number }>(
        "select extract(epoch from locked_until - now())::int as secs from passcode_attempts",
      )
    ).rows;
    expect(row?.secs).toBeLessThanOrEqual(PASSCODE_LOCK_SECONDS);
  });

  it("only that address is locked; another address still signs in", async () => {
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i += 1) await post("wrong guess here");
    expect((await post(PASSCODE)).status).toBe(429);
    const other = await post(PASSCODE, { ip: "198.51.100.9" });
    expect(other.status).toBe(303);
    expect(other.cookies.get("isaac_session")?.value).toBeTruthy();
  });

  it("a correct passcode before the limit clears the count", async () => {
    await post("wrong guess here");
    await post("wrong guess here");
    expect((await attempts())[0]?.failures).toBe(2);
    expect((await post(PASSCODE)).status).toBe(303);
    expect(await attempts()).toEqual([]);
  });

  it("parallel guesses cannot slip past the limit: at most five are ever compared", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => post("wrong guess here")));
    const compared = results.filter((r) => r.status === 303).length;
    const refused = results.filter((r) => r.status === 429).length;
    expect(compared).toBe(PASSCODE_MAX_ATTEMPTS - 1);
    expect(refused).toBe(12 - compared);
  });

  it("the lock ends by itself: an expired lock starts a fresh count and the right passcode works", async () => {
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i += 1) await post("wrong guess here");
    await t.pool.query(
      "update passcode_attempts set locked_until = now() - interval '1 second', window_start = now() - interval '16 minutes'",
    );
    const wrong = await post("wrong guess here");
    expect(wrong.status).toBe(303);
    expect(await attempts()).toEqual([{ key: "ip:203.0.113.7", failures: 1, locked: null }]);
    expect((await post(PASSCODE)).status).toBe(303);
  });

  it("guesses spread over more than the window do not add up", async () => {
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS - 1; i += 1) await post("wrong guess here");
    await t.pool.query("update passcode_attempts set window_start = now() - interval '16 minutes'");
    expect((await post("wrong guess here")).status).toBe(303);
    expect((await attempts())[0]).toMatchObject({ failures: 1, locked: null });
  });

  it("a spoofable x-forwarded-for is not the key when the platform header is there", () => {
    const h = new Headers({
      "x-nf-client-connection-ip": "203.0.113.7",
      "x-forwarded-for": "1.1.1.1",
    });
    expect(clientIp(h)).toBe("203.0.113.7");
  });
});

describe("passcode_attempts table", () => {
  it("has row-level security on and not one grant for isaac_app; the app role cannot touch it", async () => {
    const { rows } = await t.pool.query<{ rls: boolean; any_grant: boolean }>(
      `select c.relrowsecurity as rls,
              (has_table_privilege('isaac_app', c.oid, 'select') or has_table_privilege('isaac_app', c.oid, 'insert')
               or has_table_privilege('isaac_app', c.oid, 'update') or has_table_privilege('isaac_app', c.oid, 'delete')) as any_grant
         from pg_class c where c.relname = 'passcode_attempts'`,
    );
    expect(rows).toEqual([{ rls: true, any_grant: false }]);
    const user = await insertUser(t.pool, "rep@x.com");
    await expect(
      t.db.withUser(user, (q) => q.query("select * from passcode_attempts")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withUser(user, (q) => q.query("delete from passcode_attempts")),
    ).rejects.toThrow(/permission denied/);
  });
  it("claim and clear work on the owner connection and hold only a key and counters", async () => {
    const first = await claimPasscodeAttempt("ip:test", t.db);
    expect(first).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await attempts()).toEqual([{ key: "ip:test", failures: 1, locked: null }]);
    await clearPasscodeAttempts("ip:test", t.db);
    expect(await attempts()).toEqual([]);
  });
  it("old unlocked rows are swept when anyone claims", async () => {
    await t.pool.query(
      "insert into passcode_attempts (key, failures, window_start) values ('ip:old', 2, now() - interval '3 days')",
    );
    await claimPasscodeAttempt("ip:new", t.db);
    expect((await attempts()).map((r) => r.key)).toEqual(["ip:new"]);
  });
});
