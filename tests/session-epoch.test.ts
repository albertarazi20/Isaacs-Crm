import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { epochMatches } from "@/lib/auth/epoch";
import { signSession, verifySession } from "@/lib/auth/session";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const SECRET = "s".repeat(40);

describe("session epoch claim", () => {
  it("round-trips through the token", async () => {
    const token = await signSession({ userId: "u1", email: "a@x.com", epoch: 3 }, SECRET);
    expect(await verifySession(token, SECRET)).toEqual({
      userId: "u1",
      email: "a@x.com",
      epoch: 3,
    });
  });
  it("a token with no epoch counts as epoch 0", async () => {
    const token = await signSession({ userId: "u1", email: "a@x.com" }, SECRET);
    expect((await verifySession(token, SECRET))?.epoch).toBe(0);
  });
});

describe("epochMatches", () => {
  const claims = { userId: "u1", email: "a@x.com", epoch: 2 };
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
    expect(await epochMatches({ userId: "u1", email: "a@x.com" }, async () => 0)).toBe(true);
    expect(await epochMatches({ userId: "u1", email: "a@x.com" }, async () => 1)).toBe(false);
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
      await epochMatches({ userId: user, email: "isaac@x.com", epoch: 0 }, async () => current),
    ).toBe(false);
    expect(
      await epochMatches({ userId: user, email: "isaac@x.com", epoch: 1 }, async () => current),
    ).toBe(true);
  });
});
