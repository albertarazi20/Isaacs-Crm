// Screenshots of every page at desktop and phone width, for the manual pass ("Both" checks in docs/TEST-PLAN-SELECTIVE.md).
// Not a suite file (run.mjs only picks *.e2e.mjs). Usage:
//   CHROMIUM_PATH=... [BASE_URL=http://localhost:3001] node e2e/shots.mjs <email> <outDir> [light|dark]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASE, openBrowser } from "./lib.mjs";

const [email, outDir, scheme = "dark"] = process.argv.slice(2);
if (!email || !outDir) {
  console.error("usage: node e2e/shots.mjs <email> <outDir> [light|dark]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const PAGES = [
  "/",
  "/lead-intake",
  "/follow-up",
  "/board",
  "/deals",
  "/winback",
  "/funded",
  "/settings",
  "/settings/buckets",
  "/settings/sheets",
  "/settings/team",
  "/settings/email",
  "/settings/plan",
  "/settings/ai",
  "/settings/lenders",
  "/funders",
  "/today",
  "/clients",
  "/trash",
  "/import",
];
const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];

for (const [label, viewport] of VIEWPORTS) {
  const { browser, page } = await openBrowser(email, viewport, { colorScheme: scheme });
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const name = path === "/" ? "dashboard" : path.slice(1).replace(/\//g, "-");
    await page.screenshot({ path: join(outDir, `${name}.${label}.png`), fullPage: true });
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    console.log(`${label} ${path} ${wide ? "HORIZONTAL SCROLL" : "ok"}`);
  }
  await browser.close();
}
