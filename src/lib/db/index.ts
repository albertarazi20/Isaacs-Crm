import pg from "./pg";

export type Db = pg.PoolClient;

export interface DbAccess {
  /** Every user-facing query runs here: as `isaac_app` with row-level security keyed to this user. */
  withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T>;
  /** Owner connection, RLS bypassed. Only src/app/api/** and src/lib/jobs/** may import this. */
  withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

async function inTransaction<T>(
  pool: pg.Pool,
  setup: (db: Db) => Promise<void>,
  fn: (db: Db) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await setup(db);
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

export function makeDb(pool: pg.Pool): DbAccess {
  return {
    withUser: (userId, fn) =>
      inTransaction(
        pool,
        async (db) => {
          await db.query("set local role isaac_app");
          // ALTER ROLE ... SET does not apply through SET ROLE, so the cap has to be set here.
          await db.query("set local statement_timeout = '15s'");
          await db.query("select set_config('app.user_id', $1, true)", [userId]);
        },
        fn,
      ),
    withSystem: (fn) => inTransaction(pool, async () => undefined, fn),
  };
}

const globalForPool = globalThis as unknown as { __isaacPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPool.__isaacPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const pool = new pg.Pool({ connectionString, max: 10 });
    // An idle connection the server drops (restart, failover) emits 'error'; with no listener Node
    // would crash the whole process. Log it — pg discards the dead client and the next query reconnects.
    pool.on("error", (e) => console.error("idle database connection error:", e.message));
    globalForPool.__isaacPool = pool;
  }
  return globalForPool.__isaacPool;
}

export const db: DbAccess = {
  withUser: (userId, fn) => makeDb(getPool()).withUser(userId, fn),
  withSystem: (fn) => makeDb(getPool()).withSystem(fn),
};
