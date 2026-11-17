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
    // the application page). They run for the shop, not for a signed-in user, so they are the owner connection on purpose.
    const JOBS = new Set([
      "lib/buckets/engine.ts", // nightly sequence steps and blasts
      "lib/docs/upload.ts", // merchant uploads, the scan
      "lib/docs/apply.ts", // the merchant signs their application with no login: the token is the key (0530)
      "lib/inbox/sync.ts", // Gmail history sync: merchant replies
      "lib/send/deliver.ts", // the Gmail / Resend sender
      "lib/send/external.ts", // stream 1: Sent mail outside the CRM, counted toward the cap
      "lib/send/worker.ts", // the outbox drain
      "lib/messaging/replyTags.ts", // stream 1: the merchant reply classifier
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
  it("client components never value-import a module that reaches Node, pg or next/headers (the server side)", () => {
    // Turbopack refuses `node:fs/promises` in a browser chunk and the whole route dies with a 500 (pass 2: the
    // Documents panel once imported two constants from a module that imports the upload module). A "use server"
    // file is a boundary and is fine to import; everything else a client file imports must be browser-safe, transitively.
    const byPath = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
    const directive = (src: string, d: string) =>
      new RegExp(`^\\s*["']${d}["'];`, "m").test(src.slice(0, 200));
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/")
        ? join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? join(from, "..", spec)
          : null;
      if (!base) return null;
      for (const c of [base + ".ts", base + ".tsx", join(base, "index.ts")])
        if (byPath.has(c)) return c;
      return null;
    };
    const valueImports = (src: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
        if (m[1]) continue; // import type … from
        const names = m[2] ?? "";
        // `import { type A, type B } from` is types only
        const inner = /^\{([^}]*)\}$/.exec(names.trim());
        if (
          inner &&
          inner[1]!.split(",").every((s) => s.trim() === "" || s.trim().startsWith("type "))
        )
          continue;
        out.push(m[3]!);
      }
      return out;
    };
    const SERVER = /^(node:|pg$|next\/headers$|next\/cache$|server-only$)/;
    const memo = new Map<string, string | null>();
    // the first server-only reason reachable from a module, or null when it is browser-safe
    const serverReason = (f: string, trail: string[] = []): string | null => {
      if (memo.has(f)) return memo.get(f)!;
      memo.set(f, null); // cycles are browser-safe until proven otherwise
      const src = byPath.get(f)!;
      let reason: string | null = null;
      if (!directive(src, "use server") && !directive(src, "use client")) {
        for (const spec of valueImports(src)) {
          if (SERVER.test(spec)) {
            reason = `${rel(f)} imports ${spec}`;
            break;
          }
          const target = resolve(f, spec);
          if (!target || directive(byPath.get(target)!, "use server")) continue;
          const r = serverReason(target, [...trail, rel(f)]);
          if (r) {
            reason = `${rel(f)} → ${r}`;
            break;
          }
        }
      }
      memo.set(f, reason);
      return reason;
    };
    const offenders: string[] = [];
    for (const f of files) {
      const src = byPath.get(f)!;
      if (!directive(src, "use client")) continue;
      for (const spec of valueImports(src)) {
        if (SERVER.test(spec)) offenders.push(`${rel(f)} imports ${spec}`);
        const target = resolve(f, spec);
        if (!target || directive(byPath.get(target)!, "use server")) continue;
        const r = serverReason(target);
        if (r) offenders.push(`${rel(f)} → ${r}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("no SQL is built from input: interpolated template literals in .query() are an allow-list of fixed fragments", () => {
    // Row-level security keys on a setting the app role can set, so one injected statement could read another user's
    // rows (review-3A A-17). Today every `${}` inside a query is a constant (a column list, a fixed function name,
    // a column map). A new one fails here until someone has checked it and added it below on purpose.
    const ALLOWED: Record<string, number> = {
      "lib/messaging/mutations.ts": 2, // ${COLUMNS}
      "lib/data/mutations.ts": 2, // ${sets} from the CLIENT_COLUMNS map; ${fn} from a fixed list
      "lib/data/queries.ts": 1, // ${NAME_KEY_SQL("business_name")}
      "lib/approvals/queries.ts": 2, // ${SELECT} (one fixed column list); ${order} from a fixed three-way choice
      // ${TZ_LABEL}: a constant CASE expression (time-zone label); stream 1 adds ${SENDS_SQL} / ${TOTALS_SQL}, the
      // fixed fragments the template and bucket scores are counted with (the window is a bound parameter)
      "lib/buckets/queries.ts": 3,
      // ${PENDING_ROW_COLUMNS}: the fixed column list a sheet row is read with before it is filed as a merchant —
      // the daily loop's read, and loadPendingRow (stream 1), which the form and the actions call
      "lib/sheets/file.ts": 2,
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
  it("a server file never uses a plain function or value exported from a 'use client' module", () => {
    // On the server such an export is a client reference: calling it throws ("Attempted to call X() from the
    // server") and the page shows the error screen. Only components (Capitalised) and hooks may cross. A helper both
    // sides need lives in a module without "use client" (the assistant's briefs: src/lib/assistant/prompts.ts).
    const isClient = (src: string) => /^\s*["']use client["']/.test(src);
    const plainExports = new Map<string, string[]>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!isClient(src)) continue;
      const names = [
        ...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm),
      ]
        .map((m) => m[1]!)
        .filter((n) => !/^[A-Z][a-z]/.test(n) && !/^use[A-Z]/.test(n));
      if (names.length) plainExports.set("@/" + rel(f).replace(/\.(ts|tsx)$/, ""), names);
    }
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (isClient(src)) continue;
      for (const m of src.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
        const names = plainExports.get(m[2]!);
        if (!names) continue;
        const used = m[1]!
          .split(",")
          .map(
            (x) =>
              x
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/)[0]!,
          )
          .filter((x) => names.includes(x));
        for (const n of used) bad.push(`${rel(f)} imports ${n} from ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
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
