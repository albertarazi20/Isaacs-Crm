import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => relative(SRC, f).split(sep).join("/");

describe("architecture boundaries", () => {
  it("only api routes and src/lib/system may use the RLS-bypassing connection", () => {
    // The system jobs: each takes a DbAccess and is driven by a cron route or a public token route (upload links,
    // lender downloads). They run for the shop, not for a signed-in user, so they are the owner connection on purpose.
    const JOBS = new Set([
      "lib/buckets/engine.ts", // nightly sequence steps and blasts
      "lib/docs/upload.ts", // merchant uploads, lender downloads, the scan
      "lib/inbox/process.ts", // the lender-email reader
      "lib/inbox/sync.ts", // Gmail history sync
      "lib/money/winback.ts", // winback pools
      "lib/send/deliver.ts", // the Gmail / Resend sender
      "lib/send/worker.ts", // the outbox drain
      "lib/sheets/file.ts", // filing sheet rows as leads
      "lib/sheets/sync.ts", // the daily Google Sheets loop
    ]);
    const allowed = (r: string) =>
      r.startsWith("app/api/") ||
      r.startsWith("lib/system/") ||
      r.startsWith("lib/db/") ||
      JOBS.has(r);
    // withSystem, and the raw pool / client factories that give the same owner connection (review-3B B-16)
    const bypass = /withSystem|getPool|makeDb|new pg\.|new Pool\(/;
    const offenders = files
      .filter((f) => !allowed(rel(f)) && bypass.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it("no SQL is built from input: interpolated template literals in .query() are an allow-list of fixed fragments", () => {
    // Row-level security keys on a setting the app role can set, so one injected statement could read another user's
    // rows (review-3A A-17). Today every `${}` inside a query is a constant (a column list, a fixed function name,
    // a column map). A new one fails here until someone has checked it and added it below on purpose.
    const ALLOWED: Record<string, number> = {
      "lib/messaging/mutations.ts": 2, // ${COLUMNS}
      "lib/messaging/queries.ts": 2, // ${offerSql}
      "lib/data/mutations.ts": 2, // ${sets} from the CLIENT_COLUMNS map; ${fn} from a fixed list
      "lib/data/queries.ts": 1, // ${NAME_KEY_SQL("business_name")}
      "lib/buckets/queries.ts": 1, // ${TZ_LABEL}: a constant CASE expression (time-zone label), no input in it
    };
    const counts: Record<string, number> = {};
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let n = 0;
      for (const m of src.matchAll(/\.query(?:<[^>]*>)?\(\s*`([^`]*)`/g))
        if (m[1]?.includes("${")) n += 1;
      if (n > 0) counts[rel(f)] = n;
    }
    expect(counts).toEqual(ALLOWED);
  });
  it("never writes raw SQL against token or reminder tables outside src/lib/system", () => {
    const offenders = files
      .filter(
        (f) =>
          !rel(f).startsWith("lib/system/") &&
          // the refresh token (the secret) and the reminder ledger; the connection's address/status is not a secret
          // and the outbox worker reads those two columns to pick a sender
          /refresh_token_enc|reminders_sent/.test(readFileSync(f, "utf8")),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it("never disables a lint rule", () => {
    const offenders = [
      ...files,
      ...walk(join(process.cwd(), "tests")).filter((f) => f.endsWith(".ts")),
    ]
      .filter(
        (f) =>
          !f.endsWith("boundaries.test.ts") &&
          /eslint-disable|@ts-ignore|@ts-nocheck/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});

describe("production safety", () => {
  it("the connection pool handles idle-connection errors instead of crashing the process", () => {
    const src = readFileSync(join(SRC, "lib/db/index.ts"), "utf8");
    expect(src).toMatch(/pool\.on\(\s*"error"/);
  });
});
