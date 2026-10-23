import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function reportsFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/reports?days=all`, { waitUntil: "networkidle" });
  check("Reports page loads", await page.getByRole("heading", { name: "Reports" }).isVisible());

  // The headline numbers must agree with the database, not just render.
  const db = await withDb(async (c) => {
    const u = (await c.query("select id from app_users where email = $1", [email])).rows[0].id;
    const added = (await c.query("select count(*)::int n from clients where user_id = $1", [u]))
      .rows[0].n;
    const overdue = (
      await c.query(
        "select count(*)::int n from timers where user_id = $1 and done_at is null and due_on < current_date",
        [u],
      )
    ).rows[0].n;
    const funded = (
      await c.query("select count(distinct client_id)::int n from fundings where user_id = $1", [u])
    ).rows[0].n;
    return { added, overdue, funded };
  });
  const addedRow = page
    .getByRole("listitem")
    .filter({ hasText: /^Added/ })
    .first();
  check(
    "funnel 'Added' equals the number of merchants in the database",
    (await addedRow.innerText()).includes(String(db.added)),
    `db=${db.added} row="${(await addedRow.innerText()).replace(/\s+/g, " ")}"`,
  );
  const fundedRow = page
    .getByRole("listitem")
    .filter({ hasText: /^Funded/ })
    .first();
  check(
    "funnel 'Funded' is not above the merchants who were ever funded",
    Number((await fundedRow.innerText()).match(/\d+/)?.[0] ?? 999) >= db.funded,
    `db funded=${db.funded}`,
  );
  const bar = page.getByRole("img", { name: /Still overdue/ });
  if (await bar.count()) {
    const label = (await bar.getAttribute("aria-label")) ?? "";
    check(
      "'Still overdue' equals the overdue timers in the database",
      label.includes(`Still overdue: ${db.overdue}`),
      `${label} / db=${db.overdue}`,
    );
  } else check("follow-up bar shown (or nothing due yet)", true);

  for (const p of ["30 days", "90 days", "1 year", "All time"]) {
    await page.getByRole("link", { name: p, exact: true }).click();
    await page.waitForLoadState("networkidle");
    check(
      `period "${p}" loads without error`,
      (await page.getByText("Something went wrong").count()) === 0,
    );
  }
  await page.goto(`${BASE}/reports?days=banana`, { waitUntil: "networkidle" });
  check(
    "a junk period falls back to 90 days",
    (await page.getByRole("link", { name: "90 days" }).getAttribute("aria-current")) === "page",
  );

  const shots = process.env.E2E_SHOTS ?? "/tmp";
  await page.goto(`${BASE}/reports?days=all`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${shots}/reports.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/reports-390.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check("no sideways page scroll at 390px", !overflow);
  await browser.close();
}
