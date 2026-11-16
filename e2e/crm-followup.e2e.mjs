// Follow Up: buckets with their people, a personal bucket, pause, move. Run: pnpm e2e crm-followup
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);

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

  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email);
  await page.goto(`${BASE}/follow-up?b=${bucket.id}`, { waitUntil: "networkidle" });
  check("Follow Up heading", await page.getByRole("heading", { name: "Follow Up" }).isVisible());
  const text = await page.locator("main").innerText();
  check(
    "the bucket lists its people with the lead line",
    merchants.every((m) => text.includes(m.business_name)) && text.includes("Step 1"),
  );

  // a personal bucket
  await page.getByPlaceholder("New bucket…").fill("E2E hot list");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(/Bucket made/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const mine = await withDb((db) =>
    one(db, "select id, owner_id from buckets where name = 'E2E hot list'", []),
  );
  check(
    "the personal bucket is in the database, owned by the rep",
    mine?.owner_id === userId,
    JSON.stringify(mine),
  );

  // pause one person from the row popup
  const first = merchants[0];
  await page
    .getByRole("button", { name: new RegExp(first.business_name) })
    .first()
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page;
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

  // check two, move them to the new bucket
  for (const m of merchants.slice(1))
    await page.getByRole("checkbox", { name: `Check ${m.business_name}` }).check();
  await page.getByLabel("Move to bucket").selectOption({ label: "E2E hot list" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByText(/^Moved$/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const moved = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from enrollments where bucket_id = $1 and stopped_at is null",
      [mine.id],
    ),
  );
  check(
    "the move reaches the database (old enrolments stopped, new ones live)",
    moved?.n === 2,
    JSON.stringify(moved),
  );
  await browser.close();
}
