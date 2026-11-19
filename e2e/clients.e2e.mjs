import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function clientsFlow({ email }) {
  const { browser, page } = await openBrowser(
    email,
    { width: 1400, height: 900 },
    { acceptDownloads: true },
  );
  const q = (sql, params = []) =>
    withDb((db) =>
      db
        .query(
          `select count(*)::int n from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and ${sql}`,
          [email, ...params],
        )
        .then((r) => r.rows[0].n),
    );
  // The line under the filter bar: "232 merchants" with nothing narrowing it, "12 of 232 merchants" otherwise.
  const shown = async () => {
    const t = await page.getByText(/^\d+( of \d+)? merchants?$/).innerText();
    return Number(t.split(" ")[0]);
  };
  const filters = page.getByRole("button", { name: /^Filters/ });
  const clear = page.getByRole("button", { name: "Clear filters" }).first();

  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  const total = await q("true");
  check("all clients are listed", (await shown()) === total, `shown ${await shown()} db ${total}`);

  // The stage groups are pills in the bar; the rest of the filters sit behind the Filters button.
  await page
    .getByRole("group", { name: "Filter by group" })
    .getByRole("button", { name: /^Not interested/ })
    .click();
  check(
    "a group pill agrees with the database",
    (await shown()) === (await q("c.stage = 'dead'")),
    `shown ${await shown()}`,
  );
  await page
    .getByRole("group", { name: "Filter by group" })
    .getByRole("button", { name: /^All/ })
    .click();

  await filters.click();

  await page.getByLabel("Stage", { exact: true }).selectOption("dead");
  check(
    "stage filter agrees with the database",
    (await shown()) === (await q("c.stage = 'dead'")),
    `shown ${await shown()}`,
  );
  // A filtered view lives in the address bar, so it can be bookmarked or sent.
  check(
    "the filter is written to the address bar",
    new URL(page.url()).searchParams.get("stage") === "dead",
    page.url(),
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "opening that address shows the same filtered list with the filters open",
    (await shown()) === (await q("c.stage = 'dead'")) &&
      (await page.getByLabel("Stage", { exact: true }).inputValue()) === "dead",
    `shown ${await shown()}`,
  );
  await clear.click();
  check(
    "clear filters brings everyone back",
    (await shown()) === total && new URL(page.url()).search === "",
    page.url(),
  );

  await page.getByLabel("Wants at least").selectOption({ label: "Wants $50k or more" });
  check(
    "'wants at least $50k' agrees with the database",
    (await shown()) === (await q("coalesce(c.wanted_amount_cents, 0) >= 5000000")),
    `shown ${await shown()}`,
  );
  await clear.click();

  await page.getByLabel("Not contacted in").selectOption("never");
  check(
    "'never contacted' agrees with the database",
    (await shown()) === (await q("c.last_touch_at is null")),
    `shown ${await shown()}`,
  );
  const label = (await filters.innerText()).replace(/\s+/g, " ").trim();
  check("the button says how many filters are on", /^Filters ?1$/.test(label), label);

  // Downloads are for managers (and go through the audited server export: tests/export-clients-filtered.test.ts): a
  // rep sees no download button at all, however the list is filtered.
  check(
    "a rep sees no download button",
    (await page.getByRole("button", { name: /^Download these/ }).count()) === 0,
  );

  await page.getByLabel("Not contacted in").selectOption("any");
  await page.getByPlaceholder(/Search name/).fill("zzzz-no-such-merchant");
  check("a search with no matches says so", await page.getByText("No matches").isVisible());

  // Most active: the merchant's own last move first (the page error check above fails if the sort throws)
  await page.getByPlaceholder(/Search name/).fill("");
  await page.getByLabel("Sort by").selectOption("active");
  check(
    "Most active sorts the list without an error",
    (await page.getByLabel("Sort by").inputValue()) === "active" &&
      (await page.locator('[role="table"][aria-label="Merchants"] [role="row"]').count()) > 1,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByPlaceholder(/Search name/).fill("");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check("no sideways page scroll at 390px with the filters open", !overflow);
  await page.screenshot({
    path: `${process.env.E2E_SHOTS ?? "/tmp"}/clients-filters-390.png`,
    fullPage: true,
  });
  await browser.close();
}
