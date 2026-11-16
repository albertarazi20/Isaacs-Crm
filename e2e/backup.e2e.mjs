import { readFileSync } from "node:fs";
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

export default async function backupFlow({ email }) {
  await setRole(email, "manager"); // exports are manager-only and logged
  const { browser, page } = await openBrowser(
    email,
    { width: 1280, height: 900 },
    { acceptDownloads: true },
  );
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });

  const link = page.getByRole("link", { name: /Download a full backup/ });
  check("Settings offers a full backup download", await link.isVisible());

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    link.click(),
  ]);
  check(
    "the file is named isaac-backup-<date>.json",
    /^isaac-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()),
    download.suggestedFilename(),
  );
  const path = await download.path();
  const backup = JSON.parse(readFileSync(path, "utf8"));
  check("it is Isaac's backup, version 1", backup.app === "isaac" && backup.version === 1);

  const db = await withDb(async (c) => {
    const out = {};
    for (const t of Object.keys(backup.counts)) {
      out[t] = (
        await c.query(
          `select count(*)::int n from ${t} t join app_users u on u.id = t.user_id where u.email = $1`,
          [email],
        )
      ).rows[0].n;
    }
    return out;
  });
  const same = Object.keys(db).every(
    (t) => db[t] === backup.counts[t] && db[t] === backup.tables[t].length,
  );
  check(
    "DB: every table in the file has exactly the rows the database has for this user",
    same,
    JSON.stringify({ file: backup.counts, db }),
  );
  check(
    "it holds merchants, timers and notes",
    backup.counts.clients > 0 && backup.counts.timers > 0 && backup.counts.activities > 0,
    JSON.stringify(backup.counts),
  );

  const text = readFileSync(path, "utf8");
  check(
    "it holds no tokens, hashes or sessions",
    !/token_hash|refresh_token|session_epoch|isl_[A-Za-z0-9_-]{20}/.test(text),
  );
  check(
    "every row in it belongs to this user",
    backup.tables.clients.every((r) => r.user_id === backup.tables.clients[0].user_id),
  );

  const csv = await page.request.get(`${BASE}/api/export/clients`);
  check(
    "the merchants CSV link still works",
    csv.ok() && (csv.headers()["content-type"] ?? "").includes("text/csv"),
  );

  const anon = await fetch(`${BASE}/api/export/backup`, { redirect: "manual" });
  check(
    "signed out, the backup is refused",
    anon.status === 401 || anon.status === 307 || anon.status === 302 || anon.status === 308,
    String(anon.status),
  );

  await browser.close();
}
