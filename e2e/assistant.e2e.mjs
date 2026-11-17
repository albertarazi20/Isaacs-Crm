// The assistant (Claude Opus 5.5) in the browser. Without a model it must still be useful: the Overview's
// recommendations are read from the database and link to the pages, and the panel says plainly why it cannot answer.
// With the stand-in model (WIRE_AI=stub, a dev server pointed at e2e/model-stub.mjs) the whole loop runs: a
// recommendation is planned, the answer streams in, the action buttons do what they say, and every change is read
// back from the DATABASE.
// Run: pnpm e2e assistant                                  (no model)
//      WIRE_AI=stub BASE_URL=http://localhost:3008 pnpm e2e assistant
import { BASE, check, openBrowser, withDb } from "./lib.mjs";
import { startModelStub } from "./model-stub.mjs";

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

export default async function assistantFlow({ email }) {
  const me = await one("select id from app_users where email = $1", [email]);
  const overdue = await one(
    `select count(*)::int as n from client_cards c join clients k on k.id = c.id
      where c.user_id = $1 and c.next_due_on < current_date and k.brought_in_at is null
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
    [me.id],
  );
  const stub = process.env.WIRE_AI === "stub";
  const model = stub ? await startModelStub() : null;
  const { browser, context, page } = await openBrowser(email);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  try {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const section = page.getByRole("region", { name: "Recommended next" });
    await section.waitFor();
    const overdueCard = section
      .getByRole("listitem")
      .filter({ hasText: /^Clear \d+ overdue follow-ups?/ });
    check(
      "the Overview recommends clearing the overdue follow-ups, with the number the database has",
      overdue.n > 0 &&
        (await overdueCard.count()) === 1 &&
        (await overdueCard.innerText()).includes(`Clear ${overdue.n} overdue follow-up`),
      `${overdue.n} in the database`,
    );
    await overdueCard.getByRole("link", { name: /^Open:/ }).click();
    await page.waitForURL(/\/today$/);
    check(
      "a recommendation's Open goes to the page where it is done by hand",
      page.url().endsWith("/today"),
    );

    if (!stub) {
      await page.getByRole("button", { name: "Ask the assistant" }).first().click();
      const panel = page.getByRole("dialog", { name: "Assistant" });
      await panel.waitFor();
      check(
        "without a model the panel says why, keeps the recommendations, and the composer is off",
        (await panel
          .getByText(/not set up on this server|switched off|budget/)
          .first()
          .isVisible()) &&
          (await panel.getByRole("textbox", { name: "Ask the assistant" }).isDisabled()),
      );
      await page.keyboard.press("Escape");
      return;
    }

    // ---- with the stand-in model: plan the overdue work
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const runsBefore = await one(
      "select count(*)::int as n from ai_runs where purpose = 'assistant'",
    );
    await page
      .getByRole("region", { name: "Recommended next" })
      .getByRole("listitem")
      .filter({ hasText: /^Clear \d+ overdue/ })
      .getByRole("button", { name: "Plan it" })
      .click();
    const panel = page.getByRole("dialog", { name: "Assistant" });
    await panel.waitFor();
    const answer = panel.getByText(/You have \d+ overdue\. Start with/);
    check(
      "Plan it opens the panel and the answer streams in",
      await until(() => answer.isVisible(), 20000),
    );
    const shownCount = Number(/You have (\d+) overdue/.exec(await answer.innerText())?.[1]);
    check(
      "the answer is built from the CRM's own call list (the tool read the database)",
      shownCount === Math.min(overdue.n, 40),
      `${shownCount} vs ${overdue.n}`,
    );
    const followBtn = panel.getByRole("button", { name: /^Call .+ tomorrow/ });
    await followBtn.waitFor({ timeout: 15000 });
    check(
      "the actions arrive as buttons, nothing done yet",
      (await followBtn.innerText()).includes("Do it"),
    );
    await until(() => panel.getByText("Click a button to do it.").isVisible(), 15000);

    // which merchant? the stand-in picked the first overdue one the tool returned
    const first = await one(
      `select c.id, c.business_name from client_cards c join clients k on k.id = c.id
        where c.user_id = $1 and c.next_due_on < current_date and k.brought_in_at is null
          and not exists (select 1 from trashed_clients t where t.client_id = c.id)
        order by c.next_due_on, c.business_name limit 1`,
      [me.id],
    );
    await followBtn.click();
    const moved = await until(async () => {
      const r = await one(
        "select (next_due_on - current_date)::int as d from client_cards where id = $1",
        [first.id],
      );
      return r?.d === 1;
    });
    check(`clicking it sets ${first.business_name}'s next follow-up to tomorrow (database)`, moved);
    await panel.getByRole("button", { name: /^Note the plan/ }).click();
    const noted = await until(async () =>
      Boolean(
        await one(
          "select 1 from activities where client_id = $1 and kind = 'note' and body like 'Plan from the assistant%'",
          [first.id],
        ),
      ),
    );
    check("Note the plan writes the note on the merchant's timeline (database)", noted);
    await panel.getByRole("button", { name: /^Copy a text to send/ }).click();
    check(
      "Copy puts the message on the clipboard",
      await until(async () =>
        (await page.evaluate(() => navigator.clipboard.readText())).startsWith("Hi, it's me"),
      ),
    );

    const runsAfter = await one(
      "select count(*)::int as n from ai_runs where purpose = 'assistant'",
    );
    const thread = await one(
      "select title, jsonb_array_length(messages) as n from assistant_threads where user_id = $1 order by updated_at desc limit 1",
      [me.id],
    );
    check(
      "every model call is logged against the daily cap and the conversation is saved (database)",
      runsAfter.n - runsBefore.n === 3 && thread?.n === 6 && thread.title.startsWith("I have"),
      JSON.stringify({ runs: runsAfter.n - runsBefore.n, thread }),
    );
    check(
      "the model was asked for Claude Opus 5.5 with adaptive thinking and the safety fallback",
      model.calls.every(
        (c) =>
          c.body.model === "claude-opus-5-5" &&
          c.body.thinking?.type === "adaptive" &&
          c.body.fallbacks === "default",
      ),
    );

    // the history: a new conversation, then reopen the old one
    await panel.getByRole("button", { name: "New conversation" }).click();
    check(
      "New conversation starts empty",
      await panel.getByText("What should we work on?").isVisible(),
    );
    await panel.getByRole("button", { name: "Past conversations" }).click();
    await panel.getByRole("button", { name: /^I have \d+ follow-ups? past due/ }).click();
    check(
      "a past conversation reopens with its answer and its buttons",
      (await until(() => panel.getByText(/You have \d+ overdue/).isVisible())) &&
        (await panel.getByRole("button", { name: /^Call .+ tomorrow/ }).isVisible()),
    );
    await page.keyboard.press("Escape");
    check("Escape closes the panel", await until(async () => !(await panel.isVisible())));
    await page.keyboard.press("Control+j");
    check("Ctrl+J opens it again", await until(() => panel.isVisible()));
  } finally {
    await browser.close();
    await model?.close();
  }
}
