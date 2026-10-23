import { BASE, check, openBrowser, withDb } from "./lib.mjs";

export default async function funderPackageFlow({ email }) {
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });

  // A merchant with an advance elsewhere, and a funder with a submission address and a contact.
  const ids = await withDb(async (db) => {
    const uid = (await db.query("select id from app_users where email = $1", [email])).rows[0].id;
    const cid = (
      await db.query(
        "select id from clients where user_id = $1 and business_name = 'Rivera Auto Repair'",
        [uid],
      )
    ).rows[0].id;
    await db.query(
      "update clients set industry = 'Auto repair', state = 'TX', monthly_revenue_cents = 9000000, time_in_business_months = 48 where id = $1",
      [cid],
    );
    await db.query(
      "insert into positions (user_id, client_id, position_no, funder_name, funded_amount_cents, payback_cents, balance_cents, payment_cents, frequency) values ($1, $2, 1, 'Zeta Capital', 2500000, 3250000, 900000, 21000, 'daily')",
      [uid, cid],
    );
    const fid = (
      await db.query(
        "insert into funders (user_id, name, submission_email, contact_name) values ($1, 'Package Fund', 'subs@packagefund.example', 'Dana Cole') returning id",
        [uid],
      )
    ).rows[0].id;
    await db.query("begin");
    await db.query("set local role isaac_app");
    await db.query("select set_config('app.user_id', $1, true)", [uid]);
    await db.query("select * from create_submissions($1, $2::uuid[])", [cid, [fid]]);
    await db.query("commit");
    return { cid };
  });

  await page.goto(`${BASE}/clients/${ids.cid}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Copy summary" }).click();
  await page.getByText(/Summary copied/).waitFor({ timeout: 5000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(
    "the copied summary names the merchant, the ask, and the advance elsewhere",
    clip.includes("Rivera Auto Repair") &&
      clip.includes("Industry: Auto repair") &&
      clip.includes("Zeta Capital") &&
      clip.includes("balance $9,000") &&
      clip.includes("Position: would be 4th"),
    clip.replace(/\n+/g, " | ").slice(0, 700),
  );
  check(
    "it greets with no contact name (the copy isn't aimed at one funder)",
    clip.includes("Hi team,"),
  );

  const link = page.getByRole("link", { name: "Email package" });
  const href = (await link.getAttribute("href")) ?? "";
  const url = new URL(href);
  check(
    "the funder row has an Email package link to Gmail",
    url.hostname === "mail.google.com",
    href.slice(0, 60),
  );
  check(
    "addressed to the funder's submission address",
    url.searchParams.get("to") === "subs@packagefund.example",
  );
  check(
    "the email is written to the funder's contact and carries the merchant",
    (url.searchParams.get("body") ?? "").startsWith("Hi Dana Cole,") &&
      (url.searchParams.get("su") ?? "").includes("Rivera Auto Repair"),
  );
  check(
    "opens in a new tab without handing over the opener",
    (await link.getAttribute("target")) === "_blank" &&
      /noopener/.test((await link.getAttribute("rel")) ?? ""),
  );
  check(
    "no internal notes leak into the email",
    !(url.searchParams.get("body") ?? "").includes("Called"),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check("no sideways scroll at 390px", !overflow);
  await browser.close();
}
