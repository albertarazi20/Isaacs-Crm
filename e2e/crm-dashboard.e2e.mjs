// Dashboard: the month scoreboard, the do-this-now list and a goal that really lands in the database. Run: pnpm e2e crm-dashboard
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function dashboardFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "Dashboard heading",
    await page.getByRole("heading", { name: "Dashboard", exact: true }).isVisible(),
  );
  check(
    "month scoreboard shows Funded",
    await page.locator("main").getByText("Funded", { exact: true }).first().isVisible(),
  );
  check("do-this-now section", await page.getByText("Do this now").isVisible());
  check("funnel block", await page.getByText("Funnel", { exact: true }).isVisible());
  check(
    "team table for a manager",
    await page.getByText("Team", { exact: true }).first().isVisible(),
  );

  // set the shop goal: the pace bar must read it back and the row must exist in the database
  await page.getByRole("button", { name: /Set a shop goal|Goal .* edit/ }).click();
  await page.getByPlaceholder("250k").fill("300k");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText(/Goal saved/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(800);
  const goal = await withDb((db) =>
    one(
      db,
      "select funded_cents from goals where user_id is null and month = date_trunc('month', current_date)::date",
      [],
    ),
  );
  check(
    "the shop goal is in the database",
    Number(goal?.funded_cents) === 30_000_000,
    JSON.stringify(goal),
  );
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "the pace bar shows the goal",
    (await page.locator("main").innerText()).includes("of $300k"),
  );

  // the follow-ups button goes to the calls page
  const due = page
    .locator("main")
    .getByRole("link", { name: /follow-ups? due/ })
    .first();
  if (await due.isVisible()) {
    await due.click();
    await page.waitForURL(/\/today/);
    check("follow-ups due opens Today's calls", page.url().endsWith("/today"));
  }
  await withDb((db) =>
    db.query(
      "update goals set funded_cents = 0 where user_id is null and month = date_trunc('month', current_date)::date",
    ),
  );
  await browser.close();
}
