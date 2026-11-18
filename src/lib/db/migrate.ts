import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

const LOCK_KEY = 727_274;

/** Applies db/migrations/*.sql in name order, each in its own transaction. Returns what it applied. */
export async function migrate(client: pg.ClientBase, dir: string): Promise<string[]> {
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (e) {
        // A dead connection must not hide the real migration error behind a failed rollback.
        await client.query("rollback").catch(() => undefined);
        throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
