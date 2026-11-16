import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { epochMatches } from "@/lib/auth/epoch";
import { resolveSession } from "@/lib/auth/resolve";
import { signSession, verifySession } from "@/lib/auth/session";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const SECRET = "s".repeat(40);

describe("session epoch claim", () => {
  it("round-trips through the token", async () => {
    const token = await signSession(
      { userId: "u1", email: "a@x.com", epoch: 3, role: "rep" },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toEqual({
      userId: "u1",
      email: "a@x.com",
      epoch: 3,
      role: "rep",
    });
  });
  it("a token with no epoch counts as epoch 0", async () => {
    const token = await signSession({ userId: "u1", email: "a@x.com", role: "rep" }, SECRET);
    expect((await verifySession(token, SECRET))?.epoch).toBe(0);
  });
});

describe("epochMatches", () => {
  const claims = { userId: "u1", email: "a@x.com", epoch: 2, role: "rep" as const };
  it("accepts the current epoch", async () => {
    expect(await epochMatches(claims, async () => 2)).toBe(true);
  });
  it("rejects an older epoch (logged out everywhere)", async () => {
    expect(await epochMatches(claims, async () => 3)).toBe(false);
  });
  it("rejects a user that no longer exists", async () => {
    expect(await epochMatches(claims, async () => null)).toBe(false);
  });
  it("treats a missing claim as 0", async () => {
    expect(await epochMatches({ userId: "u1", email: "a@x.com", role: "rep" }, async () => 0)).toBe(
      true,
    );
    expect(await epochMatches({ userId: "u1", email: "a@x.com", role: "rep" }, async () => 1)).toBe(
      false,
    );
  });
});

describe("session_epoch in the database", () => {
  let t: TestDb;
  let user: string;
  beforeAll(async () => {
    t = await createTestDb();
    user = await insertUser(t.pool, "isaac@x.com");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("starts at 0", async () => {
    const { rows } = await t.pool.query("select session_epoch from app_users where id = $1", [
      user,
    ]);
    expect(rows[0]).toEqual({ session_epoch: 0 });
  });
  it("the app role cannot raise or lower it — only the server's owner connection can", async () => {
    await expect(
      t.db.withUser(user, (q) =>
        q.query("update app_users set session_epoch = 99 where id = $1", [user]),
      ),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await t.pool.query("select session_epoch from app_users where id = $1", [
      user,
    ]);
    expect(rows[0]?.session_epoch).toBe(0);
  });
  it("a bump changes the row, and the old epoch no longer matches", async () => {
    await t.pool.query("update app_users set session_epoch = session_epoch + 1 where id = $1", [
      user,
    ]);
    const { rows } = await t.pool.query<{ session_epoch: number }>(
      "select session_epoch from app_users where id = $1",
      [user],
    );
    const current = rows[0]?.session_epoch ?? -1;
    expect(current).toBe(1);
    expect(
      await epochMatches(
        { userId: user, email: "isaac@x.com", epoch: 0, role: "rep" },
        async () => current,
      ),
    ).toBe(false);
    expect(
      await epochMatches(
        { userId: user, email: "isaac@x.com", epoch: 1, role: "rep" },
        async () => current,
      ),
    ).toBe(true);
  });
});

describe("resolveSession — every rule that makes a cookie count", () => {
  const SECRET2 = "s".repeat(40);
  const deps = (over: Partial<Parameters<typeof resolveSession>[1]> = {}) => ({
    secret: SECRET2,
    allowed: () => true,
    currentEpoch: async () => 0,
    ...over,
  });
  const token = (epoch?: number) =>
    signSession({ userId: "u1", email: "isaac@x.com", epoch, role: "rep" }, SECRET2);

  it("accepts a good cookie", async () => {
    expect(await resolveSession(await token(0), deps())).toMatchObject({ userId: "u1", epoch: 0 });
  });
  it("refuses no cookie, a forged one, and one signed with another secret", async () => {
    expect(await resolveSession(undefined, deps())).toBeNull();
    expect(await resolveSession("a.b.c", deps())).toBeNull();
    expect(await resolveSession(await token(0), deps({ secret: "t".repeat(40) }))).toBeNull();
  });
  it("refuses an address that has been taken off the allowlist", async () => {
    expect(await resolveSession(await token(0), deps({ allowed: () => false }))).toBeNull();
  });
  it("after 'log out everywhere' (epoch moved on) the old cookie is dead, a new one works", async () => {
    expect(await resolveSession(await token(0), deps({ currentEpoch: async () => 1 }))).toBeNull();
    expect(
      await resolveSession(await token(1), deps({ currentEpoch: async () => 1 })),
    ).not.toBeNull();
  });
  it("a cookie issued before epochs existed counts as epoch 0 — and dies at the first bump", async () => {
    expect(
      await resolveSession(await token(undefined), deps({ currentEpoch: async () => 0 })),
    ).not.toBeNull();
    expect(
      await resolveSession(await token(undefined), deps({ currentEpoch: async () => 1 })),
    ).toBeNull();
  });
  it("a deleted user's cookie is dead", async () => {
    expect(
      await resolveSession(await token(0), deps({ currentEpoch: async () => null })),
    ).toBeNull();
  });
});
