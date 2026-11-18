// Local security scan. Run by the developer before a release (`pnpm security`); it is NOT part of CI.
//   1. pnpm audit --prod                      known advisories in the production dependencies
//   2. every git-tracked file                 likely secrets (rules in scripts/lib/secretScan.mjs)
//   3. tracked .env files                     only .env.example may be in git
//   4. src/ files                             no plain http:// URL except localhost and the allowlisted
// Exceptions live in scripts/security-allowlist.json, each with a reason. Exit code 1 on any failure.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findHttpUrls,
  httpAllowed,
  isBackupFile,
  isForbiddenEnvFile,
  parseAllowlist,
  redactUrl,
  scanText,
  secretAllowed,
  summariseAudit,
} from "./lib/secretScan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = join(root, "scripts", "security-allowlist.json");

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const notes = [];
const section = (/** @type {string} */ title) => console.log(`\n== ${title}`);
const fail = (/** @type {string} */ check, /** @type {string[]} */ lines) => {
  failures.push(check);
  console.log(`FAIL  ${check}`);
  for (const l of lines) console.log(`      ${l}`);
};
const pass = (/** @type {string} */ check, /** @type {string} */ detail = "") =>
  console.log(`PASS  ${check}${detail ? ` (${detail})` : ""}`);

const allow = parseAllowlist(JSON.parse(readFileSync(allowPath, "utf8")));

// ---- 1. dependency audit ------------------------------------------------------------------------------------------
section("Dependency audit (pnpm audit --prod)");
{
  const run = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    if (run.error) throw run.error;
    const { advisories, ignored, total } = summariseAudit(run.stdout, allow.advisories);
    if (ignored > 0)
      notes.push(`${ignored} audit advisor${ignored === 1 ? "y" : "ies"} allowlisted`);
    if (advisories.length === 0)
      pass(
        "no known advisories in production dependencies",
        `${total} found, ${ignored} allowlisted`,
      );
    else
      fail(
        `${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} in production dependencies`,
        advisories.flatMap((a) => [
          `[${a.severity}] ${a.name}: ${a.title} (${a.id || "no id"})`,
          `  vulnerable ${a.vulnerable || "?"}, fixed in ${a.patched || "no fix yet"}  ${a.url}`,
        ]),
      );
  } catch (e) {
    // an audit that could not run is not a pass: say so, with the first line of why (never the whole payload)
    const why = String(run.stderr || (e instanceof Error ? e.message : e)).split("\n")[0];
    fail("the dependency audit could not run (needs network access and pnpm on PATH)", [why ?? ""]);
  }
}

// ---- tracked files ------------------------------------------------------------------------------------------------
const ls = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (ls.status !== 0) {
  console.error("git ls-files failed: run this inside the repository");
  process.exit(2);
}
const tracked = ls.stdout.split("\0").filter(Boolean);
const used = { secrets: new Set(), http: new Set() };

// ---- 3. .env files and downloaded backups -------------------------------------------------------------------------
section("Tracked files that must not be in git");
{
  const env = tracked.filter(isForbiddenEnvFile);
  const backups = tracked.filter(isBackupFile);
  if (env.length === 0) pass("no .env file is tracked (only .env.example is allowed)");
  else
    fail(
      "a .env file is tracked",
      env.map((f) => `${f}  (git rm --cached it, and rotate what it held)`),
    );
  if (backups.length === 0) pass("no downloaded backup (isaac-backup-*.json) is tracked");
  else fail("a downloaded backup is tracked (customer data)", backups);
}

// ---- 2 and 4. contents --------------------------------------------------------------------------------------------
/** @type {string[]} */
const secretLines = [];
/** @type {string[]} */
const httpLines = [];
let scanned = 0;
let skipped = 0;
for (const path of tracked) {
  const full = join(root, path);
  if (!existsSync(full)) continue; // tracked but deleted in the working tree
  const buf = readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) {
    skipped += 1; // binary: an image or a font
    continue;
  }
  scanned += 1;
  const text = buf.toString("utf8");
  for (const f of scanText(text)) {
    const entry = allow.secrets.find((a) => secretAllowed(a, path, f));
    if (entry) used.secrets.add(entry);
    else secretLines.push(`${path}:${f.line}  ${f.rule}  ${f.preview}`);
  }
  if (path.startsWith("src/"))
    for (const h of findHttpUrls(text)) {
      const entry = allow.http.find((a) => httpAllowed(a, path, h.url));
      if (entry) used.http.add(entry);
      else httpLines.push(`${path}:${h.line}  ${redactUrl(h.url)}`);
    }
}

section(`Secrets (${scanned} tracked text files scanned, ${skipped} binary skipped)`);
if (secretLines.length === 0) pass("no likely secrets found");
else
  fail(`${secretLines.length} likely secret${secretLines.length === 1 ? "" : "s"} found`, [
    ...secretLines,
    "(values are never printed; if one is a harmless fixture, add it to scripts/security-allowlist.json with a reason)",
  ]);

section("Plain http:// URLs in src/");
if (httpLines.length === 0) pass("no http:// URL except localhost and the allowlisted");
else
  fail(`${httpLines.length} http:// URL${httpLines.length === 1 ? "" : "s"} in src/`, [
    ...httpLines,
    "(use https, or allowlist it in scripts/security-allowlist.json with a reason)",
  ]);

for (const [kind, list] of /** @type {const} */ ([
  ["secrets", allow.secrets],
  ["http", allow.http],
])) {
  const unused = list.filter((e) => !used[kind].has(e));
  for (const e of unused)
    notes.push(`allowlist ${kind} entry for ${e.path} matched nothing: remove it if it is stale`);
}

// ---- summary ------------------------------------------------------------------------------------------------------
section("Summary");
for (const n of notes) console.log(`note  ${n}`);
if (failures.length === 0) {
  console.log("PASS  security scan: every check passed");
} else {
  console.log(
    `FAIL  security scan: ${failures.length} check${failures.length === 1 ? "" : "s"} failed`,
  );
  for (const f of failures) console.log(`      - ${f}`);
  process.exitCode = 1;
}
