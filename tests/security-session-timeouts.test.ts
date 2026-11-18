import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionOutcome, type ResolveDeps } from "@/lib/auth/resolve";
import {
  readSession,
  SESSION_DAYS,
  SESSION_IDLE_SECONDS,
  SESSION_ROLL_SECONDS,
  signSession,
} from "@/lib/auth/session";
import { startSession, sweepSessions, touchSession } from "@/lib/system/sessions";
import { bumpSessionEpoch, currentSessionEpoch } from "@/lib/system/users";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const SECRET = "s".repeat(40);
const T0 = new Date(Date.UTC(2026, 10, 18, 9, 0, 0));
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

let t: TestDb;
let user: string;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  await t.pool.query("delete from session_activity");
  await t.pool.query("delete from app_users");
  user = await insertUser(t.pool, "isaac@x.com");
});
afterAll(async () => {
  await t.drop();
});

const lastSeen = async (sid: string): Promise<Date | undefined> =>
  (
    await t.pool.query<{ last_seen_at: Date }>(
      "select last_seen_at from session_activity where sid = $1",
      [sid],
    )
  ).rows[0]?.last_seen_at;

/** The real rules against the test database, with a clock the test holds. */
const clock = { now: T0 };
const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  secret: SECRET,
  allowed: () => true,
  currentEpoch: (id) => currentSessionEpoch(id, t.db),
  touch: (sid, userId, now) => touchSession(sid, userId, now, t.db),
  now: () => clock.now,
  ...over,
});

/** A genuine sign-in at T0: a row in the table and a cookie that carries its id. */
const signIn = async (sid = "sid-1", epoch = 0) => {
  await startSession(sid, user, T0, t.db);
  const token = await signSession(
    { userId: user, email: "isaac@x.com", epoch, role: "manager", sid },
    SECRET,
    T0,
  );
  return { sid, token };
};
const resolveAt = async (token: string, seconds: number) => {
  clock.now = at(seconds);
  return resolveSessionOutcome(token, deps());
};

describe("the idle timeout: 12 hours of no use ends a session", () => {
  it("a sign-in is recorded as just used", async () => {
    const { sid } = await signIn();
    expect(await lastSeen(sid)).toEqual(T0);
    const { rows } = await t.pool.query("select user_id from session_activity where sid = $1", [
      sid,
    ]);
    expect(rows[0]).toEqual({ user_id: user });
  });

  it("a session used within 12 hours of its last use is accepted", async () => {
    const { token } = await signIn();
    expect(await resolveAt(token, 2 * HOUR)).toMatchObject({ claims: { userId: user } });
    expect(await resolveAt(token, 2 * HOUR + 11 * HOUR + 59 * MIN)).toMatchObject({
      claims: { userId: user },
    });
  });

  it("a session idle for more than 12 hours is refused, and says why", async () => {
    const { token, sid } = await signIn();
    const out = await resolveAt(token, SESSION_IDLE_SECONDS + 1);
    expect(out).toEqual({ claims: null, reason: "idle" });
    // the refusal does not revive it: it stays refused, however soon the person comes back after that
    expect((await resolveAt(token, SESSION_IDLE_SECONDS + 2)).claims).toBeNull();
    expect(await lastSeen(sid)).toEqual(T0);
  });

  it("exactly 12 hours idle is refused (the window is strictly less than 12 hours)", async () => {
    const { token } = await signIn();
    expect((await resolveAt(token, SESSION_IDLE_SECONDS)).claims).toBeNull();
    expect((await resolveAt(token, SESSION_IDLE_SECONDS - 1)).claims).not.toBeNull();
  });

  it("use rolls the idle window forward: busy for a day is never idle", async () => {
    const { token, sid } = await signIn();
    // a request every 11 hours for three days: each is inside 12 hours of the one before
    for (let h = 11; h <= 72; h += 11) {
      const out = await resolveAt(token, h * HOUR);
      expect(out.claims, `at ${h}h`).not.toBeNull();
      expect(await lastSeen(sid)).toEqual(at(h * HOUR));
    }
  });

  it("a gap of over 12 hours since the last use ends it, even though sign-in was recent", async () => {
    const { token } = await signIn();
    expect((await resolveAt(token, 11 * HOUR)).claims).not.toBeNull();
    // 11h later again is 22h after sign-in but only 11h after the last use: fine. A gap of 13h is not.
    expect((await resolveAt(token, 24 * HOUR + 1)).claims).toBeNull();
  });

  it("writes at most once every 5 minutes: busy minutes leave the stored time alone", async () => {
    const { token, sid } = await signIn();
    expect((await resolveAt(token, 1 * MIN)).claims).not.toBeNull();
    expect(await lastSeen(sid)).toEqual(T0);
    expect((await resolveAt(token, SESSION_ROLL_SECONDS - 1)).claims).not.toBeNull();
    expect(await lastSeen(sid)).toEqual(T0);
    expect((await resolveAt(token, SESSION_ROLL_SECONDS)).claims).not.toBeNull();
    expect(await lastSeen(sid)).toEqual(at(SESSION_ROLL_SECONDS));
    // and the next 5-minute gap is measured from the new time
    expect((await resolveAt(token, SESSION_ROLL_SECONDS + 4 * MIN)).claims).not.toBeNull();
    expect(await lastSeen(sid)).toEqual(at(SESSION_ROLL_SECONDS));
  });

  it("each sign-in has its own clock: a busy laptop does not keep a forgotten phone alive", async () => {
    const laptop = await signIn("laptop");
    const phone = await signIn("phone");
    for (let h = 8; h <= 24; h += 8)
      expect((await resolveAt(laptop.token, h * HOUR)).claims).not.toBeNull();
    expect(await resolveAt(phone.token, 24 * HOUR)).toEqual({ claims: null, reason: "idle" });
  });

  it("a session id with no record, or someone else's record, is refused", async () => {
    const { token } = await signIn();
    await t.pool.query("delete from session_activity");
    expect(await resolveAt(token, 1 * MIN)).toEqual({ claims: null, reason: "idle" });
    const other = await insertUser(t.pool, "other@x.com");
    await startSession("sid-2", other, T0, t.db);
    expect(await touchSession("sid-2", user, T0, t.db)).toBe("unknown");
  });

  it("touchSession reports ok, idle and unknown, and only rolls an ok one", async () => {
    await startSession("sid-3", user, T0, t.db);
    expect(await touchSession("sid-3", user, at(SESSION_ROLL_SECONDS), t.db)).toBe("ok");
    expect(await lastSeen("sid-3")).toEqual(at(SESSION_ROLL_SECONDS));
    expect(
      await touchSession("sid-3", user, at(SESSION_ROLL_SECONDS + SESSION_IDLE_SECONDS), t.db),
    ).toBe("idle");
    expect(await lastSeen("sid-3")).toEqual(at(SESSION_ROLL_SECONDS));
    expect(await touchSession("nope", user, T0, t.db)).toBe("unknown");
  });
});

describe("the absolute lifetime: 7 days from sign-in, however busy", () => {
  it("is seven days", () => {
    expect(SESSION_DAYS).toBe(7);
  });

  it("a session in constant use is still ended at 7 days, and is fine just before", async () => {
    const { token, sid } = await signIn();
    let seconds = 0;
    while (seconds + 11 * HOUR < SESSION_DAYS * DAY - 1) {
      seconds += 11 * HOUR;
      expect((await resolveAt(token, seconds)).claims, `at ${seconds / HOUR}h`).not.toBeNull();
    }
    expect((await resolveAt(token, SESSION_DAYS * DAY - 1)).claims).not.toBeNull();
    const out = await resolveAt(token, SESSION_DAYS * DAY);
    expect(out).toEqual({ claims: null, reason: "expired" });
    // the idle row was fresh the whole time: it is the age that ended it
    expect(await lastSeen(sid)).toEqual(at(SESSION_DAYS * DAY - 1));
  });

  it("the token's own expiry is seven days, set when it is signed", async () => {
    const token = await signSession(
      { userId: user, email: "isaac@x.com", epoch: 0, role: "rep" },
      SECRET,
      T0,
    );
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      iat: number;
      exp: number;
    };
    expect(claims.exp - claims.iat).toBe(7 * DAY);
  });

  it("a token minted when sessions lasted 14 days is ended at 7 days all the same", async () => {
    const iat = Math.floor(T0.getTime() / 1000);
    const legacy = await new SignJWT({ email: "isaac@x.com", ep: 0, role: "rep" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 14 * DAY)
      .sign(new TextEncoder().encode(SECRET));
    expect((await resolveAt(legacy, 6 * DAY)).claims).not.toBeNull();
    expect(await resolveAt(legacy, 8 * DAY)).toEqual({ claims: null, reason: "expired" });
    expect((await readSession(legacy, SECRET, at(8 * DAY))).ok).toBe(false);
  });

  it("a legacy token with no session id has no idle clock, only the absolute one", async () => {
    const legacy = await signSession(
      { userId: user, email: "isaac@x.com", epoch: 0, role: "rep" },
      SECRET,
      T0,
    );
    expect((await resolveAt(legacy, 3 * DAY)).claims).not.toBeNull();
  });

  it("a forged or garbled token is invalid, not expired", async () => {
    expect(await resolveAt("a.b.c", 0)).toEqual({ claims: null, reason: "invalid" });
    const { token } = await signIn();
    expect(await resolveSessionOutcome(token, deps({ secret: "t".repeat(40) }))).toEqual({
      claims: null,
      reason: "invalid",
    });
    expect(await resolveSessionOutcome(undefined, deps())).toEqual({
      claims: null,
      reason: "none",
    });
  });
});

describe("the session epoch still kills a session", () => {
  it("'log out everywhere' ends a recent, busy session at once, and never touches its idle row", async () => {
    const { token, sid } = await signIn("sid-e", 0);
    expect((await resolveAt(token, 10 * MIN)).claims).not.toBeNull();
    const before = await lastSeen(sid);
    await bumpSessionEpoch(user, t.db);
    const out = await resolveAt(token, 20 * MIN);
    expect(out).toEqual({ claims: null, reason: "revoked" });
    expect(await lastSeen(sid)).toEqual(before);
  });

  it("disabling the user ends their session at once", async () => {
    const { token } = await signIn();
    await t.pool.query("update app_users set active = false where id = $1", [user]);
    expect(await resolveAt(token, 1 * MIN)).toEqual({ claims: null, reason: "revoked" });
  });

  it("a deleted user's sign-in records go with them", async () => {
    await signIn();
    await t.pool.query("delete from app_users where id = $1", [user]);
    expect((await t.pool.query("select 1 from session_activity")).rowCount).toBe(0);
  });

  it("an address that is no longer allowed is refused before anything else", async () => {
    const { token } = await signIn();
    expect(await resolveSessionOutcome(token, deps({ allowed: () => false }))).toEqual({
      claims: null,
      reason: "revoked",
    });
  });
});

describe("the sweep", () => {
  it("removes sign-in records older than the lifetime plus a day, and keeps the rest", async () => {
    const now = at(30 * DAY);
    await startSession("old", user, at(0), t.db);
    await startSession("recent", user, at(30 * DAY - 2 * DAY), t.db);
    await startSession("edge", user, at(30 * DAY - (SESSION_DAYS + 1) * DAY + 1), t.db);
    expect(await sweepSessions(now, t.db)).toBe(1);
    const left = (
      await t.pool.query<{ sid: string }>("select sid from session_activity order by sid")
    ).rows;
    expect(left.map((r) => r.sid)).toEqual(["edge", "recent"]);
  });
});

describe("session_activity is system-only", () => {
  it("row security is on and the app role is granted nothing", async () => {
    const { rows } = await t.pool.query<{ rls: boolean; grants: number }>(
      `select c.relrowsecurity as rls,
              (select count(*)::int from information_schema.role_table_grants
                where table_name = 'session_activity' and grantee = 'isaac_app') as grants
         from pg_class c where c.relname = 'session_activity'`,
    );
    expect(rows[0]).toEqual({ rls: true, grants: 0 });
    await expect(
      t.db.withUser(user, (q) => q.query("select * from session_activity")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withUser(user, (q) =>
        q.query("update session_activity set last_seen_at = now() + interval '1 year'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
