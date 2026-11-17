// Screenshots of every page at desktop and phone width, for the manual pass ("Both" checks in docs/TEST-PLAN-SELECTIVE.md).
// Not a suite file (run.mjs only picks *.e2e.mjs). Usage:
//   CHROMIUM_PATH=... [BASE_URL=http://localhost:3001] node e2e/shots.mjs <email> <outDir> [light|dark]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASE, openBrowser, withDb } from "./lib.mjs";

const [email, outDir, scheme = "dark"] = process.argv.slice(2);
if (!email || !outDir) {
  console.error("usage: node e2e/shots.mjs <email> <outDir> [light|dark]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// one merchant's page too: the first merchant this user owns
const merchant = await withDb((db) =>
  db
    .query(
      "select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 order by c.created_at, c.business_name limit 1",
      [email],
    )
    .then((r) => r.rows[0]),
);

const PAGES = [
  "/",
  "/lead-intake",
  "/follow-up",
  "/settings",
  "/settings/buckets",
  "/settings/sheets",
  "/settings/team",
  "/settings/email",
  "/settings/ai",
  "/today",
  "/clients",
  ...(merchant ? [`/clients/${merchant.id}`] : []),
  "/trash",
  "/import",
];
const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];

for (const [label, viewport] of VIEWPORTS) {
  const { browser, context, page } = await openBrowser(email, viewport, { colorScheme: scheme });
  // the app's mode comes from the "theme" cookie (light is the default), not from the device setting
  await context.addCookies([{ name: "theme", value: scheme, url: BASE }]);
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const name =
      path === "/"
        ? "dashboard"
        : path.startsWith("/clients/")
          ? "merchant"
          : path.slice(1).replace(/\//g, "-");
    await page.screenshot({ path: join(outDir, `${name}.${label}.png`), fullPage: true });
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    console.log(`${label} ${path} ${wide ? "HORIZONTAL SCROLL" : "ok"}`);
  }
  await browser.close();
}
