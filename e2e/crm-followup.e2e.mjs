// Follow Up: the All buckets board, a bucket with its people, a personal bucket, pause, move, hand off.
// Run: pnpm e2e crm-followup
import { BASE, check, openBrowser, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

export default async function followUpFlow({ email }) {
  const userId = await withDb((db) =>
    one(db, "select id from app_users where email = $1", [email]),
  ).then((r) => r.id);
  const bucket = await withDb((db) =>
    one(db, "select id from buckets where key = 'interested'", []),
  );
  const merchants = await withDb((db) =>
    db
      .query(
        "select id, business_name from clients where user_id = $1 and stage in ('interested', 'name_in') order by business_name limit 3",
        [userId],
      )
      .then((r) => r.rows),
  );
  await withDb(async (db) => {
    await db.query("select set_config('app.user_id', $1, false)", [userId]);
    for (const m of merchants)
      await db.query("select enroll_in_bucket($1, $2, 'moved')", [m.id, bucket.id]);
  });
  check("setup: three of the rep's merchants are in Interested", merchants.length === 3);

  // The seeded rep (a manager would see the whole shop's Interested list, where other runs' seeded merchants
  // carry the same names).
  const { browser, page } = await openBrowser(email);

  // ---- the board: every bucket as a card that opens it
  await page.goto(`${BASE}/follow-up`, { waitUntil: "networkidle" });
  check(
    "Follow Up with no bucket picked is the All buckets board",
    await page.getByRole("heading", { name: "All buckets", level: 1 }).isVisible(),
  );
  const card = page.locator("main").locator(`a[href="/follow-up?b=${bucket.id}"]`).first();
  check("the board has a card for Interested", await card.isVisible());
  await card.click();
  await page.waitForURL((u) => u.searchParams.get("b") === bucket.id, { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  check("Follow Up heading", await page.getByRole("heading", { name: "Follow Up" }).isVisible());
  const text = await page.locator("main").innerText();
  check(
    "the bucket lists its people with the lead line",
    merchants.every((m) => text.includes(m.business_name)) && text.includes("Step 1"),
  );

  // ---- a personal bucket, from the New bucket dialog
  const name = `E2E hot list ${Date.now()}`;
  await page.locator("main").getByRole("button", { name: "New bucket" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New bucket" });
  await dialog.getByPlaceholder("New bucket…").fill(name);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(/Bucket made/).waitFor({ timeout: 8000 });
  let mine = null;
  await until(async () => {
    mine = await withDb((db) =>
      one(db, "select id, owner_id from buckets where name = $1", [name]),
    );
    return !!mine;
  });
  check(
    "the personal bucket is in the database, owned by the rep",
    mine?.owner_id === userId,
    JSON.stringify(mine),
  );
  check(
    "the New bucket dialog closes once the bucket is made",
    await until(() => dialog.isHidden()),
  );

  // ---- pause one person from their sheet
  const first = merchants[0];
  await page.getByRole("button", { name: `Actions for ${first.business_name}` }).click();
  const sheet = page.getByRole("dialog", { name: first.business_name });
  await sheet.getByRole("button", { name: "Pause", exact: true }).click();
  let paused = null;
  for (let i = 0; i < 20 && !paused?.paused; i++) {
    await page.waitForTimeout(400);
    paused = await withDb((db) =>
      one(db, "select paused from enrollments where client_id = $1 and stopped_at is null", [
        first.id,
      ]),
    );
  }
  check("pause reaches the database", paused?.paused === true, JSON.stringify(paused));
  check(
    "the sheet stays open after Pause and now offers Resume",
    await until(() => sheet.getByRole("button", { name: "Resume", exact: true }).isVisible()),
  );
  await page.keyboard.press("Escape");
  check("Escape closes the sheet", await until(() => sheet.isHidden()));

  // ---- check two, move them to the new bucket
  for (const m of merchants.slice(1))
    await page.getByRole("checkbox", { name: `Check ${m.business_name}` }).check();
  const bar = page.getByRole("toolbar", { name: "Checked merchants" });
  await bar.getByLabel("Move to bucket").selectOption({ label: name });
  await bar.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByText(/^Moved$/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const moved = await withDb((db) =>
    one(
      db,
      `select (select count(*)::int from enrollments where bucket_id = $1 and stopped_at is null) as n,
              (select count(*)::int from enrollments where bucket_id = $2 and stopped_at is null
                  and client_id = any($3::uuid[])) as left_behind`,
      [mine.id, bucket.id, merchants.slice(1).map((m) => m.id)],
    ),
  );
  check(
    "the move reaches the database (old enrolments stopped, new ones live)",
    moved?.n === 2 && moved?.left_behind === 0,
    JSON.stringify(moved),
  );

  // ---- hand off from the bucket page: the row's Hand off action
  await page.getByRole("button", { name: `Actions for ${first.business_name}` }).hover();
  await page.getByRole("button", { name: `Hand off ${first.business_name}` }).click();
  await page.getByText(`${first.business_name} handed off`).waitFor({ timeout: 10000 });
  let handed = null;
  await until(async () => {
    handed = await withDb((db) =>
      one(
        db,
        `select c.brought_in_at is not null as brought_in,
                (select count(*)::int from enrollments e where e.client_id = c.id and e.stopped_at is null) as live,
                (select e.stop_reason from enrollments e where e.client_id = c.id and e.bucket_id = $2
                  order by e.stopped_at desc nulls first limit 1) as reason
           from clients c where c.id = $1`,
        [first.id, bucket.id],
      ),
    );
    return handed?.brought_in && handed.live === 0;
  }, 10000);
  check(
    "Hand off marks the merchant brought in and stops their enrolment with reason brought_in (database)",
    handed?.brought_in === true && handed.live === 0 && handed.reason === "brought_in",
    JSON.stringify(handed),
  );
  check(
    "the handed-off merchant leaves the bucket's list",
    await until(
      async () =>
        (await page.getByRole("button", { name: `Actions for ${first.business_name}` }).count()) ===
        0,
    ),
  );
  await browser.close();
}
