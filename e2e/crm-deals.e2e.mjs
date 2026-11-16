// My Deals and the deal page: a note that saves, the tabs, and FUND end to end (a manager confirms in the same click),
// then the Funded sheet. Run: pnpm e2e crm-deals
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

export default async function dealsFlow({ email }) {
  const userId = await withDb((db) =>
    one(db, "select id from app_users where email = $1", [email]),
  ).then((r) => r.id);
  // a seeded merchant becomes a deal the way a rep does it
  const client = await withDb((db) =>
    one(
      db,
      "select id, business_name from clients where user_id = $1 and stage in ('application_in', 'stips', 'interested', 'name_in') order by business_name limit 1",
      [userId],
    ),
  );
  await withDb(async (db) => {
    await db.query("select set_config('app.user_id', $1, false)", [userId]);
    await db.query("select submit_to_ops($1, 'new', 5000000, 'equipment')", [client.id]);
  });
  const lender = await withDb((db) =>
    one(
      db,
      "insert into funders (user_id, name, submission_email, commission_points) values ($1, 'E2E Lender', 'subs@e2e-lender.test', 6) returning id",
      [userId],
    ),
  );

  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/deals`, { waitUntil: "networkidle" });
  check("Deals heading", await page.getByRole("heading", { name: /Deals/ }).isVisible());
  const row = page.getByRole("link", { name: new RegExp(client.business_name) }).first();
  check("the new deal is listed under Working on", await row.isVisible());
  await row.click();
  await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/);
  check(
    "deal page shows the merchant",
    (await page.getByRole("heading", { level: 1 }).innerText()).includes(client.business_name),
  );
  check("milestone chips", await page.getByRole("list", { name: "Milestones" }).isVisible());
  check(
    "next step says Ops is working the file",
    (await page.locator("main").innerText()).includes("Ops is working the file"),
  );

  // a rep note saves on blur
  const note = page.locator("textarea").first();
  await note.fill("E2E note: wants it by Friday");
  await page.getByRole("button", { name: "Save" }).first().click();
  await page.getByText("Saved").first().waitFor({ timeout: 8000 });
  const saved = await withDb((db) =>
    one(db, "select rep_note from deals where client_id = $1", [client.id]),
  );
  check(
    "the note is in the database",
    saved?.rep_note === "E2E note: wants it by Friday",
    JSON.stringify(saved),
  );

  // the tabs render
  for (const [tab, key] of [
    ["Documents", "documents"],
    ["Activity", "activity"],
    ["Lenders & offers", "offers"],
  ]) {
    await page
      .getByRole("navigation", { name: "Deal sections" })
      .getByRole("link", { name: tab })
      .click();
    await page.waitForURL(new RegExp(`tab=${key}`), { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    check(`${tab} tab renders`, page.url().includes(`tab=${key}`));
  }

  // FUND: terms in, commission previewed, confirmed by this manager in one click
  await page.goto(page.url().split("?")[0], { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "FUND", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // no lender row exists on this deal yet, so the lender is typed (the ledger still gets 6 points = sell − buy)
  await dialog.getByRole("combobox").first().selectOption("");
  await dialog.getByPlaceholder("Who funded it").fill("E2E Lender");
  await dialog.getByPlaceholder("50,000").fill("40000");
  await dialog.getByPlaceholder("1.35").fill("1.35");
  await dialog.getByPlaceholder("1.28").fill("1.29");
  await dialog.getByPlaceholder("2,500").fill("1000");
  await dialog.getByPlaceholder("506.25").fill("450");
  await dialog.getByPlaceholder("120").fill("120");
  await dialog.getByRole("button", { name: "Preview commission" }).click();
  await dialog.getByText("Gross commission").waitFor({ timeout: 8000 });
  const previewText = await dialog.innerText();
  check(
    "preview: 6 points on $40k + $1,000 PSF = $3,400 gross",
    previewText.includes("$3,400"),
    previewText.slice(0, 200),
  );
  await dialog.getByRole("button", { name: /Fund and confirm/ }).click();
  await page.getByText(/Funded and confirmed/).waitFor({ timeout: 10000 });
  const funding = await withDb((db) =>
    one(
      db,
      "select amount_cents, commission_cents, confirmed_at is not null as confirmed, ledger_state, (select count(*)::int from commission_ledger l where l.funding_id = f.id) as lines from fundings f where f.client_id = $1 order by created_at desc limit 1",
      [client.id],
    ),
  );
  check(
    "the funding is confirmed with its commission on the ledger",
    Number(funding?.amount_cents) === 4_000_000 &&
      Number(funding?.commission_cents) === 340_000 &&
      funding?.confirmed &&
      funding?.lines === 1,
    JSON.stringify(funding),
  );
  const deal = await withDb((db) =>
    one(db, "select outcome from deals where client_id = $1", [client.id]),
  );
  check("the deal closed as funded", deal?.outcome === "funded", JSON.stringify(deal));

  await page.goto(`${BASE}/funded`, { waitUntil: "networkidle" });
  check(
    "the Funded sheet lists it",
    (await page.locator("main").innerText()).includes(client.business_name),
  );
  await withDb((db) =>
    db.query("delete from funders where id = $1", [lender.id]).catch(() => undefined),
  );
  await browser.close();
}
