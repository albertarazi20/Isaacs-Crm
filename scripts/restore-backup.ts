// Puts a backup file back:  npx tsx scripts/restore-backup.ts <backup.json> <email of the (empty) account>
// Needs DATABASE_URL (the owner connection). Everything is restored in one transaction, or nothing is.
import { readFileSync } from "node:fs";
import pg from "../src/lib/db/pg";
import { RestoreError, restoreBackup } from "../src/lib/export/restore";

const [file, email] = process.argv.slice(2);
if (!file || !email) {
  console.error("usage: npx tsx scripts/restore-backup.ts <backup.json> <account email>");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  const user = await client.query<{ id: string }>("select id from app_users where email = $1", [
    email,
  ]);
  const id = user.rows[0]?.id;
  if (!id)
    throw new RestoreError(`No account with the email ${email} — sign in once first so it exists`);
  await client.query("begin");
  const counts = await restoreBackup(client, JSON.parse(readFileSync(file, "utf8")), id);
  await client.query("commit");
  console.log("Restored:");
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(18)} ${n}`);
} catch (e) {
  await client.query("rollback").catch(() => undefined);
  console.error(e instanceof RestoreError ? e.message : e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
