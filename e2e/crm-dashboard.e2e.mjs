// Dashboard: the month's new leads and applications in, the do-this-now list, the team table and the follow-ups
// button. Run: pnpm e2e crm-dashboard
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function dashboardFlow({ email }) {
  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  check(
    "Dashboard heading",
    await page.getByRole("heading", { name: "Dashboard", exact: true }).isVisible(),
  );
  const nav = await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link")
    .allInnerTexts();
  check(
    "the main nav is Dashboard, Lead Intake, Follow Up, Merchants, Settings",
    JSON.stringify(nav.map((x) => x.replace(/\d+/g, "").trim())) ===
      JSON.stringify(["Dashboard", "Lead Intake", "Follow Up", "Merchants", "Settings"]),
    JSON.stringify(nav),
  );
  check(
    "the month scoreboard shows New leads and Applications in",
    (await page.locator("main").getByText("New leads", { exact: true }).first().isVisible()) &&
      (await page
        .locator("main")
        .getByText("Applications in", { exact: true })
        .first()
        .isVisible()),
  );
  const counts = await withDb((db) =>
    one(
      db,
      `select (select count(*)::int from clients c where to_char(c.created_at, 'YYYY-MM') = to_char(current_date, 'YYYY-MM')
                 and not exists (select 1 from trashed_clients t where t.client_id = c.id)
                 and c.user_id = (select id from app_users where email = $1)) as leads`,
      [email],
    ),
  );
  check(
    "New leads counts this rep's merchants added this month (the manager's own book is part of the shop's)",
    counts.leads > 0 &&
      Number(
        (
          await page
            .locator("main")
            .getByText("New leads", { exact: true })
            .first()
            .locator("xpath=following-sibling::p[1]")
            .innerText()
        ).trim(),
      ) >= counts.leads,
    JSON.stringify(counts),
  );
  check("do-this-now section", await page.getByText("Do this now").isVisible());
  check(
    "team table for a manager",
    await page.getByText("Team", { exact: true }).first().isVisible(),
  );
  const body = await page.locator("main").innerText();
  check(
    "nothing about the removed money, lender or funnel blocks is left on the Dashboard",
    !/funnel|money on the table|lender|commission|funded|goal/i.test(body),
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
  await browser.close();
}
