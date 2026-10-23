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
    const allowed = (r: string) =>
      r.startsWith("app/api/") || r.startsWith("lib/system/") || r.startsWith("lib/db/");
    const offenders = files
      .filter((f) => !allowed(rel(f)) && readFileSync(f, "utf8").includes("withSystem"))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it("never writes raw SQL against token or reminder tables outside src/lib/system", () => {
    const offenders = files
      .filter(
        (f) =>
          !rel(f).startsWith("lib/system/") &&
          /gmail_connections|reminders_sent/.test(readFileSync(f, "utf8")),
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
