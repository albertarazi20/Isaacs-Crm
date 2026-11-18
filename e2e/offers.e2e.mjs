// Merchant offers in the browser: a rep generates an offer from the merchant's page (the preview does the arithmetic),
// the email is queued, the rep's own preview of the page counts nothing, and the merchant (signed out) opens it, uploads
// the two documents into their slots and accepts. Every step is read back from the DATABASE.
// Run: pnpm e2e offers
import { readFileSync } from "node:fs";
import { BASE, check, openBrowser, withDb } from "./lib.mjs";
import { chromium } from "playwright-core";

const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};
// the smallest real PNG: the upload checks a file is what it says it is
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const cronSecret = () =>
  process.env.CRON_SECRET ??
  /^CRON_SECRET=(.*)$/m.exec(readFileSync(new URL("../.env.local", import.meta.url), "utf8"))?.[1];

export default async function offersFlow({ email }) {
  const me = await one("select id from app_users where email = $1", [email]);
  const m = await one(
    "select id, business_name from clients where user_id = $1 and brought_in_at is null order by created_at limit 1",
    [me.id],
  );
  await withDb((db) =>
    db.query(
      "update clients set email = 'owner@merchant-e2e.com', contact_status = 'ok', email_opt_out = false where id = $1",
      [m.id],
    ),
  );
  const { browser, page } = await openBrowser(email);
  let merchant;
  try {
    await page.goto(`${BASE}/clients/${m.id}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Generate merchant offer" }).click();
    const form = page.getByRole("dialog", { name: /^Generate an offer for/ });
    await form.waitFor();
    await form.getByRole("textbox", { name: "Funding amount" }).fill("80,850");
    await form.getByRole("textbox", { name: "Factor rate" }).fill("1.35");
    await form.getByLabel("How often").selectOption("weekly");
    await form.getByRole("textbox", { name: "Number of payments" }).fill("26");
    const preview = form.getByRole("complementary", { name: "Preview" });
    check(
      "the form previews what the merchant will see, to the cent",
      await until(async () => {
        const t = await preview.innerText();
        return (
          t.includes("$80,850") &&
          t.includes("$4,197.98") &&
          t.includes("$4,198") &&
          t.includes("$109,147.50") &&
          t.includes("about 6 months")
        );
      }),
    );
    await form
      .getByRole("textbox", { name: "A note on the page" })
      .fill("Great speaking with you today.");
    await form.getByRole("button", { name: "Send the offer" }).click();
    const ready = page.getByRole("dialog", { name: "Offer ready" });
    await ready.waitFor({ timeout: 15000 });
    const url = await ready.getByRole("textbox").inputValue();
    const token = /\/offer\/([a-f0-9]{64})$/.exec(url)?.[1];
    const o = await one(
      "select id, payment_cents::int as pay, payback_cents::int as back, status, outbox_id from merchant_offers where client_id = $1 order by created_at desc limit 1",
      [m.id],
    );
    const mail = o
      ? await one("select lane, status, to_address, html_body from outbox where id = $1", [
          o.outbox_id,
        ])
      : null;
    check(
      "sending stores the offer with the database's numbers and queues the designed email to the merchant (database)",
      Boolean(token) &&
        o?.pay === 419798 &&
        o?.back === 10914750 &&
        o?.status === "sent" &&
        mail?.lane === "reply" &&
        mail?.status === "queued" &&
        mail?.to_address === "owner@merchant-e2e.com" &&
        mail?.html_body.includes(`/offer/${token}`),
      JSON.stringify({ o, lane: mail?.lane, status: mail?.status }),
    );
    await ready.getByRole("button", { name: "Done" }).click();
    const offers = page.getByRole("region", { name: "Offers" });
    check(
      "the merchant's page lists it, waiting on them, not opened yet",
      await until(async () =>
        /Waiting on them[\s\S]*Not opened yet/.test(await offers.innerText()),
      ),
    );

    // the rep's own look at the page is a preview: nothing counted, accept is off
    await page.goto(url, { waitUntil: "networkidle" });
    check(
      "a signed-in rep sees a preview, and it is not counted as the merchant opening it (database)",
      (await page.getByText("this is a preview").count()) === 1 &&
        (await one("select views from merchant_offers where id = $1", [o.id])).views === 0,
    );

    // ---- the merchant: no account, a fresh browser
    merchant = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox"],
    });
    const mp = await (
      await merchant.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await mp.goto(url, { waitUntil: "networkidle" });
    const terms = mp.getByRole("region", { name: "Your funding offer" });
    check(
      "the merchant's page shows who it is for, the terms and the countdown",
      (await mp.getByRole("heading", { name: m.business_name }).count()) === 1 &&
        (await terms.innerText()).includes("$80,850") &&
        (await terms.innerText()).includes("$4,197.98") &&
        (await terms.innerText()).includes("Final payment") &&
        (await terms.innerText()).includes("1.350") &&
        /\d+[dhm]( \d+[hm])? (left|remaining)/i.test(
          await mp.getByRole("region", { name: "How long the offer stands" }).innerText(),
        ),
    );
    check(
      "their first open is counted and their rep is told (database)",
      await until(async () => {
        const v = await one("select views from merchant_offers where id = $1", [o.id]);
        const a = await one(
          "select count(*)::int as n from user_alerts where kind = 'offer_opened' and client_id = $1",
          [m.id],
        );
        return v.views === 1 && a.n === 1;
      }),
    );
    const accept = mp.getByRole("button", { name: "Accept offer & submit documents" });
    check("accept waits for the documents", await accept.isDisabled());
    await mp
      .locator('input[type=file][aria-label="Upload your driver\'s license"]')
      .setInputFiles({ name: "license.png", mimeType: "image/png", buffer: PNG });
    check(
      "the license lands in its slot",
      await until(() => mp.getByText("Received. Thank you.").first().isVisible()),
    );
    await mp.locator('input[type=file][aria-label="Upload your voided check"]').setInputFiles({
      name: "check.png",
      mimeType: "image/png",
      buffer: Buffer.concat([PNG, Buffer.from([0])]),
    });
    check(
      "both files are filed on the merchant under the right kinds (database)",
      await until(async () => {
        const kinds = (
          await rows(
            "select kind from documents where client_id = $1 and source = 'upload_link' and deleted_at is null",
            [m.id],
          )
        ).map((r) => r.kind);
        return kinds.includes("drivers_license") && kinds.includes("voided_check");
      }),
    );
    await until(async () => !(await accept.isDisabled()));
    await accept.click();
    check(
      "accepting says so and is stored, with the rep told (database)",
      (await until(() => mp.getByRole("heading", { name: "Offer accepted" }).isVisible())) &&
        (await until(async () => {
          const r = await one("select status, accepted_name from merchant_offers where id = $1", [
            o.id,
          ]);
          const a = await one(
            "select count(*)::int as n from user_alerts where kind = 'offer_accepted' and client_id = $1",
            [m.id],
          );
          return r.status === "accepted" && a.n === 1;
        })),
    );
    await mp.reload({ waitUntil: "networkidle" });
    check(
      "opening it again shows it accepted",
      (await mp.getByRole("heading", { name: "Offer accepted" }).count()) === 1,
    );

    // the outbox job scans the uploads, then sends the rep their copy (here without a mailbox: it says why)
    const job = await fetch(`${BASE}/api/cron/outbox`, {
      headers: { authorization: `Bearer ${cronSecret()}` },
    });
    check(
      "the outbox job runs and reports the rep's copies",
      job.status === 200 || job.status === 502,
    );
    // back on the CRM
    await page.goto(`${BASE}/clients/${m.id}`, { waitUntil: "networkidle" });
    const card = await page.getByRole("region", { name: "Offers" }).innerText();
    check(
      "the merchant's page shows it accepted, that it was opened, and whether your copy went",
      /Accepted/.test(card) &&
        /Opened (once|\d+ times) · first /.test(card) &&
        /Your copy (with the documents went to your email|didn't send)/.test(card),
      card.replace(/\s+/g, " ").slice(0, 300),
    );
    const notice = await one(
      "select accept_notice_attempts as attempts, accept_notified_at is not null as done, accept_notice_error as error from merchant_offers where id = $1",
      [o.id],
    );
    check(
      "accepting tried to email the rep their copy, and kept the answer (database)",
      notice.attempts >= 1 && (notice.done || notice.error.length > 0),
      JSON.stringify(notice),
    );
  } finally {
    await merchant?.close();
    await browser.close();
  }
}
