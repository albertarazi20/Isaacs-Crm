// The controls the finished deal backends were missing, each driven in the browser and then read back from the
// DATABASE: undo an AI update, chase drafts, the state badge, offer compare, reshop, eligible for more funds, stips
// that carry the lender's words, the application link, ask a manager, and the AI controls (ask, paste, screenshot).
// Run: CHROMIUM_PATH=... BASE_URL=http://localhost:3008 node e2e/run.mjs wire-deals
// The AI controls need a model. Without a key they are proved up to their disabled, explained state. With
// WIRE_AI=stub (dev server started with ANTHROPIC_API_KEY=sk-ant-stub ANTHROPIC_BASE_URL=http://127.0.0.1:4019) a local
// stand-in answers, and the whole path runs: see e2e/model-stub.mjs.
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";
import { startModelStub } from "./model-stub.mjs";

const STUB = process.env.WIRE_AI === "stub";
const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export default async function wireDeals({ email }) {
  const userId = (
    await withDb((db) => one(db, "select id from app_users where email = $1", [email]))
  ).id;
  const rows = (sql, params = []) => withDb((db) => db.query(sql, params).then((r) => r.rows));
  const val = async (sql, params = []) => (await rows(sql, params))[0];
  /** SQL as the signed-in user, so the functions that read app.current_user_id() work. */
  const asUser = (fn) =>
    withDb(async (db) => {
      await db.query("select set_config('app.user_id', $1, false)", [userId]);
      return fn(db);
    });
  const stamp = String(Date.now());
  let seq = 0;
  const merchants = await rows(
    `select id from clients where user_id = $1
        and stage in ('name_in', 'spoke_with_owner', 'interested', 'call_scheduled', 'application_sent', 'application_in', 'stips')
      order by business_name limit 16`,
    [userId],
  );
  const funderIds = [];
  const settings = await val("select ai_enabled, ai_daily_cap_cents from shop_settings");
  const ctt = await rows("select * from shop_registrations where state = 'CT'");

  const funder = async (name, over = {}) => {
    const f = await val(
      `insert into funders (user_id, name, submission_email, commission_points, excluded_states, min_monthly_revenue_cents)
       values ($1, $2, $3, $4, $5::text[], $6) returning id`,
      [
        userId,
        name,
        `subs-${funderIds.length}@${stamp}.test`,
        over.points ?? null,
        over.excluded ?? [],
        over.minRevenue ?? null,
      ],
    );
    funderIds.push(f.id);
    return f.id;
  };
  /** A merchant with its own phone and email, an open deal, and a lender row per funder. */
  const deal = async (name, { state = "FL", lenders = [] } = {}) => {
    const c = merchants.shift();
    if (!c) throw new Error("the seed has too few merchants for this suite");
    seq += 1;
    await rows(
      `update clients set business_name = $2, state = $3, phone = $4, email = $5, industry = 'Restaurant',
              monthly_revenue_cents = 4000000, time_in_business_months = 30 where id = $1`,
      [
        c.id,
        name,
        state,
        `305${String(1000000 + seq * 7919 + Number(stamp.slice(-4))).slice(-7)}`,
        `w3-${stamp}-${seq}@biz.test`,
      ],
    );
    const d = await asUser((db) =>
      one(db, "select id, number from submit_to_ops($1, 'new', 5000000, 'e2e')", [c.id]),
    );
    const subs = lenders.length
      ? await asUser((db) =>
          db
            .query("select id, funder_id from create_submissions($1, $2::uuid[])", [c.id, lenders])
            .then((r) => r.rows),
        )
      : [];
    return { clientId: c.id, name, dealId: d.id, number: d.number, subs };
  };
  /** True when the text (or locator) shows up in time; a missing one is a failed check, not a crash. */
  const sees = (loc, timeout = 12000) =>
    loc
      .first()
      .waitFor({ timeout })
      .then(
        () => true,
        () => false,
      );
  const login = (page) =>
    page.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`, {
      waitUntil: "networkidle",
    });
  const open = async (page, path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  };

  await setRole(email, "manager");
  const { browser, page } = await openBrowser(email, undefined, {
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    // ================= Review tray: Undo on an applied AI update =================
    const pearl = await funder("W3 Pearl", { points: 6 });
    const fora = await funder("W3 Fora", { points: 5 });
    const mDecl = await deal("W3 Undo Declined Co", { lenders: [pearl] });
    const mAppr = await deal("W3 Undo Approved Co", { lenders: [pearl] });
    const mKeep = await deal("W3 Ops Cannot Undo Co", { lenders: [pearl] });
    const apply = (m, event, payload, summary) =>
      asUser(async (db) => {
        const u = await one(
          db,
          `insert into proposed_updates (deal_id, submission_id, event, payload, evidence, confidence, status, summary)
           values ($1, $2, $3, $4::jsonb, '[]'::jsonb, 0.9, 'proposed', $5) returning id`,
          [m.dealId, m.subs[0].id, event, JSON.stringify(payload), summary],
        );
        await db.query("select apply_proposed_update($1)", [u.id]);
        return u.id;
      });
    const uDecl = await apply(
      mDecl,
      "declined",
      { decline_reason: "revenue", note: "too low" },
      "W3 Pearl declined: revenue too low",
    );
    const uAppr = await apply(
      mAppr,
      "approved",
      {
        amount_cents: 3000000,
        factor_rate: 1.28,
        payment_cents: 30000,
        frequency: "daily",
        term_days: 120,
      },
      "W3 Pearl approved $30,000 at 1.28",
    );
    await apply(
      mKeep,
      "declined",
      { decline_reason: "revenue" },
      "W3 Pearl declined the third file",
    );
    const pre = await val(
      `select (select status from submissions where id = $1) as declined, (select status from submissions where id = $2) as approved,
              (select count(*)::int from offers where id = (select created_offer_id from proposed_updates where id = $4)) as offer,
              (select previous_status from proposed_updates where id = $3) as was`,
      [mDecl.subs[0].id, mAppr.subs[0].id, uDecl, uAppr],
    );
    check(
      "setup: the AI declined one row and approved another with an offer",
      pre.declined === "declined" &&
        pre.approved === "approved" &&
        pre.offer === 1 &&
        pre.was === "sent",
      JSON.stringify(pre),
    );

    await open(page, "/board?tab=review");
    const rDecl = page.locator("[data-applied]", { hasText: "W3 Undo Declined Co" });
    const rAppr = page.locator("[data-applied]", { hasText: "W3 Undo Approved Co" });
    const declText = await rDecl.innerText();
    check(
      "the applied update names the status it replaced, and the status now",
      declText.includes("Before the update it was") &&
        declText.includes("Sent") &&
        declText.includes("now") &&
        declText.includes("Declined"),
      declText.replace(/\n/g, " | "),
    );
    check(
      "an update that added an offer says undoing removes it",
      (await rAppr.innerText()).includes("Also removes the offer it added"),
    );
    // two clicks, so a stray tap does nothing
    await rDecl.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(300);
    const stillDeclined = await val("select status from submissions where id = $1", [
      mDecl.subs[0].id,
    ]);
    check(
      "the first click only arms Undo: the row is unchanged",
      stillDeclined.status === "declined",
    );
    await rDecl.getByRole("button", { name: "Click again to undo" }).click();
    await page
      .getByText(/Undone — the lender row is back to what it was/)
      .first()
      .waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    const afterDecl = await val(
      `select s.status, s.decline_reason, p.status as update_status, p.reverted_by, p.reverted_at is not null as reverted,
              (select count(*)::int from activities a where a.client_id = $2 and a.body like 'Undid the AI update — W3 Pearl is back to sent%') as lines
         from submissions s, proposed_updates p where s.id = $1 and p.id = $3`,
      [mDecl.subs[0].id, mDecl.clientId, uDecl],
    );
    check(
      "Undo puts the lender row back in the database and writes the timeline line",
      afterDecl.status === "sent" &&
        afterDecl.decline_reason === null &&
        afterDecl.update_status === "reverted" &&
        afterDecl.reverted_by === userId &&
        afterDecl.reverted &&
        afterDecl.lines === 1,
      JSON.stringify(afterDecl),
    );
    await rAppr.getByRole("button", { name: "Undo" }).click();
    await rAppr.getByRole("button", { name: "Click again to undo" }).click();
    await page.waitForTimeout(1200);
    const afterAppr = await val(
      `select s.status, (select count(*)::int from offers where submission_id = s.id) as offers, p.status as update_status
         from submissions s, proposed_updates p where s.id = $1 and p.id = $2`,
      [mAppr.subs[0].id, uAppr],
    );
    check(
      "undoing an approval removes the offer it added",
      afterAppr.status === "sent" &&
        afterAppr.offers === 0 &&
        afterAppr.update_status === "reverted",
      JSON.stringify(afterAppr),
    );
    await open(page, "/board?tab=review");
    check(
      "an undone update stays listed as undone, with no Undo button",
      (await page.locator("[data-applied-status='reverted']").count()) >= 2 &&
        (await page
          .locator("[data-applied-status='reverted']")
          .first()
          .getByRole("button", { name: "Undo" })
          .count()) === 0,
    );

    // ================= Review tray: chase drafts =================
    const mChase = await deal("W3 Chase Draft Co", { lenders: [pearl, fora] });
    const draftBody = (name, n) =>
      `${name} has been quiet for 2 business days. Send this from the thread:\n\nTo: subs@w3-${stamp}.test\nSubject: Re: [D-${n}] W3 Chase Draft Co\n\nHi ${name} team,\n\nAny update on W3 Chase Draft Co (D-${n})? Happy to send anything else you need.\n\nThanks,\nRep`;
    const draft = async (sub, name) =>
      (
        await val(
          `insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
           values ($1, 'chase_draft', $2, $3, $4, $5, $6, $7) returning id::text as id`,
          [
            userId,
            mChase.clientId,
            mChase.dealId,
            `Chase ${name} on D-${mChase.number}`,
            draftBody(name, mChase.number),
            `/deals/${mChase.dealId}`,
            `chase_draft:${sub}:1`,
          ],
        )
      ).id;
    const dSend = await draft(mChase.subs[0].id, "W3 Pearl");
    const dDismiss = await draft(mChase.subs[1].id, "W3 Fora");
    await rows("select set_submission_status($1, 'sent')", [mChase.subs[0].id]).catch(
      () => undefined,
    );
    const mMoot = await deal("W3 Answered Since Co", { lenders: [pearl] });
    await asUser((db) =>
      db.query("select set_submission_status($1, 'declined', 'revenue', '')", [mMoot.subs[0].id]),
    );
    const dMoot = await draft(mMoot.subs[0].id, "W3 Pearl");
    await rows("update user_alerts set client_id = $2, deal_id = $3 where id = $1::bigint", [
      dMoot,
      mMoot.clientId,
      mMoot.dealId,
    ]);
    const chaseBefore = await val(
      "select chase_count, last_chased_at from submissions where id = $1",
      [mChase.subs[0].id],
    );

    await open(page, "/board?tab=review");
    const draftRows = page.locator("[data-chase-draft]");
    check(
      "the Review tray lists the chase drafts with their nudge text",
      (await draftRows.count()) >= 3 &&
        (await draftRows.first().innerText()).includes("Any update on W3 Chase Draft Co"),
    );
    const rMoot = page.locator(`[data-chase-id='${dMoot}']`);
    check(
      "a draft for a lender that answered since can only be dismissed",
      (await rMoot.innerText()).includes("answered since") &&
        (await rMoot.getByRole("button", { name: "Send" }).count()) === 0,
    );
    // Send: nothing is connected to Google here, so it refuses in words, and nothing changes
    const rSend = page.locator(`[data-chase-id='${dSend}']`);
    await rSend.getByRole("button", { name: "Send" }).click();
    check(
      "a refused Send says why, in words",
      await sees(page.getByText(/Google isn't set up on this server|Gmail isn't connected/), 8000),
    );
    const afterSend = await val(
      "select s.chase_count, s.last_chased_at, (select read_at from user_alerts where id = $2::bigint) as read_at from submissions s where s.id = $1",
      [mChase.subs[0].id, dSend],
    );
    check(
      "a refused Send changes nothing: the draft stays and the chase count is untouched",
      afterSend.read_at === null && afterSend.chase_count === chaseBefore.chase_count,
      JSON.stringify(afterSend),
    );
    const rFora = page.locator(`[data-chase-id='${dDismiss}']`);
    await rFora.getByRole("button", { name: "Copy" }).click();
    await page.getByText(/Chase copied/).waitFor({ timeout: 5000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(
      "Copy puts To, Subject and the nudge on the clipboard",
      clip.startsWith("To: ") &&
        clip.includes("Subject: Re: [D-") &&
        clip.includes("Any update on W3 Chase Draft Co"),
    );
    await rFora.getByRole("button", { name: "Dismiss" }).click();
    await page.getByText("Draft dismissed").waitFor({ timeout: 8000 });
    await page.waitForTimeout(400);
    const dismissed = await val(
      "select read_at is not null as read from user_alerts where id = $1::bigint",
      [dDismiss],
    );
    check("Dismiss marks the alert read in the database", dismissed.read === true);
    await open(page, "/board?tab=review");
    check(
      "a dismissed draft leaves the tray",
      (await page.locator(`[data-chase-id='${dDismiss}']`).count()) === 0,
    );

    // ================= the state badge and warnings in the deal header =================
    const stateDeal = await deal("W3 State Co", { state: "TX" });
    const badgeOf = async (state) => {
      await rows("update clients set state = $2 where id = $1", [stateDeal.clientId, state]);
      await open(page, `/deals/${stateDeal.dealId}`);
      const b = page.locator("[data-state-badge]");
      return {
        tone: await b.getAttribute("data-state-badge"),
        text: await b.innerText(),
        warnings: await page
          .getByRole("list", { name: "State rules" })
          .innerText()
          .catch(() => ""),
      };
    };
    await rows("delete from shop_registrations where state = 'CT'");
    const ctNone = await badgeOf("CT");
    check(
      "a state that needs broker registration, with none on file, stops: badge and warning",
      ctNone.tone === "stop" &&
        ctNone.text === "CT · not registered" &&
        /requires broker registration and the shop has none on file/.test(ctNone.warnings),
      JSON.stringify(ctNone),
    );
    await rows(
      "insert into shop_registrations (state, registration_no, status, renews_on) values ('CT', 'E2E-1', 'registered', current_date + 400)",
    );
    const ctOk = await badgeOf("CT");
    check(
      "registered, the badge says so and keeps the disclosure warning",
      ctOk.tone === "watch" &&
        ctOk.text === "CT · registered" &&
        /disclosure must be signed/.test(ctOk.warnings),
      JSON.stringify(ctOk),
    );
    const fl = await badgeOf("fl");
    check(
      "a free-text state reads as its code: FL carries the fee rule",
      fl.text === "FL · fee rule" && /No fee may be collected before closing/.test(fl.warnings),
      JSON.stringify(fl),
    );
    const bad = await badgeOf("Narnia");
    check(
      "an unknown state is said plainly",
      bad.tone === "none" &&
        bad.text === "Unknown state: Narnia" &&
        /not a state we know/.test(bad.warnings),
      JSON.stringify(bad),
    );
    await rows("delete from shop_registrations where state = 'CT'");
    for (const r of ctt) {
      await rows(
        "insert into shop_registrations (state, registration_no, status, renews_on, note) values ($1, $2, $3, $4, $5)",
        [r.state, r.registration_no, r.status, r.renews_on, r.note],
      );
    }

    // ================= Lenders & offers: offer compare =================
    const lA = await funder("W3 Alpha", { points: 6 });
    const lB = await funder("W3 Bravo", { points: 5 });
    const mCmp = await deal("W3 Compare Co", { lenders: [lA, lB] });
    await asUser(async (db) => {
      await db.query("select record_offer($1, $2::jsonb)", [
        mCmp.subs.find((s) => s.funder_id === lA).id,
        JSON.stringify({
          amount_cents: 5000000,
          factor_rate: 1.3,
          payment_cents: 45000,
          frequency: "daily",
          term_days: 130,
          fees_cents: 50000,
        }),
      ]);
      await db.query("select record_offer($1, $2::jsonb)", [
        mCmp.subs.find((s) => s.funder_id === lB).id,
        JSON.stringify({
          amount_cents: 4000000,
          factor_rate: 1.25,
          frequency: "weekly",
          term_days: 182,
        }),
      ]);
    });
    await open(page, `/deals/${mCmp.dealId}?tab=offers`);
    const rA = page.locator("[data-compare-row='W3 Alpha']");
    const rB = page.locator("[data-compare-row='W3 Bravo']");
    const a = await rA.innerText();
    const b = await rB.innerText();
    const dbOffers = await rows(
      "select o.amount_cents::bigint as amount, o.factor_rate::float as factor from offers o where o.deal_id = $1 order by o.factor_rate desc",
      [mCmp.dealId],
    );
    const paybackOf = (o) => Math.round(Number(o.amount) * o.factor);
    check(
      "the database holds the two offers the compare table is built from",
      dbOffers.length === 2 &&
        paybackOf(dbOffers[0]) === 6_500_000 &&
        paybackOf(dbOffers[1]) === 5_000_000,
      JSON.stringify(dbOffers),
    );
    check(
      "Alpha: payback, cost, payments, fees, net to merchant and commission are worked out",
      a.includes("$65,000") &&
        a.includes("costs $15,000") &&
        a.includes("145 × $450 daily") &&
        a.includes("$500") &&
        a.includes("$49,500") &&
        a.includes("$3,000 · 6 pts"),
      a.replace(/\n/g, " | "),
    );
    check(
      "Bravo: no payment given, so the count comes from the term; no fees means net equals the advance",
      b.includes("$50,000") &&
        b.includes("costs $10,000") &&
        b.includes("about 26 weekly") &&
        b.includes("$40,000") &&
        b.includes("$2,000 · 5 pts"),
      b.replace(/\n/g, " | "),
    );
    check(
      "the lowest factor carries the word Best, and only it",
      (await rB.getAttribute("data-best")) === "true" && b.includes("Best") && !a.includes("Best"),
    );
    check(
      "no reshop panel on a deal that is not declined by everyone",
      (await page.getByRole("heading", { name: "Reshop" }).count()) === 0,
    );

    // ================= Lenders & offers: reshop =================
    await funder("W3 Fits");
    await funder("W3 Wrong State", { excluded: ["FL"] });
    await funder("W3 Needs Revenue", { minRevenue: 999_999_999 });
    const mRes = await deal("W3 Reshop Co", { lenders: [lA, lB] });
    for (const s of mRes.subs)
      await asUser((db) =>
        db.query("select set_submission_status($1, 'declined', 'revenue', '')", [s.id]),
      );
    const status = await val("select app.deal_status(d) as s from deals d where id = $1", [
      mRes.dealId,
    ]);
    check("setup: every lender declined", status.s === "declined_by_all", status.s);
    await open(page, `/deals/${mRes.dealId}?tab=offers`);
    const names = await page
      .locator("[data-reshop-candidate]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-reshop-candidate")));
    check(
      "reshop lists the lenders that fit and have not seen the file",
      names.includes("W3 Fits") &&
        !names.includes("W3 Wrong State") &&
        !names.includes("W3 Needs Revenue") &&
        !names.includes("W3 Alpha") &&
        !names.includes("W3 Bravo"),
      names.join(", "),
    );
    await page.getByRole("button", { name: "Start reshop" }).first().click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor();
    check(
      "a confirm says what reshop does",
      (await dlg.innerText()).includes("closes D-" + mRes.number),
    );
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(400);
    const untouched = await val("select outcome from deals where id = $1", [mRes.dealId]);
    check("Cancel leaves the deal open", untouched.outcome === "open");
    await page.getByRole("button", { name: "Start reshop" }).first().click();
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Start reshop" }).click();
    await page.getByText(/Reshop started/).waitFor({ timeout: 10000 });
    await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/, { timeout: 10000 });
    const newId = page.url().split("/").pop();
    const rs = await val(
      `select (select outcome from deals where id = $1) as old_outcome, (select outcome_reason from deals where id = $1) as why,
              (select kind from deals where id = $2) as new_kind, (select client_id from deals where id = $2) as new_client,
              (select requested_cents::bigint from deals where id = $2) as asked,
              (select count(*)::int from deals where client_id = $3 and outcome = 'open') as open_deals,
              (select count(*)::int from stips where client_id = $3 and kind = 'bank_statement' and required and received_at is null) as newest_wanted,
              (select count(*)::int from activities where client_id = $3 and body like 'Reshop: deal D-% opened from D-' || $4 || ' with the same ask') as lines`,
      [mRes.dealId, newId, mRes.clientId, String(mRes.number)],
    );
    check(
      "reshop closes the old deal, opens a new one with the same ask, and asks for the newest statement",
      rs.old_outcome === "declined" &&
        rs.why === "Reshopped as a new deal" &&
        rs.new_kind === "reshop" &&
        rs.new_client === mRes.clientId &&
        Number(rs.asked) === 5_000_000 &&
        rs.open_deals === 1 &&
        rs.newest_wanted >= 1 &&
        rs.lines === 1,
      JSON.stringify(rs),
    );
    check(
      "the new deal's page opens on its blocker",
      (await page.locator("main").innerText()).includes("Reshop"),
    );

    // ================= Eligible for more funds (a rep's My Deals) =================
    const lF = await funder("W3 Funded Lender", { points: 6 });
    const fundOne = async (name, eligibleOffset) => {
      const m = await deal(name, { lenders: [lF] });
      await asUser(async (db) => {
        await db.query("select record_offer($1, $2::jsonb)", [
          m.subs[0].id,
          JSON.stringify({
            amount_cents: 4000000,
            factor_rate: 1.3,
            payment_cents: 40000,
            frequency: "daily",
          }),
        ]);
        const f = await one(db, "select id from propose_funding($1, $2::jsonb)", [
          m.clientId,
          JSON.stringify({
            funder_id: lF,
            funded_on: new Date().toISOString().slice(0, 10),
            amount_cents: 4000000,
            sell_rate: 1.3,
            payment_cents: 40000,
            frequency: "daily",
            term_days: 120,
            position_no: 1,
            psf_cents: 0,
            psf_collected_at: "at_closing",
            timers: [
              {
                kind: "check_in",
                due_on: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
                note: "Remittances clearing?",
              },
            ],
          }),
        ]);
        await db.query("select confirm_funding($1)", [f.id]);
        await db.query(
          "update fundings set renewal_eligible_on = current_date + $2::int where id = $1",
          [f.id, eligibleOffset],
        );
      });
      return m;
    };
    const eligible = await fundOne("W3 Eligible Co", -1);
    const notYet = await fundOne("W3 Not Yet Co", 20);
    await setRole(email, "rep");
    await login(page);
    await open(page, "/deals");
    const chip = page
      .getByRole("navigation", { name: "Filter" })
      .getByRole("link", { name: /Eligible for more funds/ });
    const inDb = await val(
      `select count(*)::int as n from deals d where d.user_id = $1 and d.outcome = 'funded'
          and exists (select 1 from fundings f where f.deal_id = d.id and f.status = 'active' and f.renewal_eligible_on is not null and f.renewal_eligible_on <= current_date)`,
      [userId],
    );
    check(
      "My Deals has the Eligible for more funds chip with the count the database gives",
      inDb.n === 1 &&
        (await chip.innerText()).replace(/\s+/g, " ").trim() ===
          `Eligible for more funds ${inDb.n}`,
      `${inDb.n} · ${await chip.innerText()}`,
    );
    await chip.click();
    await page.waitForURL(/f=more_funds/);
    await page.waitForLoadState("networkidle");
    const list = await page.locator("main").innerText();
    check(
      "the chip lists the merchant paid down to the renewal line, and not the other",
      list.includes("W3 Eligible Co") && !list.includes("W3 Not Yet Co"),
      list.slice(0, 160).replace(/\n/g, " | "),
    );
    void eligible;
    void notYet;

    // ================= Overview: a stip of kind "other" shows its label =================
    await setRole(email, "manager");
    await login(page);
    const mStip = await deal("W3 Stips Co");
    await rows(
      `insert into stips (user_id, client_id, kind, required, label) values ($1, $2, 'other', true, 'Landlord letter on letterhead')
       on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do update set label = excluded.label, required = true`,
      [userId, mStip.clientId],
    );
    await open(page, `/deals/${mStip.dealId}`);
    const overview = await page.locator("main").innerText();
    check(
      "a stip of kind other is shown by the lender's own words, not as Other document",
      overview.includes("Still missing:") &&
        overview.includes("Landlord letter on letterhead") &&
        !/Still missing:[^\n]*Other document/.test(overview),
      overview.match(/Still missing:[^\n]*/)?.[0],
    );

    // ================= Documents: the application link and the latest signed application =================
    const token = (
      await val("select application_token from clients where id = $1", [mStip.clientId])
    ).application_token;
    await open(page, `/deals/${mStip.dealId}?tab=documents`);
    const link = `${BASE.replace(/\/$/, "")}/apply/${token}`;
    const shown = await page.locator("code").first().innerText();
    check(
      "the Documents tab shows the application link built from the merchant's token",
      shown.includes(`/apply/${token}`),
      shown,
    );
    check(
      "no signed application yet, and it says so",
      (await page.locator("main").innerText()).includes("Not signed yet."),
    );
    await page.getByRole("button", { name: "Copy application link" }).click();
    await page.getByText("Application link copied").waitFor({ timeout: 5000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(
      "Copy application link puts the link on the clipboard",
      copied.endsWith(`/apply/${token}`),
      copied,
    );
    const doc = await val(
      `insert into documents (user_id, client_id, deal_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status)
       values ($1, $2, $3, 'signed_application', 'application-e2e.pdf', 'application/pdf', 1234, $4, $5, 'upload_link', 'clean') returning id`,
      [userId, mStip.clientId, mStip.dealId, "a".repeat(64), `e2e/${stamp}/application.pdf`],
    );
    await rows(
      `insert into applications (client_id, user_id, deal_id, document_id, fields, signer_name) values ($1, $2, $3, $4, '{}'::jsonb, 'Pat Owner')`,
      [mStip.clientId, userId, mStip.dealId, doc.id],
    );
    await open(page, `/deals/${mStip.dealId}?tab=documents`);
    const pdf = page.getByRole("link", { name: "Open PDF" });
    check(
      "the latest signed application shows who signed, with its PDF",
      (await page.locator("main").innerText()).includes("Signed by Pat Owner") &&
        (await pdf.getAttribute("href")) === `/api/docs/${doc.id}`,
    );
    void link;

    // ================= Activity: Ask manager =================
    const mAsk = await deal("W3 Ask Co", { lenders: [pearl] });
    await rows("update deals set blocker = '' where id = $1", [mAsk.dealId]);
    await asUser((db) =>
      db.query("select set_submission_status($1, 'declined', 'revenue', 'too low')", [
        mAsk.subs[0].id,
      ]),
    );
    for (let i = 0; i < 40; i += 1)
      await rows(
        "insert into activities (user_id, client_id, kind, body, occurred_at) values ($1, $2, 'note', $3, now() + make_interval(mins => $4::int))",
        [userId, mAsk.clientId, `E2E filler note number ${i} about nothing in particular`, i + 1],
      );
    await open(page, `/deals/${mAsk.dealId}?tab=activity`);
    const managers = await val(
      "select count(*)::int as n from app_users where role = 'manager' and active",
    );
    await page
      .getByPlaceholder("What do you need from them?")
      .fill("Can we push Pearl for a faster answer?");
    await page.getByRole("button", { name: "Ask manager" }).click();
    await page.getByText(/Asked \d+ managers? — they got an alert/).waitFor({ timeout: 8000 });
    const alerts = await val(
      `select count(*)::int as n, bool_and(body like 'Can we push Pearl for a faster answer?%') as ok, bool_and(deal_id = $1) as deal
         from user_alerts where kind = 'ask_manager' and deal_id = $1`,
      [mAsk.dealId],
    );
    check(
      "Ask manager writes one alert per manager, with the question and the deal's context",
      alerts.n === managers.n && alerts.ok && alerts.deal,
      JSON.stringify({ alerts, managers }),
    );
    const askedLine = await val(
      "select count(*)::int as n from activities where client_id = $1 and body like '%asked a manager: Can we push Pearl%'",
      [mAsk.clientId],
    );
    check("and a line on the merchant's timeline", askedLine.n === 1);
    check(
      "the question box is empty again",
      (await page.getByPlaceholder("What do you need from them?").inputValue()) === "",
    );

    // ================= the AI controls =================
    if (!STUB) {
      const box = page.getByPlaceholder("Where does this deal stand?");
      check("without a key the Ask box is disabled", await box.isDisabled());
      check(
        "and it says why, in plain words",
        (await page.locator("main").innerText()).includes(
          "The AI isn't set up yet: this server has no Anthropic key",
        ),
      );
      check(
        "the Ask button is disabled too",
        await page.getByRole("button", { name: "Ask", exact: true }).isDisabled(),
      );
      await open(page, `/deals/${mAsk.dealId}?tab=offers`);
      check(
        "Import from lender is there for a manager",
        await page.getByRole("heading", { name: "Import from lender" }).isVisible(),
      );
      check(
        "its paste box and drop zone are disabled and explained",
        (await page.getByPlaceholder("The offer page or email, as plain text").isDisabled()) &&
          (await page.getByLabel("Screenshot of the lender's page").isDisabled()) &&
          (await page.locator("[data-ai-blocked]").innerText()).includes("no Anthropic key"),
      );
      check(
        "the Read the text button is disabled",
        await page.getByRole("button", { name: "Read the text" }).isDisabled(),
      );
    } else {
      const stub = await startModelStub();
      const askBox = page.getByPlaceholder("Where does this deal stand?");
      const askBtn = page.getByRole("button", { name: "Ask", exact: true });
      await askBox.fill("Where does this deal stand?");
      await page.evaluate(() => window.scrollTo(0, 0));
      await askBtn.click();
      await page.locator("[data-ask-answer]").waitFor({ timeout: 15000 });
      const ans = await page.locator("[data-ask-answer]").innerText();
      check(
        "the answer comes back with its confidence",
        ans.includes("High confidence") && ans.includes("It was sent out"),
        ans.replace(/\n/g, " | "),
      );
      const links = page.locator("[data-cite-link]");
      check(
        "and with citations that point at timeline events",
        (await links.count()) >= 1,
        String(await links.count()),
      );
      const runs = await val(
        "select count(*)::int as n, bool_and(error is null) as ok from ai_runs where purpose = 'ask_deal' and deal_id = $1",
        [mAsk.dealId],
      );
      check(
        "the question is logged as an AI run in the database",
        runs.n === 1 && runs.ok,
        JSON.stringify(runs),
      );
      const target = await links.first().getAttribute("data-cite-link");
      const before = await page.evaluate(() => window.scrollY);
      await links.first().click();
      await page.waitForTimeout(900);
      const lit = await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          cited: el.dataset.cited,
          inView: r.top >= 0 && r.bottom <= window.innerHeight,
          scrolled: window.scrollY,
          text: el.innerText.slice(0, 60),
        };
      }, target);
      check(
        "a citation scrolls to the timeline row it cites and lights it",
        lit !== null && lit.cited === "true" && lit.inView && lit.scrolled !== before,
        JSON.stringify({ target, before, lit }),
      );
      await page.waitForTimeout(3200);
      check(
        "the highlight fades",
        (await page.evaluate(
          (id) => document.getElementById(id)?.dataset.cited ?? "gone",
          target,
        )) === "gone",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await askBox.fill("What is the favourite colour of the owner? (unknowable)");
      await askBtn.click();
      await page.getByText("The timeline does not say.").waitFor({ timeout: 15000 });
      check(
        "when the timeline does not say, the answer says that and cites nothing",
        (await page.locator("[data-ask-answer='unknown']").count()) === 1 &&
          (await page.locator("[data-cite-link]").count()) === 0,
      );
      await askBox.fill("Where does this deal stand? bogus");
      await askBtn.click();
      await page.getByText(/could not be checked and was left out/).waitFor({ timeout: 15000 });
      check(
        "a citation the checker cannot verify is dropped and the answer says so",
        (await page.locator("[data-cite-link]").count()) >= 1,
      );
      // refusals: the kill switch and the spend cap, flipped after the page loaded
      await rows("update shop_settings set ai_enabled = false");
      await askBox.fill("Where does this deal stand?");
      await askBtn.click();
      check(
        "the kill switch refuses in words",
        await sees(page.getByText("The AI is switched off in Settings"), 10000),
      );
      await rows("update shop_settings set ai_enabled = $1, ai_daily_cap_cents = 0", [
        settings.ai_enabled,
      ]);
      await askBtn.click();
      check(
        "the spend cap refuses in words",
        await sees(page.getByText(/Today's AI spend cap is used up/), 10000),
      );
      await rows("update shop_settings set ai_daily_cap_cents = $1", [settings.ai_daily_cap_cents]);
      await open(page, `/deals/${mAsk.dealId}?tab=activity`);
      await rows("update shop_settings set ai_enabled = false");
      await open(page, `/deals/${mAsk.dealId}?tab=activity`);
      check(
        "with the AI switched off the page says so and disables the box",
        (await page.getByPlaceholder("Where does this deal stand?").isDisabled()) &&
          (await page.locator("main").innerText()).includes("The AI is switched off in Settings."),
      );
      await rows("update shop_settings set ai_enabled = $1", [settings.ai_enabled]);

      // Import from lender: paste, then a screenshot
      await open(page, `/deals/${mAsk.dealId}?tab=offers`);
      await page.getByLabel("Which lender (optional)").selectOption({ label: "W3 Pearl" });
      await page
        .getByPlaceholder("The offer page or email, as plain text")
        .fill("Thanks for the update everyone, have a lovely day and talk to you all soon.");
      await page.getByRole("button", { name: "Read the text" }).click();
      check(
        "text with no lender update is refused in words",
        await sees(page.getByText("Nothing in that text reads as a lender update"), 15000),
      );
      check(
        "and nothing lands in the tray",
        (
          await val(
            "select count(*)::int as n from proposed_updates where deal_id = $1 and source = 'pasted'",
            [mAsk.dealId],
          )
        ).n === 0,
      );
      await page
        .getByPlaceholder("The offer page or email, as plain text")
        .fill(
          "Hello, W3 Pearl here. After review we have to decline this deal. Monthly revenue is too low for our program.",
        );
      await page.getByRole("button", { name: "Read the text" }).click();
      await page.getByText("In the Review tray").first().waitFor({ timeout: 15000 });
      const pasted = await val(
        `select count(*)::int as n, bool_and(status = 'proposed') as proposed, bool_and(event = 'declined') as declined, bool_and(submission_id = $2) as sub,
                (select count(*)::int from ai_runs where purpose = 'read_pasted_offer' and deal_id = $1) as runs
           from proposed_updates where deal_id = $1 and source = 'pasted'`,
        [mAsk.dealId, mAsk.subs[0].id],
      );
      check(
        "pasted text lands as a proposed update on that lender row, logged, applied to nothing",
        pasted.n === 1 && pasted.proposed && pasted.declined && pasted.sub && pasted.runs === 1,
        JSON.stringify(pasted),
      );
      check(
        "and the page links to the Review tray",
        (await page.getByRole("link", { name: "Open the Review tray" }).getAttribute("href")) ===
          "/board?tab=review",
      );
      await page
        .getByLabel("Screenshot of the lender's page")
        .setInputFiles({ name: "portal.png", mimeType: "image/png", buffer: PNG });
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-import-landed]").length > 0 &&
          document.querySelector("[data-import-landed]")?.getAttribute("data-import-landed") ===
            "screenshot",
        null,
        { timeout: 20000 },
      );
      const shot = await val(
        `select (select count(*)::int from proposed_updates where deal_id = $1 and source = 'pasted') as proposals,
                (select count(*)::int from ai_runs where purpose = 'transcribe_offer_image' and deal_id = $1) as transcripts`,
        [mAsk.dealId],
      );
      check(
        "a dropped screenshot is transcribed, read, and lands in the tray too",
        shot.proposals === 2 && shot.transcripts === 1,
        JSON.stringify(shot),
      );
      await open(page, "/board?tab=review");
      check(
        "both imports are in the Review tray, waiting for a manager's yes",
        (await page.locator("main").innerText()).split("W3 Ask Co").length - 1 >= 2,
      );
      // the AI service goes away: the toast says so
      await stub.close();
      await open(page, `/deals/${mAsk.dealId}?tab=activity`);
      await page
        .getByPlaceholder("Where does this deal stand?")
        .fill("Where does this deal stand?");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      check(
        "an unreachable AI service is a plain-words toast",
        await sees(page.getByText(/Couldn't reach the AI service/), 30000),
      );
    }

    // ================= who sees what =================
    await open(page, `/deals/${mAsk.dealId}?tab=offers`);
    check(
      "a manager sees Import from lender",
      (await page.getByRole("heading", { name: "Import from lender" }).count()) === 1,
    );
    await setRole(email, "rep");
    await login(page);
    await open(page, `/deals/${mAsk.dealId}?tab=offers`);
    check(
      "a rep does not see Import from lender",
      (await page.getByRole("heading", { name: "Import from lender" }).count()) === 0,
    );
    await setRole(email, "ops");
    await login(page);
    await open(page, "/board?tab=review");
    const opsTray = await page.locator("main").innerText();
    check(
      "a signed-in user who is not a manager sees the applied list with no Undo (the deal's own owner here)",
      opsTray.includes("W3 Ops Cannot Undo Co") &&
        (await page.getByRole("button", { name: "Undo" }).count()) === 0 &&
        opsTray.includes("manager undoes"),
    );
  } finally {
    await browser.close();
    // a proposed update outlives its deal's cascade (its own foreign keys), so it goes first
    await rows(
      "delete from proposed_updates where deal_id in (select id from deals where user_id = $1)",
      [userId],
    );
    await rows("update shop_settings set ai_enabled = $1, ai_daily_cap_cents = $2", [
      settings.ai_enabled,
      settings.ai_daily_cap_cents,
    ]);
    await rows("delete from shop_registrations where state = 'CT'");
    for (const r of ctt)
      await rows(
        "insert into shop_registrations (state, registration_no, status, renews_on, note) values ($1, $2, $3, $4, $5) on conflict do nothing",
        [r.state, r.registration_no, r.status, r.renews_on, r.note],
      );
    for (const id of funderIds)
      await rows("delete from funders where id = $1", [id]).catch(() => undefined);
  }
}
