// Puts a backup file back:  npx tsx scripts/restore-backup.ts <backup.json> <email of the (empty) account> [--other-account] [--require-encrypted]
// Needs DATABASE_URL (the owner connection). Everything is restored in one transaction, or nothing is.
// --require-encrypted refuses a plain (unencrypted) file before the database is touched: use it whenever the backup is
// supposed to be encrypted, so a swapped-in plain file cannot slip through. A plain file restored without it prints a warning.
// An encrypted backup (.enc.json) asks for its passphrase (typed hidden), or reads BACKUP_PASSPHRASE; it is never an argument.
import { existsSync, readFileSync } from "node:fs";
import pg from "../src/lib/db/pg";
import {
  isEncryptedBackup,
  PassphraseRequired,
  readBackupFile,
} from "../src/lib/export/backupCrypto";
import { checkBackup, RestoreError, restoreBackup } from "../src/lib/export/restore";

/** Reads a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(
        new RestoreError(
          "That backup is encrypted: set BACKUP_PASSPHRASE or run this in a terminal",
        ),
      );
      return;
    }
    process.stderr.write(question);
    let typed = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stderr.write("\n");
          resolve(typed);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        typed = ch === "\u007f" ? typed.slice(0, -1) : typed + ch;
      }
    };
    input.on("data", onData);
  });
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [file, rawEmail] = args;
const otherAccount = process.argv.includes("--other-account");
const requireEncrypted = process.argv.includes("--require-encrypted");
if (!file || !rawEmail) {
  console.error(
    "usage: npx tsx scripts/restore-backup.ts <backup.json> <account email> [--other-account] [--require-encrypted]",
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
const text = readFileSync(file, "utf8");
/** True when the file is an encrypted envelope; a file that is not even JSON is not one. */
const encrypted = (() => {
  try {
    return isEncryptedBackup(JSON.parse(text));
  } catch {
    return false;
  }
})();
if (requireEncrypted && !encrypted) {
  // before the database is reached: a plain file where an encrypted one was expected is refused outright
  console.error(
    `Refusing to restore ${file}: --require-encrypted was given and this file is not encrypted (it is a plain backup, or not a backup at all). Nothing was restored.`,
  );
  process.exit(1);
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
  // Decrypting touches no database: a wrong passphrase stops here, before anything is written.
  let parsed: unknown;
  try {
    parsed = await readBackupFile(text, process.env.BACKUP_PASSPHRASE);
  } catch (e) {
    if (!(e instanceof PassphraseRequired)) throw e;
    parsed = await readBackupFile(text, await askHidden("Backup passphrase: "));
  }
  if (!encrypted)
    console.error(
      [
        "",
        "!!!! WARNING: THIS BACKUP FILE IS NOT ENCRYPTED !!!!",
        "It holds merchant names, phone numbers and funding terms in clear text. Anyone who ever had a copy could read it.",
        "Delete every copy once the restore is done, and download encrypted backups from now on.",
        "To refuse plain files outright, run this script with --require-encrypted.",
        "",
      ].join("\n"),
    );
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
