import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Signing out must end the session on the server, not just clear the browser's cookie: a copy of the cookie taken
 * before sign-out has to be refused afterwards. Driven with a real passcode sign-in, the real server actions, and
 * session_activity read back from the database.
 */

const jar = vi.hoisted(() => ({
  token: undefined as string | undefined,
  cleared: 0,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "isaac_session" && jar.token ? { value: jar.token } : undefined,
    set: () => undefined,
    delete: () => {
      jar.cleared += 1;
    },
  }),
  headers: async () => new Headers({ "x-nf-client-connection-ip": "203.0.113.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const PASSCODE = "correct horse battery staple";
const SECRET = "s".repeat(40);
const ORIGIN = "http://localhost:3000";

let t: TestDb;
let owner: string;
let other: string;
beforeAll(async () => {
  t = await createTestDb();
  const url = (t.pool as unknown as { options: { connectionString: string } }).options
    .connectionString;
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = SECRET;
  process.env.APP_URL = ORIGIN;
  process.env.ALLOWED_EMAILS = "owner@x.com";
  process.env.ACCESS_PASSCODE = PASSCODE;
  owner = await insertUser(t.pool, "owner@x.com");
  other = await insertUser(t.pool, "other@x.com");
});
afterEach(() => {
  jar.token = undefined;
  jar.cleared = 0;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

/** A real passcode sign-in. Returns the cookie value and its session id. */
async function signIn(ip: string): Promise<{ cookie: string; sid: string }> {
  const { POST } = await import("@/app/api/auth/passcode/route");
  const form = new FormData();
  form.set("passcode", PASSCODE);
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/auth/passcode`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-nf-client-connection-ip": ip },
      body: form,
    }),
  );
  expect(res.status).toBe(303);
  const cookie = res.cookies.get(SESSION_COOKIE)?.value ?? "";
  const sid = (await verifySession(cookie, SECRET))?.sid ?? "";
  expect(sid).toBeTruthy();
  return { cookie, sid };
}

const rowsFor = async (userId: string) =>
  (
    await t.pool.query<{ sid: string }>("select sid from session_activity where user_id = $1", [
      userId,
    ])
  ).rows.map((r) => r.sid);

const refused = async (cookie: string): Promise<boolean> => {
  jar.token = cookie;
  const { getSession } = await import("@/lib/auth/server");
  return (await getSession()) === null;
};

describe("logoutAction ends the session on the server", () => {
  it("a copy of the cookie taken before sign-out is refused afterwards, and its row is gone", async () => {
    const { cookie, sid } = await signIn("203.0.113.10");
    expect(await rowsFor(owner)).toContain(sid);
    expect(await refused(cookie)).toBe(false); // works before

    jar.token = cookie;
    const { logoutAction } = await import("@/app/actions");
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(jar.cleared).toBe(1);

    // the database really changed
    expect(await rowsFor(owner)).not.toContain(sid);
    // and the stolen copy of the cookie (still a genuine, unexpired signature) no longer works
    expect(await refused(cookie)).toBe(true);
  });

  it("only that sign-in ends: the person's other device and another person's sign-in stay", async () => {
    const phone = await signIn("203.0.113.11");
    const laptop = await signIn("203.0.113.12");
    await t.pool.query("insert into session_activity (sid, user_id) values ('someone-else', $1)", [
      other,
    ]);
    jar.token = laptop.cookie;
    const { logoutAction } = await import("@/app/actions");
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await rowsFor(owner)).toContain(phone.sid);
    expect(await rowsFor(owner)).not.toContain(laptop.sid);
    expect(await rowsFor(other)).toEqual(["someone-else"]);
    expect(await refused(phone.cookie)).toBe(false);
    expect(await refused(laptop.cookie)).toBe(true);
  });

  it("a cookie naming another person's session id cannot end it", async () => {
    const { endSession } = await import("@/lib/system/sessions");
    await t.pool.query("insert into session_activity (sid, user_id) values ('theirs', $1)", [
      other,
    ]);
    expect(await endSession("theirs", owner)).toBe(0);
    expect(await rowsFor(other)).toContain("theirs");
  });

  it("signing out with no cookie, or a forged one, deletes nothing and still redirects", async () => {
    const before = (await t.pool.query("select count(*)::int as n from session_activity")).rows[0]
      .n;
    const { logoutAction } = await import("@/app/actions");
    jar.token = undefined;
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    jar.token = "not-a-real-token";
    await expect(logoutAction()).rejects.toThrow(/NEXT_REDIRECT/);
    expect((await t.pool.query("select count(*)::int as n from session_activity")).rows[0].n).toBe(
      before,
    );
  });
});

describe("logoutEverywhereAction", () => {
  it("deletes every session row of that person (and only that person's), and every old cookie is refused", async () => {
    const a = await signIn("203.0.113.20");
    const b = await signIn("203.0.113.21");
    await t.pool.query("insert into session_activity (sid, user_id) values ('keeps', $1)", [other]);
    expect((await rowsFor(owner)).length).toBeGreaterThanOrEqual(2);
    const epochBefore = (
      await t.pool.query("select session_epoch from app_users where id = $1", [owner])
    ).rows[0].session_epoch;

    jar.token = a.cookie;
    const { logoutEverywhereAction } = await import("@/app/actions");
    await expect(logoutEverywhereAction()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await rowsFor(owner)).toEqual([]);
    expect(await rowsFor(other)).toContain("keeps");
    expect(
      (await t.pool.query("select session_epoch from app_users where id = $1", [owner])).rows[0]
        .session_epoch,
    ).toBe(epochBefore + 1);
    expect(await refused(a.cookie)).toBe(true);
    expect(await refused(b.cookie)).toBe(true);
  });
});
