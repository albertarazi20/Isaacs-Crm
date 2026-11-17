import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import pg from "pg";

export const BASE = process.env.BASE_URL ?? "http://localhost:3000";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres@localhost:5433/isaac_dev";

const results = [];
export const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
};
export const summary = () => ({
  passed: results.filter((r) => r.ok).length,
  total: results.length,
});

/** Runs SQL against the dev database. Dates come back as strings, bigints as numbers. */
export async function withDb(fn) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  pg.types.setTypeParser(1082, (v) => v);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A throwaway user with the seeded merchants (scripts/seed-dev.ts), so a run never touches real data and RLS keeps runs apart. */
export async function makeUser(label) {
  const email = `e2e-${label}-${Date.now()}@example.com`;
  const seed = spawnSync("pnpm", ["-s", "db:seed", email], {
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);
  return email;
}

/** The seeded user is a rep; a flow that needs a manager says so before opening the browser. */
export async function setRole(email, role) {
  await withDb((db) => db.query("update app_users set role = $2 where email = $1", [email, role]));
}

export async function dropUser(email) {
  await withDb((db) => db.query("delete from app_users where email = $1", [email]));
}

export async function openBrowser(email, viewport = { width: 1440, height: 900 }, extra = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport, ...extra });
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    // React 19.2's development-only performance tracks throw this from the browser whenever a server page calls
    // notFound() (the merchant page does it on main too). It is not in a production build and says nothing about
    // the app, so it is the one message this check does not count; every other page error still fails it.
    if (/Failed to execute 'measure' on 'Performance'.*negative time stamp/.test(e.message)) return;
    check("no uncaught page errors", false, e.message);
  });
  await page.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  return { browser, context, page };
}
