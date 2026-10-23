import { readFileSync } from "node:fs";
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
  const shown = async () => {
    const t = await page.getByText(/^\d+ of \d+$/).innerText();
    return Number(t.split(" of ")[0]);
  };

  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });
  const total = await q("true");
  check("all clients are listed", (await shown()) === total, `shown ${await shown()} db ${total}`);

  await page.getByRole("button", { name: /^More filters/ }).click();

  await page.getByLabel("Stage", { exact: true }).selectOption("dead");
  check(
    "stage filter agrees with the database",
    (await shown()) === (await q("c.stage = 'dead'")),
    `shown ${await shown()}`,
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  check("clear filters brings everyone back", (await shown()) === total);

  await page.getByLabel("Wants at least").selectOption({ label: "Wants $50k or more" });
  check(
    "'wants at least $50k' agrees with the database",
    (await shown()) === (await q("coalesce(c.wanted_amount_cents, 0) >= 5000000")),
    `shown ${await shown()}`,
  );
  await page.getByRole("button", { name: "Clear filters" }).click();

  await page.getByLabel("Not contacted in").selectOption("never");
  check(
    "'never contacted' agrees with the database",
    (await shown()) === (await q("c.last_touch_at is null")),
    `shown ${await shown()}`,
  );
  const label = await page.getByRole("button", { name: /^More filters/ }).innerText();
  check("the button says how many filters are on", /\(1\)/.test(label), label);

  // The download is exactly what is on screen.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /^Download these/ }).click(),
  ]);
  const text = readFileSync(await download.path(), "utf8");
  const lines = text.replace(/^﻿/, "").trim().split(/\r\n/);
  check(
    "the downloaded CSV has a header and one row per client on screen",
    lines.length - 1 === (await shown()) && lines[0].startsWith("Business,"),
    `${lines.length - 1} rows`,
  );
  check(
    "the download is named for the day",
    /isaac-clients-filtered-\d{4}-\d{2}-\d{2}\.csv/.test(download.suggestedFilename()),
  );

  await page.getByLabel("Not contacted in").selectOption("any");
  await page.getByPlaceholder(/Search name/).fill("zzzz-no-such-merchant");
  check("a search with no matches says so", await page.getByText("No matches").isVisible());

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
