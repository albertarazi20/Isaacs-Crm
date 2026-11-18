import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientIp } from "@/lib/docs/clientIp";
import {
  claimPasscodeAttempt,
  PASSCODE_LOCK_SECONDS,
  PASSCODE_MAX_ATTEMPTS,
  PASSCODE_NO_ADDRESS_KEY,
  PASSCODE_NO_ADDRESS_MAX_ATTEMPTS,
  passcodeKey,
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

/** A post with NO address header at all (ip = null) or with the platform header. */
const post = async (passcode: string, ip: string | null) => {
  const { POST } = await import("@/app/api/auth/passcode/route");
  const headers: Record<string, string> = { origin: ORIGIN };
  if (ip !== null) headers["x-nf-client-connection-ip"] = ip;
  const form = new FormData();
  form.set("passcode", passcode);
  return POST(
    new NextRequest(`${ORIGIN}/api/auth/passcode`, { method: "POST", headers, body: form }),
  );
};
const rows = async () =>
  (
    await t.pool.query<{ key: string; failures: number; locked: boolean }>(
      "select key, failures, locked_until > now() as locked from passcode_attempts order by key",
    )
  ).rows;

describe("no readable client address", () => {
  it("reads as an empty address and maps to its own key, never to a real address's key", () => {
    expect(clientIp(new Headers())).toBe("");
    expect(passcodeKey("")).toBe(PASSCODE_NO_ADDRESS_KEY);
    expect(passcodeKey("203.0.113.7")).toBe("ip:203.0.113.7");
    // a header value that happens to say "unknown" is an address key, not the shared bucket
    expect(passcodeKey("unknown")).toBe("ip:unknown");
    expect(PASSCODE_NO_ADDRESS_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5 * PASSCODE_MAX_ATTEMPTS);
  });

  it("five wrong guesses with no address do not lock anyone out, and the row is in the shared bucket", async () => {
    for (let i = 1; i <= PASSCODE_MAX_ATTEMPTS + 2; i += 1) {
      const res = await post("wrong guess here", null);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("error=bad_passcode");
      expect(await rows()).toEqual([{ key: PASSCODE_NO_ADDRESS_KEY, failures: i, locked: null }]);
    }
    // the manager, also with no address header, still gets in
    const ok = await post(PASSCODE, null);
    expect(ok.status).toBe(303);
    expect(ok.cookies.get("isaac_session")?.value).toBeTruthy();
    expect(await rows()).toEqual([]);
  });

  it("brute force stays bounded: the 30th wrong guess locks the shared bucket for 15 minutes, with the wait in plain words", async () => {
    for (let i = 1; i < PASSCODE_NO_ADDRESS_MAX_ATTEMPTS; i += 1)
      expect((await post("wrong guess here", null)).status).toBe(303);
    expect(await rows()).toEqual([
      {
        key: PASSCODE_NO_ADDRESS_KEY,
        failures: PASSCODE_NO_ADDRESS_MAX_ATTEMPTS - 1,
        locked: null,
      },
    ]);
    const tripped = await post("wrong guess here", null);
    expect(tripped.status).toBe(429);
    expect(Number(tripped.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(tripped.headers.get("retry-after"))).toBeLessThanOrEqual(PASSCODE_LOCK_SECONDS);
    expect(tripped.headers.get("content-type")).toMatch(/text\/html/);
    const body = await tripped.text();
    expect(body).toMatch(/too many sign-in attempts/i);
    expect(body).toMatch(/wait <strong>15 minutes<\/strong>/i);
    expect(body).toContain('href="/login"');
    expect((await rows())[0]).toMatchObject({ key: PASSCODE_NO_ADDRESS_KEY, locked: true });
    // locked: even the right passcode is refused before it is compared
    const right = await post(PASSCODE, null);
    expect(right.status).toBe(429);
    expect(right.cookies.get("isaac_session")).toBeUndefined();
  });

  it("the shared bucket does not touch a real address, and a real address keeps the five-try limit", async () => {
    for (let i = 0; i < PASSCODE_NO_ADDRESS_MAX_ATTEMPTS; i += 1)
      await post("wrong guess here", null);
    expect((await rows()).find((r) => r.key === PASSCODE_NO_ADDRESS_KEY)?.locked).toBe(true);
    // a person with a real address is unaffected by the stranger's lock
    const real = await post(PASSCODE, "198.51.100.9");
    expect(real.status).toBe(303);
    expect(real.cookies.get("isaac_session")?.value).toBeTruthy();
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i += 1) await post("wrong guess here", "192.0.2.50");
    expect((await post(PASSCODE, "192.0.2.50")).status).toBe(429);
    const byKey = Object.fromEntries((await rows()).map((r) => [r.key, r]));
    expect(byKey["ip:192.0.2.50"]).toMatchObject({
      failures: PASSCODE_MAX_ATTEMPTS + 1,
      locked: true,
    });
  });

  it("claimPasscodeAttempt: the shared key is allowed up to 30 and refused after; a real key is refused after 5", async () => {
    for (let i = 1; i <= PASSCODE_NO_ADDRESS_MAX_ATTEMPTS; i += 1) {
      const c = await claimPasscodeAttempt(PASSCODE_NO_ADDRESS_KEY, t.db);
      expect(c.allowed, `attempt ${i}`).toBe(true);
    }
    expect(await claimPasscodeAttempt(PASSCODE_NO_ADDRESS_KEY, t.db)).toMatchObject({
      allowed: false,
    });
    for (let i = 1; i <= PASSCODE_MAX_ATTEMPTS; i += 1)
      expect((await claimPasscodeAttempt("ip:203.0.113.1", t.db)).allowed).toBe(true);
    expect((await claimPasscodeAttempt("ip:203.0.113.1", t.db)).allowed).toBe(false);
  });

  it("the lock on the shared bucket ends: after it expires the count starts again", async () => {
    for (let i = 0; i < PASSCODE_NO_ADDRESS_MAX_ATTEMPTS; i += 1)
      await claimPasscodeAttempt(PASSCODE_NO_ADDRESS_KEY, t.db);
    await t.pool.query(
      "update passcode_attempts set locked_until = now() - interval '1 second', window_start = now() - interval '16 minutes'",
    );
    expect(await claimPasscodeAttempt(PASSCODE_NO_ADDRESS_KEY, t.db)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(await rows()).toEqual([{ key: PASSCODE_NO_ADDRESS_KEY, failures: 1, locked: null }]);
  });
});

describe("the 429 page for a real address says how long to wait", () => {
  it("names the wait in minutes and links back to sign-in", async () => {
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i += 1)
      await post("wrong guess here", "203.0.113.7");
    const res = await post("wrong guess here", "203.0.113.7");
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toMatch(/wait <strong>(1[0-5]) minutes<\/strong>/i);
    expect(body).toContain('href="/login"');
  });
});
