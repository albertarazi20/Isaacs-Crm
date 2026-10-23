import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "@/lib/db/pg";
import { makeDb, type DbAccess } from "@/lib/db";
import { migrate } from "@/lib/db/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/postgres";

export interface TestDb {
  pool: pg.Pool;
  db: DbAccess;
  /** The database's own idea of today — date guards in SQL use its clock, so tests must too. */
  today: string;
  drop(): Promise<void>;
}

/** A throwaway database per test file, fully migrated. Files run in parallel without touching each other. */
export async function createTestDb(): Promise<TestDb> {
  const name = `isaac_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  const setup = await pool.connect();
  try {
    await migrate(setup, join(process.cwd(), "db", "migrations"));
  } finally {
    setup.release();
  }
  const { rows } = await pool.query<{ today: string }>("select current_date::text as today");
  return {
    pool,
    db: makeDb(pool),
    today: rows[0]?.today ?? "",
    async drop() {
      await pool.end();
      // pool.end() resolves before the sockets finish closing; forcing the drop now would kill
      // connections mid-close and surface as an unhandled 57P01. Wait until they are really gone.
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await admin.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = $1",
          [name],
        );
        if (rows[0]?.n === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

export async function insertUser(pool: pg.Pool, email: string, timezone = "UTC"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into app_users (email, timezone) values ($1, $2) returning id",
    [email, timezone],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("user not inserted");
  return id;
}

export async function insertClient(
  db: DbAccess,
  userId: string,
  businessName = "Mike's Pizza",
  dueOn = "",
): Promise<string> {
  return db.withUser(userId, async (q) => {
    const due =
      dueOn || (await q.query<{ d: string }>("select (current_date + 1)::text as d")).rows[0]?.d;
    const { rows } = await q.query<{ id: string }>(
      "select id from create_client($1::jsonb, $2::jsonb)",
      [
        JSON.stringify({ business_name: businessName, contact_name: "Mike", phone: "5551234567" }),
        JSON.stringify([{ kind: "follow_up", due_on: due }]),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("client not inserted");
    return id;
  });
}

export const timersJson = (...t: { kind: string; due_on: string; note?: string }[]) =>
  JSON.stringify(t);
