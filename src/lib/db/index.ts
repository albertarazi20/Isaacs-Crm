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
  // pg-pool drops its own 'error' listener while a client is checked out, so a socket the server closes in the middle
  // of a request would otherwise be an uncaught error that takes the whole instance down. Log it, and never hand that
  // client to the next request.
  let broken = false;
  const onError = (e: Error) => {
    broken = true;
    console.error("database connection error during a request:", e.message);
  };
  db.on("error", onError);
  try {
    // JIT compiling a query is a fixed ~0.7 s cost that only pays off on huge scans. Listing 5,000 merchants
    // took 1.04 s with it and 0.27 s without (EXPLAIN ANALYZE on client_cards), so it is off for every request.
    await db.query("begin; set local jit = off");
    await setup(db);
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    db.off("error", onError);
    db.release(broken);
  }
}

export function makeDb(pool: pg.Pool): DbAccess {
  return {
    withUser: (userId, fn) =>
      inTransaction(
        pool,
        async (db) => {
          // ALTER ROLE ... SET does not apply through SET ROLE, so the cap has to be set here.
          // One round trip, not three (these are plain statements, no parameters).
          await db.query("set local role isaac_app; set local statement_timeout = '15s'");
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
    const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
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
