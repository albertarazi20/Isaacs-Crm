// Follow Up tools in the browser: find anyone in any bucket (name, bucket, a number typed any way), the dial list to
// paste into Google Voice (one at a time, all at once, the merchant's own clock), the bucket and every bucket as a
// spreadsheet, and moving a merchant to another bucket from the merchant page. Counts and moves are read back from
// the DATABASE; a rep gets the dial list but no export.
// Run: pnpm e2e follow-up-tools
import { readFileSync } from "node:fs";
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

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
const usUS = (e164) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
const LIVE = `e.stopped_at is null and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`;

export default async function followUpTools({ email }) {
  await setRole(email, "manager");
  const me = await one("select id from app_users where email = $1", [email]);
  const bucket = await one("select id, name from buckets where key = 'missing_app'");
  const cold = await one("select id, name from buckets where key = 'cold'");
  // a merchant of this user's own, in the bucket, with a known number, to find and to move
  const mine = await one(
    "select id, business_name from clients where user_id = $1 order by created_at limit 1",
    [me.id],
  );
  await withDb((db) =>
    db.query("update clients set phone = '+13055559876', contact_status = 'ok' where id = $1", [
      mine.id,
    ]),
  );
  await withDb((db) => db.query("select enroll_in_bucket($1, $2)", [mine.id, bucket.id]));
  // and a second one with a number, so there is somewhere to go next
  const second = await one(
    "select id from clients where user_id = $1 and id <> $2 order by created_at limit 1",
    [me.id, mine.id],
  );
  await withDb((db) =>
    db.query("update clients set phone = '+13055559877', contact_status = 'ok' where id = $1", [
      second.id,
    ]),
  );
  await withDb((db) => db.query("select enroll_in_bucket($1, $2)", [second.id, bucket.id]));
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  const today = (await one("select current_date::text as d")).d;
  try {
    // ---- All buckets: find anyone
    await page.goto(`${BASE}/follow-up`, { waitUntil: "networkidle" });
    const search = page.getByRole("searchbox", { name: "Search every bucket" });
    await search.fill(mine.business_name.split(" ")[0]);
    const chip = page.getByRole("link", { name: bucket.name, exact: true }).first();
    check(
      "searching every bucket by name finds the merchant and says which bucket they are in",
      await until(() => chip.isVisible()),
    );
    for (const typed of ["3055559876", "(305) 555-9876", "305-555-98", "+1305555"]) {
      await search.fill(typed);
      check(
        `a number typed as "${typed}" finds ${mine.business_name}`,
        await until(() =>
          page
            .getByRole("link", { name: new RegExp(`^${mine.business_name}`) })
            .first()
            .isVisible(),
        ),
      );
    }
    await search.fill("zzzz-nobody");
    check(
      "a search with no match says so",
      await until(() => page.getByText("Nobody matches").isVisible()),
    );
    await search.fill(bucket.name);
    check(
      "typing a bucket's name lists its people",
      await until(async () =>
        /\d+ matches?/.test(
          await page
            .getByText(/\d+ matches?/)
            .first()
            .innerText(),
        ),
      ),
    );

    // ---- Export every bucket
    const expected = await one(
      `select count(*)::int as n from enrollments e join clients c on c.id = e.client_id where ${LIVE} and c.contact_status <> 'dnc'`,
    );
    const [all] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export every bucket" }).click(),
    ]);
    const allCsv = readFileSync(await all.path(), "utf8")
      .replace(/^﻿/, "")
      .trim()
      .split("\r\n");
    check(
      "Export every bucket downloads one line a merchant under a header, and names the file for today",
      allCsv[0].startsWith("Business,Contact,Phone,Phone (E.164),Email,") &&
        allCsv.length - 1 === expected.n &&
        all.suggestedFilename() === `selective-all-buckets-${today}.csv`,
      `${allCsv.length - 1} lines, ${expected.n} in the database, ${all.suggestedFilename()}`,
    );
    check(
      "the file carries the merchant's number both ways, ready for a text blast",
      allCsv.some((l) => l.includes(usUS("+13055559876")) && l.includes("+13055559876")),
    );

    // ---- one bucket: search, dial list, export
    await page.goto(`${BASE}/follow-up?b=${bucket.id}`, { waitUntil: "networkidle" });
    const inBucket = await one(
      `select count(*)::int as n from enrollments e join clients c on c.id = e.client_id where ${LIVE} and e.bucket_id = $1`,
      [bucket.id],
    );
    const own = page.getByRole("searchbox", { name: "Search this bucket" });
    await own.fill("305-555-9876");
    check(
      "a bucket's own search finds a number typed with dashes, and the row shows the number",
      await until(async () => (await page.getByText(usUS("+13055559876")).count()) > 0),
    );
    const row = page.locator("main li", { hasText: usUS("+13055559876") }).first();
    check(
      "the number sits in the row itself, with the merchant's own time beside it",
      (await row.getByRole("button", { name: /^Copy .+'s number/ }).innerText()) ===
        usUS("+13055559876") &&
        /\b(ET|CT|MT|PT)\b · \d{1,2}:\d{2} (AM|PM)/.test(await row.innerText()),
    );
    check(
      "with a search on, the dial list and the file say how many they hold",
      (await page.getByRole("button", { name: /^Dial list, 1 shown/ }).count()) === 1 &&
        (await page.getByRole("button", { name: /^Export CSV, 1 shown/ }).count()) === 1,
    );
    await own.fill("");
    await page.getByRole("button", { name: /^Dial list, all/ }).click();
    const dial = page.getByRole("dialog", { name: /^Dial list/ });
    await dial.waitFor();
    const next = dial.getByRole("region", { name: "Next to dial" });
    const first = (await next.innerText()).match(/\(\d{3}\) \d{3}-\d{4}/)?.[0];
    check(
      "the dial list opens on the first number, with the merchant's own clock",
      Boolean(first) && /\b(ET|CT|MT|PT)\b.*(AM|PM)/.test(await next.innerText()),
    );
    await next.getByRole("button", { name: /^Copy number/ }).click();
    check(
      "Copy number puts that number on the clipboard",
      await until(async () => (await clip()) === first),
    );
    // how many the list holds, as the dialog itself says
    const total = Number(/of (\d+) dialed/.exec(await dial.innerText())?.[1]);
    const withNumbers = await one(
      `select count(distinct right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10))::int as n from enrollments e join clients c on c.id = e.client_id where ${LIVE} and e.bucket_id = $1
         and c.contact_status not in ('dnc', 'no_call') and length(regexp_replace(c.phone, '[^0-9]', '', 'g')) in (10, 11)`,
      [bucket.id],
    );
    check(
      "the list holds each number in the bucket once, for whoever may be called on it (database)",
      total === withNumbers.n && total >= 2,
      `${total} in the list, ${withNumbers.n} in the database`,
    );
    await next.getByRole("button", { name: /^Dialed, next/ }).click();
    check(
      "Dialed, next moves on and already has the next number on the clipboard",
      await until(async () => {
        const now = (await next.innerText()).match(/\(\d{3}\) \d{3}-\d{4}/)?.[0];
        return Boolean(now) && now !== first && (await clip()) === now;
      }),
    );
    check(
      "it counts the dialed ones",
      (await dial.getByText(`1 of ${total} dialed`).count()) === 1,
    );
    await dial.getByRole("button", { name: "Copy all numbers" }).click();
    await until(async () => (await clip()).split("\n").length === total);
    check(
      "Copy all numbers copies one number a line for Google Voice",
      (await clip()).split("\n").length === total &&
        (await clip()).split("\n").every((l) => /^\(\d{3}\) \d{3}-\d{4}$/.test(l)),
    );
    await dial.getByRole("button", { name: "Copy for a sheet" }).click();
    await until(async () => (await clip()).includes("\t"));
    check(
      "Copy for a sheet is business, contact and number separated by tabs",
      (await clip()).split("\n")[0].split("\t").length === 3,
    );
    await dial
      .getByRole("link", { name: "Open in Google Voice" })
      .first()
      .waitFor()
      .catch(() => {});
    await dial.getByRole("button", { name: "Close", exact: true }).last().click();

    const [one_] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /^Export CSV, all/ }).click(),
    ]);
    const csv = readFileSync(await one_.path(), "utf8")
      .replace(/^﻿/, "")
      .trim()
      .split("\r\n");
    const exportable = await one(
      `select count(*)::int as n from enrollments e join clients c on c.id = e.client_id where ${LIVE} and e.bucket_id = $1 and c.contact_status <> 'dnc'`,
      [bucket.id],
    );
    check(
      "a bucket's Export CSV has its own people only, under the same header, named for the bucket",
      csv.length - 1 === exportable.n &&
        csv.slice(1).every((l) => l.includes(bucket.name)) &&
        one_.suggestedFilename() === `selective-missing-application-${today}.csv`,
      `${csv.length - 1} lines of ${inBucket.n} in the bucket (${exportable.n} exportable)`,
    );

    // ---- the merchant page: move to another bucket
    await page.goto(`${BASE}/clients/${mine.id}`, { waitUntil: "networkidle" });
    const mover = page.getByLabel("Move to bucket");
    check(
      "the merchant page shows the bucket they are in",
      (await mover.inputValue()) === bucket.id &&
        (await mover.locator("option:checked").innerText()) === `Bucket: ${bucket.name}`,
    );
    check(
      "the stage control is its own, named for what it does",
      (await page.getByLabel("Move to stage").locator("option").first().innerText()) ===
        "Change stage…",
    );
    await mover.selectOption(cold.id);
    const moved = await until(async () => {
      const live = await rows(
        "select bucket_id from enrollments where client_id = $1 and stopped_at is null",
        [mine.id],
      );
      return live.length === 1 && live[0].bucket_id === cold.id;
    });
    check(
      `choosing ${cold.name} moves the merchant there and stops the old bucket (database)`,
      moved,
    );
    check(
      "the page now shows the new bucket",
      await until(
        async () =>
          (await page.getByLabel("Move to bucket").locator("option:checked").innerText()) ===
          `Bucket: ${cold.name}`,
      ),
    );
    await page.getByLabel("Move to bucket").selectOption(bucket.id);
    await until(
      async () =>
        (
          await one(
            "select bucket_id from enrollments where client_id = $1 and stopped_at is null",
            [mine.id],
          )
        )?.bucket_id === bucket.id,
    );

    // ---- a rep: the dial list yes, the files no (a new sign-in, which is where the role is read)
    await setRole(email, "rep");
    const rep = await openBrowser(email);
    try {
      await rep.page.goto(`${BASE}/follow-up?b=${bucket.id}`, { waitUntil: "networkidle" });
      check(
        "a rep gets the dial list but no export button",
        (await rep.page.getByRole("button", { name: /^Dial list/ }).count()) === 1 &&
          (await rep.page.getByRole("button", { name: /^Export CSV/ }).count()) === 0,
      );
      const denied = await rep.page.request.get(`${BASE}/api/export/followup?bucket=all`);
      check("and the file itself is refused to a rep", denied.status() === 403);
    } finally {
      await rep.browser.close();
    }
    await setRole(email, "manager");
    const bad = await page.request.get(`${BASE}/api/export/followup?bucket=not-a-bucket`);
    check("an unknown bucket is a 400, not a crash", bad.status() === 400);
  } finally {
    await withDb((db) => db.query("select enroll_in_bucket($1, $2)", [mine.id, bucket.id])).catch(
      () => {},
    );
    await browser.close();
  }
}
