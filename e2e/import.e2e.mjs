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
  const count = () =>
    withDb((db) =>
      db.query(
        "select count(*)::int n from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name in ('Zed''s, Pizza','Zeta Nails','Zulu Auto','Zero Phone Co')",
        [email],
      ),
    ).then((r) => r.rows[0].n);

  await page.goto(`${BASE}/import`, { waitUntil: "networkidle" });
  await page.setInputFiles("input[type=file]", file);
  await page.getByText("2. Check the columns").waitFor();
  check(
    "columns guessed from messy headers",
    (await sel("Business name").locator("option:checked").innerText()) === "Business Name" &&
      (await sel("Email").locator("option:checked").innerText()) === "E-mail" &&
      (await sel("Follow-up date").locator("option:checked").innerText()) === "Next Follow-Up",
  );
  const ready = await page.getByText(/ready to import/).innerText();
  check(
    "preview drops the repeated phone and the nameless row",
    ready.startsWith("4 ready"),
    ready,
  );

  await page.getByLabel("Where is this list from?").fill("E2E lead vendor");
  await page.getByRole("button", { name: /^Import 4 clients/ }).click();
  await page.waitForURL("**/clients", { timeout: 10000 });
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
  await page.getByRole("button", { name: /^Import 4 clients/ }).click();
  await page.getByText(/already in your CRM/).waitFor({ timeout: 8000 });
  check(
    "importing the same file again adds nothing",
    (await count()) === 4,
    `${await count()} clients`,
  );
  await browser.close();
}
