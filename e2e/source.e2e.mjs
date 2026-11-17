import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function sourceFlow({ email }) {
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/clients`, { waitUntil: "networkidle" });

  // Adding a merchant is the New lead sheet now (the quick "+ Add client" dialog is gone). The sheet has no source
  // box: a lead typed in by hand is filed under the sheet's own source, and who sent them is set on the merchant.
  await page
    .getByRole("main")
    .getByRole("button", { name: /^New lead/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "Bring a merchant in" });
  await sheet.getByLabel("Phone", { exact: true }).fill("(305) 555-0861");
  await sheet.getByLabel("Business", { exact: true }).fill("Source Test Diner");
  await sheet.getByRole("button", { name: /^(Submit to|Add lead)/ }).click();
  await sheet.getByText("Source Test Diner is in").waitFor({ timeout: 12000 });

  const stored = () =>
    withDb((db) =>
      db
        .query(
          "select c.id, c.source from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Source Test Diner'",
          [email],
        )
        .then((r) => r.rows[0]),
    );
  const row = await stored();
  check(
    "DB: a lead added in the New lead sheet is stored with the sheet's source",
    row?.source === "Lead intake",
    JSON.stringify(row),
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden", timeout: 5000 });

  // The source box lives in Edit details on the merchant's page.
  const edit = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Edit details" }) });
  const source = edit.getByLabel("Source (who sent them)");
  await page.goto(`${BASE}/clients/${row.id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Edit details" }).click();
  check(
    "Edit details opens with the source the merchant came in with",
    (await source.inputValue()) === "Lead intake",
    await source.inputValue(),
  );
  await source.fill("Lead vendor Oct");
  await edit.getByRole("button", { name: "Save" }).click();
  await edit.waitFor({ state: "hidden", timeout: 8000 });
  const typed = await stored();
  check(
    "DB: the source typed in Edit details is stored",
    typed?.source === "Lead vendor Oct",
    JSON.stringify(typed),
  );

  // The box suggests the sources already in use, so one list stays one source.
  await page.getByRole("button", { name: "Edit details" }).click();
  await edit
    .locator('datalist option[value="Lead vendor Oct"]')
    .waitFor({ state: "attached", timeout: 5000 })
    .catch(() => {});
  const options = await edit.locator("datalist option").evaluateAll((os) => os.map((o) => o.value));
  check(
    "suggestions include his own source and the starters, with no case-only duplicates",
    options.includes("Lead vendor Oct") &&
      options.includes("Referral") &&
      new Set(options.map((o) => o.toLowerCase())).size === options.length,
    options.join(" | "),
  );

  await source.fill("Referral");
  await edit.getByRole("button", { name: "Save" }).click();
  await edit.waitFor({ state: "hidden", timeout: 8000 });
  const after = await stored();
  check(
    "DB: the source edited on the client page is stored",
    after?.source === "Referral",
    JSON.stringify(after),
  );
  await browser.close();
}
