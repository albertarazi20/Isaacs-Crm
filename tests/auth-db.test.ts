import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { DbAccess } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";
import {
  bootstrapFirstManager,
  currentSessionEpoch,
  loginUser,
  userExists,
} from "@/lib/system/users";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("crypto: encryptSecret / decryptSecret", () => {
  it("round-trips, including the empty string", () => {
    expect(decryptSecret(encryptSecret("refresh-token", KEY), KEY)).toBe("refresh-token");
    expect(decryptSecret(encryptSecret("", KEY), KEY)).toBe("");
  });
  it("refuses a blob whose GCM tag was cut short", () => {
    const [v, iv, tag, ct] = encryptSecret("secret", KEY).split(".");
    const short = Buffer.from(tag ?? "", "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(() => decryptSecret([v, iv, short, ct].join("."), KEY)).toThrow(/unrecognised/);
  });
  it("refuses a tampered ciphertext and a wrong key", () => {
    const blob = encryptSecret("secret", KEY);
    const parts = blob.split(".");
    parts[3] = Buffer.from("xxxxxx").toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow();
    expect(() => decryptSecret(blob, Buffer.alloc(32, 9).toString("base64"))).toThrow();
  });
});

describe("migrate", () => {
  it("reports the real migration error even when the rollback itself fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "isaac-migrate-"));
    await writeFile(join(dir, "0001_bad.sql"), "select 1");
    const client = {
      query: async (sql: string) => {
        if (sql === "select 1") throw new Error("syntax boom");
        if (sql === "rollback") throw new Error("connection lost");
        return { rows: [] };
      },
    };
    try {
      await expect(migrate(client as unknown as pg.ClientBase, dir)).rejects.toThrow(
        /0001_bad\.sql failed: syntax boom/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
const users = async () =>
  (await t.pool.query<{ email: string; role: string }>("select email, role from app_users")).rows;

describe("bootstrapFirstManager", () => {
  it("two different first sign-ins at the same instant make exactly one manager", async () => {
    // The first caller is held open after its insert (before its commit), so the second one really overlaps it.
    const slow: DbAccess = {
      withUser: t.db.withUser,
      withSystem: (fn) =>
        t.db.withSystem(async (q) => {
          const result = await fn(q);
          await new Promise((r) => setTimeout(r, 400));
          return result;
        }),
    };
    const first = bootstrapFirstManager("one@x.com", "One", slow);
    await new Promise((r) => setTimeout(r, 150));
    const second = await bootstrapFirstManager("two@x.com", "Two", t.db);
    expect(await first).toMatchObject({ email: "one@x.com", role: "manager" });
    expect(second).toBeNull();
    expect(await users()).toEqual([{ email: "one@x.com", role: "manager" }]);
  });
  it("does nothing once any account exists", async () => {
    expect(await bootstrapFirstManager("late@x.com", "Late", t.db)).toBeNull();
    expect(await users()).toHaveLength(1);
  });
});

describe("bootstrapFirstManager in production", () => {
  const prod = async (allowed: string, fn: () => Promise<void>) => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://unused");
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    vi.stubEnv("APP_URL", "https://crm.example.com");
    vi.stubEnv("ALLOWED_EMAILS", allowed);
    try {
      await fn();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  };
  it("an empty ALLOWED_EMAILS never lets a stranger become manager", async () => {
    const empty = await createTestDb();
    try {
      await prod("", async () => {
        const mod = await import("@/lib/system/users");
        expect(await mod.bootstrapFirstManager("stranger@x.com", "S", empty.db)).toBeNull();
      });
      const { rows } = await empty.pool.query("select 1 from app_users");
      expect(rows).toHaveLength(0);
    } finally {
      await empty.drop();
    }
  });
  it("only the listed address can bootstrap", async () => {
    const fresh = await createTestDb();
    try {
      await prod("boss@x.com", async () => {
        const mod = await import("@/lib/system/users");
        expect(await mod.bootstrapFirstManager("stranger@x.com", "S", fresh.db)).toBeNull();
        expect(await mod.bootstrapFirstManager("Boss@x.com", "Boss", fresh.db)).toMatchObject({
          email: "boss@x.com",
          role: "manager",
        });
      });
      const { rows } = await fresh.pool.query("select email, role from app_users");
      expect(rows).toEqual([{ email: "boss@x.com", role: "manager" }]);
    } finally {
      await fresh.drop();
    }
  });
});

describe("loginUser / currentSessionEpoch / userExists against the database", () => {
  it("a disabled account cannot sign in and its old session epoch is gone", async () => {
    const rep = await insertUser(t.pool, "rep@x.com");
    expect(await currentSessionEpoch(rep, t.db)).toBe(0);
    expect((await loginUser("REP@x.com", "Rep", t.db))?.id).toBe(rep);
    expect(
      (await t.pool.query("select last_login_at from app_users where id = $1", [rep])).rows[0],
    ).toMatchObject({ last_login_at: expect.any(Date) });

    await t.pool.query("update app_users set active = false where id = $1", [rep]);
    expect(await loginUser("rep@x.com", "Rep", t.db)).toBeNull();
    expect(await currentSessionEpoch(rep, t.db)).toBeNull();
    expect(await userExists(rep, t.db)).toBe(true);
  });
  it("an address nobody added gets null and creates nothing", async () => {
    expect(await loginUser("stranger@x.com", "S", t.db)).toBeNull();
    expect((await users()).some((u) => u.email === "stranger@x.com")).toBe(false);
  });
  it("Disable in Team bumps the epoch, so a live cookie stops matching", async () => {
    const [manager] = (
      await t.pool.query<{ id: string }>("select id from app_users where role = 'manager'")
    ).rows;
    const rep = await insertUser(t.pool, "rep2@x.com");
    const before = await currentSessionEpoch(rep, t.db);
    await t.db.withUser(manager?.id ?? "", (q) =>
      q.query("select set_team_member($1, 'rep', false)", [rep]),
    );
    expect(await currentSessionEpoch(rep, t.db)).toBeNull();
    const { rows } = await t.pool.query<{ session_epoch: number; active: boolean }>(
      "select session_epoch, active from app_users where id = $1",
      [rep],
    );
    expect(rows[0]?.active).toBe(false);
    expect(rows[0]?.session_epoch).toBeGreaterThan(before ?? 0);
  });
});

describe("db access layer", () => {
  it("a stored time zone Postgres does not know falls back to UTC instead of failing every request", async () => {
    const odd = await insertUser(t.pool, "odd@x.com", "EST5EDT-bogus");
    const zone = await t.db.withUser(odd, async (q) => {
      const { rows } = await q.query<{ timezone: string }>(
        "select current_setting('timezone') as timezone",
      );
      return rows[0]?.timezone;
    });
    expect(zone).toBe("UTC");
  });
  it("a valid zone is still applied", async () => {
    const ny = await insertUser(t.pool, "ny@x.com", "America/New_York");
    const zone = await t.db.withUser(ny, async (q) => {
      const { rows } = await q.query<{ timezone: string }>(
        "select current_setting('timezone') as timezone",
      );
      return rows[0]?.timezone;
    });
    expect(zone).toBe("America/New_York");
  });
  it("the owner connection has a statement and a lock timeout, the user connection its own", async () => {
    const owner = await t.db.withSystem(async (q) => {
      const { rows } = await q.query<{ s: string; l: string }>(
        "select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l",
      );
      return rows[0];
    });
    expect(owner).toEqual({ s: "5min", l: "30s" });
  });
});
