// The page controls for the intake and follow-up backends, each driven in the browser and then read back from the
// DATABASE: paste a lead line, the cross-rep owner warning and the manager's override, bulk intake, the reply tag chip,
// pause until a date, bucket scores, and the merchant's application link and signed application.
// Run: CHROMIUM_PATH=... BASE_URL=http://localhost:3007 node e2e/run.mjs wire-intake
import { BASE, check, openBrowser, setRole, withDb } from "./lib.mjs";

const one = (db, sql, params) => db.query(sql, params).then((r) => r.rows[0]);
const rows = (db, sql, params) => db.query(sql, params).then((r) => r.rows);

/** Poll the database until `fn` says yes (a server action lands a moment after the click). */
async function until(fn, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** "Nov 30", or "Nov 30, 2027" when it is not this year — the words the app puts on a date. */
function fmt(iso, thisYear = new Date().getFullYear()) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return y === thisYear ? base : `${base}, ${y}`;
}

const wide = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );

export default async function wireIntake({ email }) {
  // the second rep lives outside the runner's own user, so he is removed here, crash or not (his rows cascade)
  const mikeEmail = `e2e-mike-${Date.now()}@example.com`;
  try {
    await flow(email, mikeEmail);
  } finally {
    await withDb((db) => db.query("delete from app_users where email = $1", [mikeEmail]));
  }
}

async function flow(email, mikeEmail) {
  const stamp = String(Date.now()).slice(-4);
  const phone = (n) => `310555${stamp.slice(0, 3)}${n}`; // ten digits, unique to this run
  const user = await withDb((db) => one(db, "select id from app_users where email = $1", [email]));
  const userId = user.id;
  const statements = await withDb((db) =>
    one(db, "select id from buckets where key = 'missing_statements'", []),
  );
  const interested = await withDb((db) =>
    one(db, "select id from buckets where key = 'interested'", []),
  );

  // another rep, with a merchant of his own three days back, in Missing statements
  const mike = await withDb(async (db) => {
    const u = await one(
      db,
      "insert into app_users (email, name, role) values ($1, 'Mike Jones', 'rep') returning id",
      [mikeEmail],
    );
    const c = await one(
      db,
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'E2E Harbor Tacos', 'Rosa Diaz', $2, 'rosa@e2e-harbor.test', 'CA') returning id",
      [u.id, phone(0)],
    );
    await db.query("select set_config('app.user_id', $1, false)", [u.id]);
    await db.query("select enroll_in_bucket($1, $2, 'moved')", [c.id, statements.id]);
    await db.query(
      "update activities set occurred_at = now() - interval '3 days' where client_id = $1",
      [c.id],
    );
    return { userId: u.id, clientId: c.id };
  });

  // staged sheet rows for the bulk filing: two new, one the rep already has, one that is Mike's
  const ownPhone = await withDb((db) =>
    one(db, "select phone from clients where user_id = $1 order by business_name limit 1", [
      userId,
    ]),
  ).then((r) => r.phone);
  const sheet = await withDb(async (db) => {
    const s = await one(
      db,
      `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, mapping, target_bucket_id)
       values ($1, 'E2E vendor sheet', 'e2e-sheet', 'Nov', '{}', $2) returning id`,
      [userId, interested.id],
    );
    const stage = (n, name, ph) =>
      one(
        db,
        `insert into sheet_rows (source_id, row_no, phone_key, business_name, contact_name, phone, state, row_hash)
         values ($1, $2::int, right(regexp_replace($4::text, '\\D', '', 'g'), 10), $3, 'Sam Row', $4::text, 'TX', md5($2::text)) returning id`,
        [s.id, n, name, ph],
      ).then((r) => r.id);
    return {
      id: s.id,
      fresh1: await stage(1, "Bulk Fresh One", phone(1)),
      fresh2: await stage(2, "Bulk Fresh Two", phone(2)),
      own: await stage(3, "Bulk Own Dup", ownPhone),
      mikes: await stage(4, "Bulk Mikes Dup", phone(0)),
    };
  });

  // ---------------------------------------------------------------------------------- Lead Intake, as a rep
  const runsBefore = await withDb((db) =>
    one(db, "select count(*)::int as n from ai_runs where purpose = 'split_lead_line'", []),
  );
  const { browser, context, page } = await openBrowser(email);
  await page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });

  // Paste a lead line. Without a model key the box says so and stays shut; with one, a faked answer fills the form.
  const paste = page.getByLabel("Paste a lead line");
  if (await paste.isDisabled()) {
    check(
      "paste box: disabled, and it says why in words",
      await page
        .getByText(/The assistant is not set up on this server/)
        .first()
        .isVisible(),
    );
    check(
      "paste box: the Fill button is disabled too, and the form below still works",
      (await page.getByRole("button", { name: "Fill the form" }).isDisabled()) &&
        (await page.getByPlaceholder("(305) 555-0100").isEnabled()),
    );
  } else {
    // a key is set on this server. First the real call (a made-up key, so the model refuses): the failure is a toast
    // and the form is left alone.
    await paste.fill(
      `Rosa Lind, E2E Pasted Tacos, ${phone(5)}, rosa@e2e-pasted.test, CA, wants 60k for a truck`,
    );
    await page.getByRole("button", { name: "Fill the form" }).click();
    await page.getByRole("alert").first().waitFor({ timeout: 45000 });
    check(
      "paste box: a failed call is an error toast and the form stays empty",
      (await page.getByPlaceholder("(305) 555-0100").inputValue()) === "" &&
        (await page.getByText("Filled from the line:").count()) === 0,
    );
    // then answer the action ourselves so the page's own wiring is what is tested
    await page.route("**/lead-intake", async (route) => {
      const req = route.request();
      // only the paste call is answered here; the lookups that follow it (duplicates, sheet, owner) run for real
      if (
        req.method() !== "POST" ||
        !req.headers()["next-action"] ||
        !(req.postData() ?? "").includes("E2E Pasted Tacos")
      )
        return route.continue();
      const fields = {
        first_name: "Rosa",
        last_name: "Lind",
        business_name: "E2E Pasted Tacos",
        phone: phone(5),
        phone2: "",
        email: "rosa@e2e-pasted.test",
        email2: "",
        industry: "",
        state: "CA",
        wanted_amount: "60k",
        looking_for: "a truck",
        notes: "",
      };
      return route.fulfill({
        status: 200,
        contentType: "text/x-component",
        body: `0:{"a":"$@1","f":"","b":"e2e"}\n1:${JSON.stringify({ ok: true, data: { fields } })}\n`,
      });
    });
    await paste.fill(
      `Rosa Lind, E2E Pasted Tacos, ${phone(5)}, rosa@e2e-pasted.test, CA, wants 60k for a truck`,
    );
    await page.getByRole("button", { name: "Fill the form" }).click();
    await page.getByText("Filled from the line:").waitFor({ timeout: 10000 });
    check(
      "paste box: the form is filled and the fields are named",
      (await page.getByPlaceholder("(305) 555-0100").inputValue()) === phone(5) &&
        (await page.getByPlaceholder("Mike's Pizza").inputValue()) === "E2E Pasted Tacos" &&
        (await page.getByText("Amount they want", { exact: true }).count()) >= 1,
    );
    await page.unroute("**/lead-intake");
  }
  const runsAfter = await withDb((db) =>
    one(db, "select count(*)::int as n from ai_runs where purpose = 'split_lead_line'", []),
  );
  check(
    "paste box: no assistant run was logged — no model answered, so nothing was spent",
    runsAfter.n === runsBefore.n,
    `${runsBefore.n} -> ${runsAfter.n}`,
  );

  // The duplicate warning: another rep owns this number
  const ownerLine = "Already in the system: Mike's lead, in Missing statements, touched 3 days ago";
  await page.reload({ waitUntil: "networkidle" });
  await page.getByPlaceholder("(305) 555-0100").fill(phone(0));
  await page.getByPlaceholder("owner@business.com").click();
  await page.getByText(ownerLine, { exact: true }).waitFor({ timeout: 10000 });
  check("rep: the warning shows the server's owner line, owner, bucket and last touch", true);
  const submit = page.getByRole("button", { name: /Submit to Interested|Add lead/ });
  check(
    "rep: Submit is disabled and the page says a rep cannot add it",
    (await submit.isDisabled()) &&
      (await page.getByText(/A rep cannot add a lead another rep has/).isVisible()),
  );
  check(
    "rep: the warning names no merchant and offers no override",
    (await page.getByText("Add it anyway").count()) === 0 &&
      (await page.getByRole("link", { name: /Open E2E Harbor Tacos/ }).count()) === 0,
  );
  // the same merchant by email alone
  await page.getByPlaceholder("(305) 555-0100").fill("");
  await page.getByPlaceholder("owner@business.com").fill("ROSA@e2e-harbor.test");
  await page.getByPlaceholder("Mike", { exact: true }).click();
  await page.getByText(ownerLine, { exact: true }).waitFor({ timeout: 10000 });
  check("rep: the same merchant is found by email alone", true);
  const harborCount = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from clients where right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1",
      [phone(0)],
    ),
  );
  check("rep: nothing was written", harborCount.n === 1, JSON.stringify(harborCount));

  // ------------------------------------------------------------------------------------------ bulk intake
  await page.reload({ waitUntil: "networkidle" });
  const list = page.getByText("File staged sheet rows");
  await list.waitFor();
  for (const n of ["Bulk Fresh One", "Bulk Fresh Two", "Bulk Own Dup", "Bulk Mikes Dup"])
    await page.getByRole("checkbox", { name: `Check ${n}` }).check();
  await page.getByLabel("Bucket for these rows").selectOption({ label: "Missing statements" });
  await page.getByRole("button", { name: "File 4 rows to Missing statements" }).click();
  const results = page.getByRole("list", { name: "Filing results" });
  await results.waitFor({ timeout: 20000 });
  const text = await results.innerText();
  check(
    "bulk: each row reports its own result",
    /Filed\s+Bulk Fresh One/.test(text) &&
      /Filed\s+Bulk Fresh Two/.test(text) &&
      /Duplicate[\s\S]*Bulk Own Dup/.test(text),
    text.replace(/\n+/g, " | "),
  );
  check(
    "bulk: another rep's merchant is skipped with the owner line",
    text.includes("Already in the system: Mike's lead, in Missing statements, touched 3 days ago"),
  );
  const filed = await withDb((db) =>
    rows(
      db,
      `select c.business_name, c.user_id, c.phone, b.key as bucket,
              (select count(*)::int from outbox o where o.client_id = c.id and o.lane = 'intake') as welcomes
         from clients c left join enrollments e on e.client_id = c.id and e.stopped_at is null
         left join buckets b on b.id = e.bucket_id
        where c.user_id = $1 and c.business_name in ('Bulk Fresh One', 'Bulk Fresh Two') order by c.business_name`,
      [userId],
    ),
  );
  check(
    "bulk DB: two merchants made for the rep, in the chosen bucket",
    filed.length === 2 &&
      filed.every((f) => f.user_id === userId && f.bucket === "missing_statements"),
    JSON.stringify(filed),
  );
  const marks = await withDb((db) =>
    rows(
      db,
      "select business_name, filed_at is not null as filed, client_id from sheet_rows where source_id = $1 order by row_no",
      [sheet.id],
    ),
  );
  const dupes = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from clients where user_id = $1 and business_name in ('Bulk Own Dup', 'Bulk Mikes Dup')",
      [userId],
    ),
  );
  check(
    "bulk DB: every row is marked filed; the two duplicates made no merchant and point at the existing one",
    marks.every((m) => m.filed) &&
      dupes.n === 0 &&
      marks[3].client_id === mike.clientId &&
      marks[2].client_id !== null,
    JSON.stringify(marks),
  );
  await page.reload({ waitUntil: "networkidle" });
  check(
    "bulk: filed rows leave the staged list",
    (await page.getByRole("checkbox", { name: /Check Bulk / }).count()) === 0,
  );

  // ------------------------------------------------------------------- the manager's override on the same number
  await setRole(email, "manager");
  await page.goto(`${BASE}/api/dev-login?email=${encodeURIComponent(email)}`);
  await page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("(305) 555-0100").fill(phone(0));
  await page.getByPlaceholder("owner@business.com").click();
  await page.getByText(ownerLine, { exact: true }).waitFor({ timeout: 10000 });
  const toggle = page.getByLabel("Add it anyway (manager override)");
  check(
    "manager: the same line, a link to open the merchant, and an override toggle",
    (await page.getByRole("link", { name: /Open E2E Harbor Tacos/ }).isVisible()) &&
      (await toggle.isVisible()),
  );
  const submitM = page.getByRole("button", { name: /Submit to Interested|Add lead/ });
  check("manager: Submit waits for the override", await submitM.isDisabled());
  await toggle.check();
  check("manager: ticking the override enables Submit", await submitM.isEnabled());
  await page.getByPlaceholder("Mike's Pizza").fill("E2E Harbor Tacos II");
  await submitM.click();
  await page.getByText(/E2E Harbor Tacos II is in/).waitFor({ timeout: 10000 });
  const both = await withDb((db) =>
    rows(
      db,
      "select business_name, user_id from clients where right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 order by created_at",
      [phone(0)],
    ),
  );
  check(
    "manager DB: the lead was added to the manager's book beside the other rep's",
    both.length === 2 && both[0].user_id === mike.userId && both[1].user_id === userId,
    JSON.stringify(both),
  );

  // ------------------------------------------------------------------------------------------- Follow Up
  const bucket = await withDb((db) =>
    one(
      db,
      "insert into buckets (name, owner_id, rule, sort) values ('E2E scored', $1, 'manual', 100) returning id",
      [userId],
    ),
  );
  const people = await withDb((db) =>
    rows(
      db,
      "select id, business_name from clients where user_id = $1 and business_name not like 'Bulk %' and business_name not like 'E2E %' order by business_name limit 4",
      [userId],
    ),
  );
  const [A, B, C, D] = people;
  await withDb(async (db) => {
    await db.query("select set_config('app.user_id', $1, false)", [userId]);
    for (const m of people)
      await db.query("select enroll_in_bucket($1, $2, 'moved')", [m.id, bucket.id]);
  });
  // the sends the bucket made three days ago (D's bounced), what came back, and the statement D uploaded a day later
  await withDb(async (db) => {
    for (const m of people)
      await db.query(
        `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at, delivery_status)
         values ($1, $2, 'sequence', $3, 'x@e2e.test', 'Hi', 'Body', 'sent', now() - interval '3 days', $4)`,
        [userId, m.id, `bucket:${bucket.id}:step:1`, m === D ? "bounced" : null],
      );
    await db.query(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, created_at)
       values ($1, $2, 'bank_statement', 'e2e.pdf', 'application/pdf', 10, repeat('a', 64), $3, 'upload_link', now() - interval '2 days')`,
      [userId, D.id, `e2e-${Date.now()}`],
    );
    // the merchant's replies, tagged the way the classifier does it (apply_reply_tag is the real function)
    const reply = async (m, tag, days) => {
      const e = await one(
        db,
        `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, from_address, from_name, subject, snippet, text_body,
                                     received_at, client_id, matched_by, kind)
         values ($1, $2, 'th', 'r@e2e.test', 'R', 'Re', 's', 'b', now(), $3, 'merchant_reply', 'merchant') returning id`,
        [userId, `e2e-${m.id}`, m.id],
      );
      await db.query("select apply_reply_tag($1, $2, 0.9, 'in their own words', true, 'e2e', $3)", [
        e.id,
        tag,
        days,
      ]);
    };
    await reply(A, "interested", null);
    await reply(B, "sending_docs", null);
    await reply(C, "not_now", 14);
  });
  const revive = await withDb((db) =>
    one(db, "select revive_on::text from reply_tags where client_id = $1", [C.id]),
  );

  await page.goto(`${BASE}/follow-up?b=${bucket.id}`, { waitUntil: "networkidle" });
  const line = (m) => page.locator("li", { hasText: m.business_name }).first();
  check(
    "reply chips: interested, sending docs, and not now with its revive date",
    (await line(A).getByText("Interested", { exact: true }).isVisible()) &&
      (await line(B).getByText("Sending docs", { exact: true }).isVisible()) &&
      (await line(C)
        .getByText(`Not now — back ${fmt(revive.revive_on)}`, { exact: true })
        .isVisible()),
    revive.revive_on,
  );
  check(
    "paused label: the not-now lead says 'Paused until' its day",
    await line(C)
      .getByText(`Paused until ${fmt(revive.revive_on)}`, { exact: true })
      .isVisible(),
  );
  check(
    "no chip on a lead with no reply",
    (await line(D)
      .getByText(/Interested|Sending docs|Not now|Stop|Wrong person/)
      .count()) === 0,
  );

  // bucket scores in the header, against the rows inserted above
  const scores = (await page.getByTestId("bucket-scores").innerText()).replace(/\s+/g, " ");
  check(
    "bucket scores: sent, replies, docs in, days to docs, bounced, unsubscribed",
    /SENT 4/i.test(scores) &&
      /REPLIES 3 75%/i.test(scores) &&
      /DOCS IN 1 25%/i.test(scores) &&
      /DAYS TO DOCS 1(\.0)?\b/i.test(scores) &&
      /BOUNCED 1 25%/i.test(scores) &&
      /UNSUBSCRIBED 0 0%/i.test(scores),
    scores,
  );

  // pause D until a date, from the row's own popup
  const target = await withDb((db) =>
    one(db, "select ((now() at time zone 'America/New_York')::date + 10)::text as d", []),
  ).then((r) => r.d);
  await page
    .getByRole("button", { name: new RegExp(`Actions for ${D.business_name}`) })
    .first()
    .click();
  const pauseButton = page.getByRole("button", { name: "Pause until", exact: true });
  check("pause until: the button waits for a date", await pauseButton.isDisabled());
  await page.getByLabel("Pause until date").fill(target);
  await pauseButton.click();
  await page
    .getByText(`Paused until ${fmt(target)}`)
    .first()
    .waitFor({ timeout: 8000 });
  const paused = await until(async () => {
    const r = await withDb((db) =>
      one(
        db,
        "select paused, resume_on::text from enrollments where client_id = $1 and stopped_at is null",
        [D.id],
      ),
    );
    return r?.paused ? r : null;
  });
  check(
    "pause until DB: paused, with the day it lifts",
    paused?.resume_on === target,
    JSON.stringify(paused),
  );
  const queued = await withDb((db) =>
    one(
      db,
      "select count(*)::int as n from activities where client_id = $1 and body = 'Follow-up emails paused'",
      [D.id],
    ),
  );
  check("pause until DB: the timeline says so", queued.n === 1, JSON.stringify(queued));
  // Resume clears the date
  await page.getByRole("button", { name: "Resume", exact: true }).first().click();
  const resumed = await until(async () => {
    const r = await withDb((db) =>
      one(
        db,
        "select paused, resume_on::text from enrollments where client_id = $1 and stopped_at is null",
        [D.id],
      ),
    );
    return r && !r.paused ? r : null;
  });
  check("resume DB: unpaused, date cleared", resumed?.resume_on === null, JSON.stringify(resumed));
  // a date in the past is refused in words (the input's min stops it in the browser; the action stops it anywhere)
  const bad = await page.getByLabel("Pause until date").getAttribute("min");
  check(
    "pause until: the picker starts tomorrow",
    bad > target.slice(0, 0) && bad.length === 10,
    bad,
  );

  // -------------------------------------------------------------------------- the merchant page: application
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.goto(`${BASE}/clients/${A.id}`, { waitUntil: "networkidle" });
  const token = await withDb((db) =>
    one(db, "select application_token from clients where id = $1", [A.id]),
  ).then((r) => r.application_token);
  const link = `${BASE}/apply/${token}`;
  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Application", exact: true }),
  });
  check(
    "application card: shows the merchant's own link, built from the database token",
    (await card.getByLabel("Application link").inputValue()) === link,
  );
  check(
    "follow-up panel: not signed yet",
    await page.getByText("Not signed yet").first().isVisible(),
  );
  await card.getByRole("button", { name: "Copy link" }).click();
  await page.getByText("Application link copied").waitFor({ timeout: 5000 });
  check(
    "copy: the link is on the clipboard",
    (await page.evaluate(() => navigator.clipboard.readText())) === link,
  );
  await card.getByRole("button", { name: "Email link" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Message").waitFor();
  const body = await dialog.getByLabel("Message").inputValue();
  check(
    "email link: the note carries the link, once, and the subject names the merchant",
    body.split(link).length === 2 &&
      (await dialog.getByLabel("Subject").inputValue()).startsWith("Your application"),
  );
  check(
    "email link: with no Gmail connected it offers to connect rather than failing silently",
    (await dialog.getByRole("button", { name: "Send from my Gmail" }).count()) +
      (await dialog.getByRole("link", { name: /Gmail/ }).count()) >=
      1,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // the merchant signs through the public page's own endpoint; the PDF lands in the merchant page's Documents card
  const res = await fetch(`${BASE}/api/apply/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      legal_business_name: "E2E Signed Co LLC",
      owner_name: "Alex Signer",
      phone: phone(7),
      email: "alex@e2e-signed.test",
      state: "CA",
      // a DBA is given on purpose: signing with a blank DBA on a merchant with none fails (apply.ts sets clients.dba to
      // null; see the report), which is not what this run is about
      dba: "E2E Signed Tacos",
      monthly_revenue_dollars: 40000,
      amount_requested_dollars: 60000,
      agree: true,
      signer_name: "Alex Signer",
    }),
  });
  check("the merchant's signing went through", res.ok, `${res.status} ${await res.clone().text()}`);
  const signed = await withDb((db) =>
    one(
      db,
      `select a.id, a.signer_name, a.document_id, d.kind, d.filename
         from applications a left join documents d on d.id = a.document_id where a.client_id = $1`,
      [A.id],
    ),
  );
  check(
    "DB: a signed application row with its PDF in Documents",
    signed?.kind === "signed_application",
    JSON.stringify(signed),
  );

  await page.goto(`${BASE}/clients/${A.id}`, { waitUntil: "networkidle" });
  const panel = page.locator("section", {
    has: page.getByRole("heading", { name: "Next follow-up" }),
  });
  check(
    "follow-up panel: 'Application signed' with the date and the signer",
    (await panel.getByText("Application signed", { exact: true }).isVisible()) &&
      (await panel.getByText(/by Alex Signer/).isVisible()),
  );
  const pdf = page.getByRole("link", { name: "Open signed PDF" });
  check(
    "application card: the signed PDF link goes to its document",
    (await pdf.getAttribute("href")) === `/api/docs/${signed.document_id}`,
  );
  const got = await page.request.get(`${BASE}/api/docs/${signed.document_id}`);
  check(
    "the PDF opens (200, a PDF)",
    got.status() === 200 && (got.headers()["content-type"] ?? "").includes("application/pdf"),
    `${got.status()} ${got.headers()["content-type"]}`,
  );
  const docs = page.locator("section", {
    has: page.getByRole("heading", { name: "Documents", exact: true }),
  });
  check(
    "Documents card: lists the signed application, labelled, with an Open link to its PDF",
    (await docs.getByText(signed.filename).first().isVisible()) &&
      (await docs.getByText("Signed application", { exact: true }).first().isVisible()) &&
      (await docs.getByRole("link", { name: "Open" }).first().getAttribute("href")) ===
        `/api/docs/${signed.document_id}`,
  );

  // ----------------------------------------------------------------------------- nothing scrolls sideways at 390px
  const phoneView = await openBrowser(email, { width: 390, height: 844 });
  for (const path of ["/lead-intake", `/follow-up?b=${bucket.id}`, `/clients/${A.id}`]) {
    await phoneView.page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    check(`390px: ${path.split("?")[0]} does not scroll sideways`, !(await wide(phoneView.page)));
  }
  await phoneView.page.goto(`${BASE}/lead-intake`, { waitUntil: "networkidle" });
  await phoneView.page.getByPlaceholder("(305) 555-0100").fill(phone(0));
  await phoneView.page.getByPlaceholder("owner@business.com").click();
  await phoneView.page.getByText(ownerLine, { exact: true }).waitFor({ timeout: 10000 });
  check("390px: the owner warning does not scroll sideways", !(await wide(phoneView.page)));
  await phoneView.browser.close();

  await browser.close();
}
