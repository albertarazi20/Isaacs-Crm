// The brain in the browser: the job prepares the next step for what is new on a rep's Do this now list, the rep finds
// it under "Prepared for you", opens it with its buttons live, and clicks one; a manager runs it from Settings → AI.
// Needs the stand-in model (WIRE_AI=stub, a dev server on :3008 pointed at e2e/model-stub.mjs). Every result is read
// back from the DATABASE.
// Run: WIRE_AI=stub BASE_URL=http://localhost:3008 pnpm e2e brain
import { readFileSync } from "node:fs";
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";
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
const cronSecret = () =>
  process.env.CRON_SECRET ??
  /^CRON_SECRET=(.*)$/m.exec(readFileSync(new URL("../.env.local", import.meta.url), "utf8"))?.[1];
const runJob = async () => {
  const res = await fetch(`${BASE}/api/cron/brain`, {
    headers: { authorization: `Bearer ${cronSecret()}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

export default async function brainFlow({ email }) {
  if (process.env.WIRE_AI !== "stub") {
    console.log("   (the brain needs the stand-in model: WIRE_AI=stub, see model-stub.mjs)");
    return;
  }
  await setRole(email, "manager");
  const me = await one("select id from app_users where email = $1", [email]);
  const settings = await one(
    "select ai_enabled, brain_on, brain_daily_per_rep, ai_daily_cap_cents, playbook from shop_settings",
  );
  // the job works for every active rep: for this run only the throwaway user is one
  const others = (await rows("select id from app_users where active and id <> $1", [me.id])).map(
    (r) => r.id,
  );
  const model = await startModelStub();
  const { browser, page } = await openBrowser(email);
  try {
    await withDb((db) =>
      db.query("update app_users set active = false where id = any($1::uuid[])", [others]),
    );
    await withDb((db) =>
      db.query(
        "update shop_settings set ai_enabled = true, brain_on = false, brain_daily_per_rep = 4, ai_daily_cap_cents = 5000",
      ),
    );

    const off = await runJob();
    check(
      "with the brain switched off the job does nothing (no preparation, no model call)",
      off.status === 200 &&
        off.body.skipped === "the brain is off" &&
        model.calls.length === 0 &&
        (await one("select count(*)::int as n from brain_preps where user_id = $1", [me.id])).n ===
          0,
      JSON.stringify(off.body),
    );

    await withDb((db) => db.query("update shop_settings set brain_on = true"));
    const on = await runJob();
    const preps = await rows(
      "select kind, status, actions, summary, thread_id from brain_preps where user_id = $1 order by kind",
      [me.id],
    );
    check(
      "the job prepares the plan and up to three merchants, all ready with a saved conversation (database)",
      on.status === 200 &&
        on.body.prepared === preps.length &&
        preps.length >= 2 &&
        preps.length <= 4 &&
        preps.every((p) => p.status === "ready" && p.thread_id && p.summary.length > 5) &&
        preps.some((p) => p.kind === "plan"),
      JSON.stringify({ body: on.body, kinds: preps.map((p) => p.kind) }),
    );
    check(
      "every call was made on the model chosen in Settings (Sonnet 5.5) and logged against the cap",
      model.calls.length > 0 &&
        model.calls.every((c) => c.body.model === "claude-sonnet-5-5") &&
        (
          await one(
            "select count(*)::int as n from ai_runs where model = 'claude-sonnet-5-5' and created_at > now() - interval '5 minutes'",
          )
        ).n >= model.calls.length,
    );
    const again = await runJob();
    check(
      "running it again prepares nothing twice",
      again.body.queued === 0 && again.body.prepared === 0,
      JSON.stringify(again.body),
    );

    // ---- the rep's side
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const region = page.getByRole("region", { name: "Prepared for you" });
    await region.waitFor({ timeout: 8000 });
    const items = region.getByRole("listitem");
    const count = await items.count();
    check(
      "the Overview lists what was prepared, the plan first, each with its first lines",
      count === preps.length &&
        (await items.first().innerText()).includes("Your plan for today") &&
        /Review · \d+|Read/.test(await items.first().innerText()),
      `${count} items`,
    );
    const queueChip = await page
      .getByText(
        /Reply drafted|Nudge ready|Call brief ready|File checked|Documents reviewed|Catch-up ready/,
      )
      .count();
    check("a merchant on Do this now shows that it was prepared", queueChip >= 1);

    // open a merchant's preparation (not the plan): its buttons are live
    const merchantItem = items.filter({ hasNotText: "Your plan for today" }).first();
    await merchantItem.click();
    const panel = page.getByRole("dialog", { name: "Assistant" });
    await panel.waitFor();
    const callBtn = panel.getByRole("button", { name: /^Call .+ tomorrow/ });
    await callBtn.waitFor({ timeout: 15000 });
    check(
      "it opens in the assistant with its buttons live (not 'from an earlier conversation')",
      (await callBtn.isEnabled()) &&
        !(await panel.getByText("From an earlier conversation").count()),
    );
    const label = (await callBtn.innerText()).split("\n")[0];
    const business = /^Call (.+) tomorrow/.exec(label)?.[1];
    await callBtn.click();
    const moved = await until(async () => {
      const r = await one(
        "select 1 as ok from client_cards where business_name = $1 and (next_due_on - current_date) = 1",
        [business],
      );
      return Boolean(r);
    });
    check(
      `clicking it sets ${business}'s next follow-up to tomorrow (database)`,
      moved,
      moved
        ? ""
        : JSON.stringify({
            button: (await callBtn.innerText()).replace(/\s+/g, " "),
            rows: await rows(
              "select id, business_name, next_due_on::text from client_cards where business_name = $1",
              [business],
            ),
          }),
    );
    check(
      "opening it marked that preparation read; the others are still unread (database)",
      (
        await one(
          "select count(*) filter (where seen_at is not null)::int as seen, count(*)::int as n from brain_preps where user_id = $1",
          [me.id],
        )
      ).seen === 1,
    );
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    check(
      "the one that was read is gone from Prepared for you",
      (await page
        .getByRole("region", { name: "Prepared for you" })
        .getByRole("listitem")
        .count()) ===
        count - 1,
    );

    // ---- the manager's side
    await page.goto(`${BASE}/settings/ai`, { waitUntil: "networkidle" });
    const card = page.locator("section", { hasText: "The brain" }).first();
    check(
      "Settings → AI shows the brain on, with what it prepared in the last day",
      (await card.getByText("On", { exact: true }).count()) > 0 &&
        (await card.getByText("Prepared, last 24 h").count()) === 1,
    );
    const sw = page.getByRole("switch", { name: /Prepare the next step in the background/ });
    await sw.click();
    await page
      .getByRole("textbox", { name: /House rules for the assistant/ })
      .fill("Always offer a call first.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await until(async () => {
      const r = await one("select brain_on, playbook from shop_settings");
      return r.brain_on === false && r.playbook === "Always offer a call first.";
    });
    check("switching it off and writing house rules is stored (database)", saved);
  } finally {
    await browser.close();
    await withDb((db) =>
      db.query("update app_users set active = true where id = any($1::uuid[])", [others]),
    );
    await withDb((db) =>
      db.query(
        "update shop_settings set ai_enabled = $1, brain_on = $2, brain_daily_per_rep = $3, ai_daily_cap_cents = $4, playbook = $5",
        [
          settings.ai_enabled,
          settings.brain_on,
          settings.brain_daily_per_rep,
          settings.ai_daily_cap_cents,
          settings.playbook,
        ],
      ),
    );
    await model.close?.();
  }
}
