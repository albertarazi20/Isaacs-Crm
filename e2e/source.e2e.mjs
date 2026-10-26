import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function sourceFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "+ Add client" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Business name *").fill("Source Test Diner");
  await dialog.getByLabel("Where they came from").fill("Lead vendor Oct");
  await dialog.getByRole("button", { name: "Add client", exact: true }).click();
  await page.getByText(/Added Source Test Diner/).waitFor({ timeout: 8000 });

  const row = await withDb((db) =>
    db
      .query(
        "select c.source from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Source Test Diner'",
        [email],
      )
      .then((r) => r.rows[0]),
  );
  check(
    "DB: the source typed in Add client is stored",
    row?.source === "Lead vendor Oct",
    JSON.stringify(row),
  );

  // The next add remembers it, so a batch from one list is one typing.
  await page.getByRole("button", { name: "+ Add client" }).click();
  const second = page.getByRole("dialog");
  check(
    "the next Add client is pre-filled with the last source",
    (await second.getByLabel("Where they came from").inputValue()) === "Lead vendor Oct",
  );
  await second
    .locator('datalist option[value="Lead vendor Oct"]')
    .waitFor({ state: "attached", timeout: 5000 })
    .catch(() => {});
  const options = await second
    .locator("datalist option")
    .evaluateAll((os) => os.map((o) => o.value));
  check(
    "suggestions include his own source and the starters, with no case-only duplicates",
    options.includes("Lead vendor Oct") &&
      options.includes("Referral") &&
      new Set(options.map((o) => o.toLowerCase())).size === options.length,
    options.join(" | "),
  );
  await second.getByRole("button", { name: "Cancel" }).click();

  // Edit details on the client page uses the same box.
  const id = await withDb((db) =>
    db
      .query(
        "select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Source Test Diner'",
        [email],
      )
      .then((r) => r.rows[0].id),
  );
  await page.goto(`${BASE}/clients/${id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Edit details" }).click();
  await page.getByRole("dialog").getByLabel("Source (who sent them)").fill("Referral");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 8000 });
  const after = await withDb((db) =>
    db.query("select source from clients where id = $1", [id]).then((r) => r.rows[0]),
  );
  check(
    "DB: the source edited on the client page is stored",
    after?.source === "Referral",
    JSON.stringify(after),
  );
  await browser.close();
}
