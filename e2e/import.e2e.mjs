import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const CSV = `Business Name,Owner,Cell Phone,E-mail,Amount Wanted,Status,Next Follow-Up,Last Call Notes
"Zed's, Pizza",Mike Ross,(305) 555-7001,mike@pizza.com,50k,Interested,,"Wants it for payroll, call back"
Zeta Nails,Linh Tran,305-555-7002,,$30k,Declined,3/9/2027,
Zulu Auto,Tony,305-555-7003,,,Funded,,
Dupe Of Zed,Mike,(305) 555-7001,,,,,
,NoBiz,305-555-7004,,,,,
Zero Phone Co,Sam,555-12,,lots,Dead,,
`;

export default async function importFlow({ email }) {
  const file = join(tmpdir(), `isaac-e2e-${Date.now()}.csv`);
  writeFileSync(file, CSV);
  const { browser, page } = await openBrowser(email, { width: 1300, height: 1000 });
  const sel = (label) =>
    page.locator("label", { has: page.locator(`span:text-is("${label}")`) }).locator("select");
  // One number in a summary row (step 3's preview, step 4's result): the figure under its label.
  const figure = async (label) =>
    Number(
      await page
        .locator("p.eyebrow", { hasText: new RegExp(`^${label}$`) })
        .locator("xpath=following-sibling::p")
        .textContent(),
    );
  const stepNow = async () =>
    (await page.locator('ol[aria-label="Import steps"] [aria-current="step"]').innerText())
      .replace(/\s+/g, " ")
      .trim();
  const count = () =>
    withDb((db) =>
      db.query(
        "select count(*)::int n from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name in ('Zed''s, Pizza','Zeta Nails','Zulu Auto','Zero Phone Co')",
        [email],
      ),
    ).then((r) => r.rows[0].n);

  await page.goto(`${BASE}/import`, { waitUntil: "networkidle" });
  check("the wizard opens on step 1, Upload", /^1 Upload/.test(await stepNow()), await stepNow());
  // A chosen file is read at once and the wizard moves on to the column check.
  await page.setInputFiles("input[type=file]", file);
  await page.getByRole("heading", { name: "Check the columns" }).waitFor();
  check(
    "a chosen file jumps to step 2, Match columns",
    /^2 Match columns/.test(await stepNow()),
    await stepNow(),
  );
  check(
    "columns guessed from messy headers",
    (await sel("Business name").locator("option:checked").innerText()) === "Business Name" &&
      (await sel("Email").locator("option:checked").innerText()) === "E-mail" &&
      (await sel("Follow-up date").locator("option:checked").innerText()) === "Next Follow-Up",
  );
  await page.getByLabel("Where is this list from?").fill("E2E lead vendor");
  await page.getByRole("button", { name: /^Review 4 rows/ }).click();
  await page.getByRole("heading", { name: "Review and import" }).waitFor();
  const preview = {
    ready: await figure("Ready to import"),
    repeated: await figure("Repeated phones"),
    look: await figure("To look at"),
  };
  await page.getByText(/^Things to look at/).click();
  const problems = await page.locator("details ul li").allInnerTexts();
  check(
    "preview drops the repeated phone and the nameless row",
    preview.ready === 4 &&
      preview.repeated === 1 &&
      problems.some((p) => p.startsWith("Line 6:")) &&
      (await page.locator("tbody tr").count()) === 4,
    `${JSON.stringify(preview)} ${problems.join(" | ")}`,
  );

  await page.getByRole("button", { name: /^Import 4 clients/ }).click();
  // A finished import stays on the page and says what happened; it no longer jumps to the list.
  await page.getByRole("heading", { name: "Import finished" }).waitFor({ timeout: 15000 });
  check(
    "the result panel says four were imported and none failed",
    (await figure("Imported")) === 4 &&
      (await figure("Already in your CRM")) === 0 &&
      (await figure("Failed")) === 0 &&
      /\/import$/.test(page.url()),
    page.url(),
  );
  const rows = await withDb((db) =>
    db.query(
      "select c.business_name, c.stage, c.phone, (c.next_due_on - current_date)::int d from client_cards c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name in ('Zed''s, Pizza','Zeta Nails','Zulu Auto','Zero Phone Co') order by 1",
      [email],
    ),
  ).then((r) => r.rows);
  check(
    "four clients created",
    rows.length === 4,
    rows.map((r) => `${r.business_name}:${r.stage}`).join(", "),
  );
  const sources = await withDb((db) =>
    db.query(
      "select distinct c.source from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name in ('Zed''s, Pizza','Zeta Nails','Zulu Auto','Zero Phone Co')",
      [email],
    ),
  ).then((r) => r.rows.map((x) => x.source));
  check(
    "the list name typed in the wizard is stored as every merchant's source",
    sources.length === 1 && sources[0] === "E2E lead vendor",
    JSON.stringify(sources),
  );
  check(
    "a status about a file worked elsewhere (Funded) came in as Name in with a note, not as a stage",
    rows.find((r) => r.business_name === "Zulu Auto")?.stage === "name_in",
  );
  check(
    "a sheet's follow-up date is kept, and Declined lands in Trash",
    rows.find((r) => r.business_name === "Zeta Nails")?.stage === "dead" &&
      rows.find((r) => r.business_name === "Zeta Nails")?.d > 100,
    JSON.stringify(rows.find((r) => r.business_name === "Zeta Nails")),
  );
  const notes = await withDb((db) =>
    db.query(
      "select c.business_name, a.body from activities a join clients c on c.id = a.client_id join app_users u on u.id = c.user_id where u.email = $1 and a.kind = 'note'",
      [email],
    ),
  ).then((r) => r.rows);
  check(
    "notes and the 'Imported status' note are saved",
    notes.some((n) => n.body.includes("Wants it for payroll")) &&
      notes.some((n) => n.body === "Imported status: Funded"),
  );

  await page.goto(`${BASE}/import`, { waitUntil: "networkidle" });
  await page.setInputFiles("input[type=file]", file);
  await page.getByRole("button", { name: /^Review 4 rows/ }).click();
  await page.getByRole("button", { name: /^Import 4 clients/ }).click();
  await page.getByRole("heading", { name: "Import finished" }).waitFor({ timeout: 15000 });
  const again = {
    imported: await figure("Imported"),
    already: await figure("Already in your CRM"),
  };
  check(
    "importing the same file again adds nothing",
    (await count()) === 4 && again.imported === 0 && again.already === 4,
    `${await count()} clients ${JSON.stringify(again)}`,
  );
  await page.getByRole("link", { name: /^View merchants/ }).click();
  await page.waitForURL("**/clients", { timeout: 10000 });
  check("View merchants opens the list", /\/clients$/.test(page.url()), page.url());
  await browser.close();
}
