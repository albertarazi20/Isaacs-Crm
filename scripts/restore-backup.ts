// Puts a backup file back:  npx tsx scripts/restore-backup.ts <backup.json> <email of the (empty) account> [--other-account]
// Needs DATABASE_URL (the owner connection). Everything is restored in one transaction, or nothing is.
import { existsSync, readFileSync } from "node:fs";
import pg from "../src/lib/db/pg";
import { checkBackup, RestoreError, restoreBackup } from "../src/lib/export/restore";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [file, rawEmail] = args;
const otherAccount = process.argv.includes("--other-account");
if (!file || !rawEmail) {
  console.error(
    "usage: npx tsx scripts/restore-backup.ts <backup.json> <account email> [--other-account]",
  );
  process.exit(2);
}
const email = rawEmail.trim().toLowerCase();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`No such file: ${file}`);
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
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const backup = checkBackup(parsed);
  const from =
    typeof backup.profile?.email === "string"
      ? backup.profile.email.toLowerCase()
      : "an unknown account";
  console.log(
    `Restoring ${backup.counts.clients ?? 0} merchants (taken ${backup.exportedAt.slice(0, 10)}) from ${from} into ${email}`,
  );
  if (from !== email && !otherAccount)
    throw new RestoreError(
      `That backup belongs to ${from}, not ${email}. If that is intended, run again with --other-account.`,
    );
  await client.query("begin");
  const counts = await restoreBackup(client, parsed, id);
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
