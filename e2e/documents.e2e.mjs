// The merchant page's Documents card: how fresh the statements are, adding a file (labelled by itself), relabelling,
// deleting, the upload link, and the public upload page's wording. Every check reads the DATABASE.
// Run: pnpm e2e documents
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const PDF = Buffer.from("%PDF-1.4\n% an e2e statement\n%%EOF\n");

export default async function documentsFlow({ email }) {
  const merchant = await one(
    "select c.id from clients c join app_users u on u.id = c.user_id where u.email = $1 and c.business_name = 'Mike''s Pizza'",
    [email],
  );
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.goto(`${BASE}/clients/${merchant.id}`, { waitUntil: "networkidle" });
  const docs = page.locator("section", {
    has: page.getByRole("heading", { name: "Documents", exact: true }),
  });
  await docs.waitFor();
  check(
    "the merchant page has a Documents card that says what the file still needs and that nothing is in yet",
    (await docs.getByText(/^No statements yet\. The file needs /).isVisible()) &&
      (await docs.getByText("No documents yet").isVisible()),
  );

  // add a file: it is filed, labelled by its name and open to the rep
  await docs.locator("input[type=file]").setInputFiles({
    name: "Chase_Statement_Oct_2026.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await page
    .getByText(/1 file filed/)
    .first()
    .waitFor({ timeout: 10000 });
  const filed = await one(
    "select id, kind, period::text period, source, scan_status, deleted_at from documents where client_id = $1",
    [merchant.id],
  );
  check(
    "DB: the file is a bank statement for October 2026, added by the rep and already clean",
    filed?.kind === "bank_statement" &&
      filed.period === "2026-10-01" &&
      filed.source === "staff" &&
      filed.scan_status === "clean" &&
      filed.deleted_at === null,
    JSON.stringify(filed),
  );
  await docs.getByText("Oct 2026 bank statement").waitFor({ timeout: 8000 });
  check(
    "the card lists it by its label with an Open link to the file",
    (await docs.getByRole("link", { name: "Open" }).getAttribute("href")) ===
      `/api/docs/${filed.id}`,
  );
  const got = await page.request.get(`${BASE}/api/docs/${filed.id}`);
  check(
    "Open serves the file exactly as it was filed",
    got.status() === 200 && Buffer.compare(await got.body(), PDF) === 0,
    `${got.status()}`,
  );
  check(
    "the open is logged as one view by the rep, and nothing is stamped on the file",
    (
      await one(
        "select count(*)::int n from document_views where document_id = $1 and action = 'view' and viewer_user_id is not null",
        [filed.id],
      )
    ).n === 1,
  );
  check(
    "the statements checklist notes the month as received",
    !!(await one(
      "select 1 from stips where client_id = $1 and kind = 'bank_statement' and period = '2026-10-01' and received_at is not null",
      [merchant.id],
    )),
  );

  // relabel
  await docs.getByRole("button", { name: "Relabel" }).click();
  await docs.getByLabel("Document type").selectOption({ label: "Tax return" });
  await docs.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Label saved").first().waitFor({ timeout: 8000 });
  check(
    "DB: relabelling to Tax return is stored, and the offered kinds have no contract or offer sheet",
    (await one("select kind from documents where id = $1", [filed.id]))?.kind === "tax_return" &&
      !(await docs.getByLabel("Document type").allInnerTexts())
        .join(" ")
        .match(/contract|offer|funding/i),
  );

  // the upload link
  await docs.getByRole("button", { name: "Copy upload link" }).click();
  await page
    .getByText(/Upload link copied/)
    .first()
    .waitFor({ timeout: 8000 });
  const session = await one(
    "select token, purpose from upload_sessions where client_id = $1 order by created_at desc limit 1",
    [merchant.id],
  );
  check(
    "DB: an upload session was minted for this merchant, and the link is on the clipboard",
    !!session &&
      (await page.evaluate(() => navigator.clipboard.readText())) ===
        `${BASE}/upload/${session.token}`,
    JSON.stringify(session),
  );
  const pub = await context.newPage();
  await pub.goto(`${BASE}/upload/${session.token}`, { waitUntil: "networkidle" });
  const pubText = await pub.locator("main").innerText();
  check(
    "the merchant's public upload page speaks of the people working on the file, not lenders",
    /people working on your file/.test(pubText) && !/lender/i.test(pubText),
  );
  await pub.close();

  // delete: two clicks
  await docs.getByRole("button", { name: "Delete" }).click();
  check(
    "one click alone does not delete",
    (await one("select deleted_at from documents where id = $1", [filed.id]))?.deleted_at === null,
  );
  await docs.getByRole("button", { name: "Really delete" }).click();
  check(
    "DB: the second click deletes it",
    await until(
      async () =>
        (await one("select deleted_at from documents where id = $1", [filed.id]))?.deleted_at !==
        null,
    ),
  );
  await docs.getByText("No documents yet").waitFor({ timeout: 8000 });
  await browser.close();
}
