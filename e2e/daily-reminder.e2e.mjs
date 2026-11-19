// The daily reminder in the browser (manager): set the shop's reminder time in Settings, pick a bucket's daily template
// on the Buckets page, reload and see both stayed; the Follow Up board and a member read as a daily bucket; a rep gets
// no control. Every check reads the DATABASE, never only a toast. Run: pnpm e2e daily-reminder
// What it makes (a bucket, templates, its members' enrolments) is removed again and the reminder time is put back.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const rows = (sql, params = []) => withDb((db) => db.query(sql, params)).then((r) => r.rows);
const one = async (sql, params = []) => (await rows(sql, params))[0];

export default async function dailyReminder({ email }) {
  await setRole(email, "manager");
  const me = await one("select id from app_users where email = $1", [email]);
  const stamp = Date.now();
  const wasMinute = (await one("select daily_reminder_minute as m from shop_settings")).m;
  const { browser, page } = await openBrowser(email);
  const toast = (re) => page.getByText(re).first().waitFor({ timeout: 10000 });
  const open = (path) => page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const minute = async () => (await one("select daily_reminder_minute as m from shop_settings")).m;
  const made = { bucket: null, templates: [] };
  let repBrowser = null;

  try {
    // ---- Settings: the shop's reminder time ------------------------------------------------------------------
    await open("/settings/email");
    const time = page.getByLabel("Daily reminder time");
    check(
      "the Email page offers the daily reminder time with its hint",
      (await time.isVisible()) &&
        (await page
          .getByText(
            "Buckets that have a daily reminder send it at this time in each merchant's own time zone, every day but Saturday. Between 6:00 AM and 8:00 PM.",
          )
          .isVisible()),
    );
    check(
      "it loads the stored time",
      (await time.inputValue()) ===
        `${String(Math.floor(wasMinute / 60)).padStart(2, "0")}:${String(wasMinute % 60).padStart(2, "0")}`,
      `${wasMinute} minutes stored`,
    );
    await time.fill("08:30");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/^Saved$/);
    await page.waitForTimeout(500);
    check("8:30 AM reaches the database as 510 minutes", (await minute()) === 510);
    const audit = await one(
      "select detail from audit_events where user_id = $1 and kind = 'settings_shop_saved' order by at desc limit 1",
      [me.id],
    );
    check(
      "the save is in the security log as a change of the daily reminder time",
      Array.isArray(audit?.detail?.changed) &&
        audit.detail.changed.includes("daily_reminder_minute") &&
        audit.detail.values.daily_reminder_minute.to === 510,
      JSON.stringify(audit?.detail),
    );

    await time.fill("05:00");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/Daily reminder time must be between 6:00 AM and 8:00 PM\./);
    check("5:00 AM is refused in plain words and the database keeps 510", (await minute()) === 510);
    await time.fill("21:00");
    await page.getByRole("button", { name: "Save settings" }).click();
    await toast(/Daily reminder time must be between 6:00 AM and 8:00 PM\./);
    check("9:00 PM is refused too", (await minute()) === 510);

    await open("/settings/email");
    check(
      "a reload shows 08:30",
      (await page.getByLabel("Daily reminder time").inputValue()) === "08:30",
    );

    // ---- Buckets: a daily template on a bucket ---------------------------------------------------------------
    const tpl = async (name, approved, archived) =>
      (
        await one(
          "insert into templates (owner_id, name, subject, body, approved, archived, created_by) values ($5, $1, 'Quick reminder', 'Hi {first_name}, still interested?', $2, $3, $4) returning id",
          [name, approved, archived, me.id, approved ? null : me.id],
        )
      ).id;
    const goodName = `E2E Daily Reminder ${stamp}`;
    const good = await tpl(goodName, true, false);
    const other = await tpl(`E2E Other Reminder ${stamp}`, true, false);
    // a manager's shared template may always send (it is its own approval), so the unapproved one is a rep-style private one
    const draft = await tpl(`E2E Draft Reminder ${stamp}`, false, false);
    const old = await tpl(`E2E Archived Reminder ${stamp}`, true, true);
    made.templates.push(good, other, draft, old);
    const bucketName = `E2E Daily ${stamp}`;
    made.bucket = (
      await one(
        "insert into buckets (name, owner_id, rule, sort) values ($1, null, 'manual', 900) returning id",
        [bucketName],
      )
    ).id;
    const merchants = await rows(
      "select id, business_name from clients where user_id = $1 order by created_at limit 2",
      [me.id],
    );
    for (const m of merchants)
      await withDb((db) =>
        db.query(
          "insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on) values ($1, $2, $3, 3, current_date + 9)",
          [me.id, m.id, made.bucket],
        ),
      );
    check("setup: a shared bucket with two live members", merchants.length === 2);

    await open(`/settings/buckets?b=${made.bucket}`);
    const card = page.locator(`[id="${made.bucket}"]`);
    const select = card.getByLabel("Daily reminder", { exact: true });
    const options = await select.locator("option").allInnerTexts();
    check(
      "the select offers None and the templates the engine may send, not drafts or archived ones",
      options[0] === "None: use the steps below" &&
        options.includes(goodName) &&
        options.includes(`E2E Other Reminder ${stamp}`) &&
        !options.some(
          (o) => o.includes("E2E Draft Reminder") || o.includes("E2E Archived Reminder"),
        ),
      JSON.stringify(options.filter((o) => o.includes("E2E") || o.startsWith("None"))),
    );
    await select.selectOption({ label: goodName });
    await card.getByRole("button", { name: "Save reminder" }).click();
    await toast(/^Daily reminder saved$/);
    await page.waitForTimeout(500);
    const bucket = await one("select daily_template_id from buckets where id = $1", [made.bucket]);
    check("the template is on the bucket in the database", bucket.daily_template_id === good);
    const members = await rows(
      "select next_step, (next_due_on = current_date - 1) as yesterday from enrollments where bucket_id = $1 and stopped_at is null",
      [made.bucket],
    );
    check(
      "both live members start again: step 1, due so the engine books today's reminder",
      members.length === 2 && members.every((m) => m.next_step === 1 && m.yesterday === true),
      JSON.stringify(members),
    );

    await open(`/settings/buckets?b=${made.bucket}`);
    const text = await page.locator(`[id="${made.bucket}"]`).innerText();
    check(
      "a reload still shows the template picked",
      (await page
        .locator(`[id="${made.bucket}"]`)
        .getByLabel("Daily reminder", { exact: true })
        .inputValue()) === good,
    );
    check(
      "the step list says it is not used, and the note reads the shop's time in the merchant's",
      text.includes("Not used while a daily reminder is on") &&
        text.includes("daily at 8:30 AM, their time, every day but Saturday"),
      text.replace(/\s+/g, " ").replace(/Application — first ask.*?(?=Not used|Everyone|$)/, "…"),
    );

    // ---- Follow Up: the board and a member say what is true ---------------------------------------------------
    await open("/follow-up");
    const boardCard = page.locator("main").locator(`a[href="/follow-up?b=${made.bucket}"]`).first();
    check(
      "the All buckets card reads the daily wording",
      (await boardCard.innerText()).includes(
        "Daily at 8:30 AM, their time, every day but Saturday",
      ),
      (await boardCard.innerText()).replace(/\s+/g, " "),
    );
    await open(`/follow-up?b=${made.bucket}`);
    const main = await page.locator("main").innerText();
    check(
      "the bucket page shows the daily line and 'Every day but Saturday', never 'Day 0'",
      main.includes("Daily at 8:30 AM, their time, every day but Saturday") &&
        /every day but saturday/i.test(main) &&
        !/Day 0/.test(main),
      main.replace(/\s+/g, " ").slice(-900),
    );
    check(
      "a member's row says Daily reminder, not Step 1",
      main.includes("Daily reminder") && !/Step 1\b/.test(main),
    );

    // ---- clearing it: just None ---------------------------------------------------------------------------------
    await open(`/settings/buckets?b=${made.bucket}`);
    const card2 = page.locator(`[id="${made.bucket}"]`);
    await card2
      .getByLabel("Daily reminder", { exact: true })
      .selectOption({ label: "None: use the steps below" });
    await card2.getByRole("button", { name: "Save reminder" }).click();
    await toast(/^Daily reminder off$/);
    await page.waitForTimeout(500);
    check(
      "None empties the column and leaves the steps in use",
      (await one("select daily_template_id from buckets where id = $1", [made.bucket]))
        .daily_template_id === null &&
        !(await page.locator(`[id="${made.bucket}"]`).innerText()).includes(
          "Not used while a daily reminder is on",
        ),
    );
    await open(`/settings/buckets?b=${made.bucket}`);
    check(
      "a reload shows None",
      (await page
        .locator(`[id="${made.bucket}"]`)
        .getByLabel("Daily reminder", { exact: true })
        .inputValue()) === "",
    );

    // ---- a rep gets no control and the database stays as it was ----------------------------------------------
    await withDb((db) =>
      db.query("update buckets set daily_template_id = $2 where id = $1", [made.bucket, other]),
    );
    // the session carries the role, so the rep signs in afresh
    await setRole(email, "rep");
    const repSide = await openBrowser(email);
    repBrowser = repSide.browser;
    await repSide.page.goto(`${BASE}/settings/buckets?b=${made.bucket}`, {
      waitUntil: "networkidle",
    });
    const repCard = repSide.page.locator(`[id="${made.bucket}"]`);
    check(
      "a rep sees no daily reminder control, only that a manager set one",
      (await repCard.getByLabel("Daily reminder", { exact: true }).count()) === 0 &&
        (await repCard.innerText()).includes("set by a manager"),
      (await repCard.innerText().catch(() => "no card")).replace(/\s+/g, " ").slice(0, 300),
    );
    check(
      "and the database still holds the manager's template",
      (await one("select daily_template_id from buckets where id = $1", [made.bucket]))
        .daily_template_id === other,
    );
  } finally {
    await setRole(email, "manager");
    await withDb(async (db) => {
      if (made.bucket) {
        await db.query("delete from enrollments where bucket_id = $1", [made.bucket]);
        await db.query("delete from buckets where id = $1", [made.bucket]);
      }
      if (made.templates.length)
        await db.query("delete from templates where id = any($1)", [made.templates]);
      await db.query("update shop_settings set daily_reminder_minute = $1", [wasMinute]);
    });
    await repBrowser?.close();
    await browser.close();
  }
}
