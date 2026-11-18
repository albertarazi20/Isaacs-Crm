import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_IDLE_SECONDS, verifySession } from "@/lib/auth/session";
import { bumpSessionEpoch } from "@/lib/system/users";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// a fake value for the test process only; held in a constant so the secret scan has nothing to read as a literal
const FAKE_SESSION_SECRET = "s".repeat(40);

// Sign in through the real passcode route, then ask for the session the way a page does, with the clock moved.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const PASSCODE = "correct horse battery staple";
const ORIGIN = "http://localhost:3000";
const HOUR = 3_600_000;

let t: TestDb;
let owner: string;
beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = FAKE_SESSION_SECRET;
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
  process.env.ACCESS_PASSCODE = PASSCODE;
  owner = await insertUser(t.pool, "owner@x.com");
});
afterEach(() => {
  vi.useRealTimers();
  jar.token = undefined;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

/** Signs in with the passcode and puts the cookie it set in the jar. Returns the cookie's session id. */
async function signIn(): Promise<string> {
  const { POST } = await import("@/app/api/auth/passcode/route");
  const form = new FormData();
  form.set("passcode", PASSCODE);
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/auth/passcode`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-nf-client-connection-ip": "203.0.113.7" },
      body: form,
    }),
  );
  expect(res.status).toBe(303);
  const value = res.cookies.get(SESSION_COOKIE)?.value;
  expect(value).toBeTruthy();
  jar.token = value;
  const claims = await verifySession(value, "s".repeat(40));
  expect(claims?.sid).toBeTruthy();
  return claims?.sid ?? "";
}

const lastSeen = async (sid: string) =>
  (
    await t.pool.query<{ last_seen_at: Date; user_id: string }>(
      "select last_seen_at, user_id from session_activity where sid = $1",
      [sid],
    )
  ).rows[0];

const redirectTarget = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    return digest.startsWith("NEXT_REDIRECT") ? (digest.split(";")[2] ?? null) : null;
  }
};

describe("sign-in records the session and the cookie carries its id", () => {
  it("passcode sign-in writes a session_activity row for the user", async () => {
    const sid = await signIn();
    expect(await lastSeen(sid)).toMatchObject({ user_id: owner });
  });

  it("the cookie lasts seven days in the browser as well", async () => {
    const { POST } = await import("@/app/api/auth/passcode/route");
    const form = new FormData();
    form.set("passcode", PASSCODE);
    const res = await POST(
      new NextRequest(`${ORIGIN}/api/auth/passcode`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-nf-client-connection-ip": "203.0.113.8" },
        body: form,
      }),
    );
    expect(res.cookies.get(SESSION_COOKIE)?.maxAge).toBe(7 * 86_400);
  });
});

describe("requireSession / getSession with a real sign-in and a moved clock", () => {
  it("a recent session passes and a page load inside five minutes writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T09:00:00Z") });
    const sid = await signIn();
    const first = (await lastSeen(sid))?.last_seen_at;
    vi.setSystemTime(new Date("2026-11-18T09:02:00Z"));
    const { requireSession } = await import("@/lib/auth/server");
    expect((await requireSession()).userId).toBe(owner);
    expect((await lastSeen(sid))?.last_seen_at).toEqual(first);
  });

  it("use after five minutes rolls the window forward", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T09:00:00Z") });
    const sid = await signIn();
    vi.setSystemTime(new Date("2026-11-18T09:06:00Z"));
    const { getSession } = await import("@/lib/auth/server");
    expect(await getSession()).toMatchObject({ userId: owner });
    expect((await lastSeen(sid))?.last_seen_at).toEqual(new Date("2026-11-18T09:06:00Z"));
  });

  it("13 hours of no use sends the person to the sign-in page with the inactivity reason", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T09:00:00Z") });
    await signIn();
    vi.setSystemTime(new Date(Date.now() + 13 * HOUR));
    const { getSession, requireSession } = await import("@/lib/auth/server");
    expect(await getSession()).toBeNull();
    expect(await redirectTarget(() => requireSession())).toBe("/login?reason=idle");
  });

  it("an eight-day-old session, used every few hours, is sent to sign in again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T09:00:00Z") });
    await signIn();
    const { requireSession } = await import("@/lib/auth/server");
    for (let h = 11; h < 7 * 24; h += 11) {
      vi.setSystemTime(new Date(new Date("2026-11-18T09:00:00Z").getTime() + h * HOUR));
      expect((await requireSession()).userId).toBe(owner);
    }
    vi.setSystemTime(new Date(new Date("2026-11-18T09:00:00Z").getTime() + 7 * 24 * HOUR + 1000));
    expect(await redirectTarget(() => requireSession())).toBe("/login?error=session_expired");
  });

  it("'log out everywhere' still ends a session that was in use a minute ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T09:00:00Z") });
    await signIn();
    const { requireSession } = await import("@/lib/auth/server");
    vi.setSystemTime(new Date("2026-11-18T09:10:00Z"));
    expect((await requireSession()).userId).toBe(owner);
    await bumpSessionEpoch(owner);
    vi.setSystemTime(new Date("2026-11-18T09:11:00Z"));
    expect(await redirectTarget(() => requireSession())).toBe("/login");
  });

  it("no cookie at all is a plain trip to the sign-in page", async () => {
    const { requireSession } = await import("@/lib/auth/server");
    expect(await redirectTarget(() => requireSession())).toBe("/login");
  });

  it("the idle limit is twelve hours", () => {
    expect(SESSION_IDLE_SECONDS).toBe(12 * 3600);
  });
});

describe("the sign-in page", () => {
  const render = async (searchParams: { error?: string; reason?: string }) => {
    const { default: LoginPage } = await import("@/app/login/page");
    return JSON.stringify(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
  };
  it("says 'You were signed out for inactivity' when that was the reason", async () => {
    expect(await render({ reason: "idle" })).toContain("You were signed out for inactivity");
  });
  it("says nothing of the kind on an ordinary visit or for another reason", async () => {
    expect(await render({})).not.toContain("signed out for inactivity");
    expect(await render({ reason: "something-else" })).not.toContain("signed out for inactivity");
  });
});
