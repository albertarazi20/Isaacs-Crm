import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueBlast, runBucketSteps } from "@/lib/buckets/engine";
import { findDuplicates } from "@/lib/data/queries";
import { monthOf } from "@/lib/dashboard/queries";
import { LocalStore } from "@/lib/docs/storage";
import { addDocument, deleteDocument } from "@/lib/docs/upload";
import { loadOverview } from "@/lib/followup/overview";
import { handOff, undoHandOff } from "@/lib/followup/handoff";
import { matchableEmail } from "@/lib/mca/matchEmail";
import { runStatementClock } from "@/lib/system/statements";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The second review of the follow-up engine (db/migrations/0549 and the matching code). Every database claim is read
 * back from the database: enrolments, outbox rows, stips and the overview's lists.
 */

const TODAY = "2026-11-17";

describe("placeholder emails match nothing", () => {
  it.each([
    ["none@none.com", ""],
    ["NoEmail@gmail.com", ""],
    ["test@test.com", ""],
    ["owner@example.com", ""],
    ["n/a@yahoo.com", ""],
    ["not-an-email", ""],
    ["  Rosa@WarmTacos.com ", "rosa@warmtacos.com"],
  ])("%s", (raw, want) => expect(matchableEmail(raw)).toBe(want));
});

describe("the engine's second review (database)", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let phone = 3055550600;
  let seed = 0;
  const APP = "https://crm.example.com";

  const pdf = () =>
    new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% file ${(seed += 1)}\n%%EOF\n`);
  const merchant = async (name: string, email?: string) => {
    phone += 1;
    return (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', $3, $4, 'FL') returning id",
        [rep, name, String(phone), email ?? `o${phone}@shop.com`],
      )
    ).rows[0]!.id;
  };
  const checklist = (id: string, stips: { kind: string; period: string | null }[]) =>
    t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify(stips.map((s) => ({ ...s, required: true }))),
      ]),
    );
  const upload = (id: string, kind: string, period: string | null = null) =>
    t.db.withUser(rep, (q) =>
      addDocument(q, store, {
        clientId: id,
        filename: `${kind}-${period ?? "x"}-${seed}.pdf`,
        contentType: "application/pdf",
        bytes: pdf(),
        uploadedBy: rep,
        today: TODAY,
        kind: kind as "signed_application",
        period,
      }),
    );
  const live = async (id: string) =>
    (
      await t.pool.query<{
        key: string | null;
        next_step: number;
        steps_sent: number;
        next_due_on: string | null;
        paused: boolean;
        resume_on: string | null;
        last_outbox_id: string | null;
      }>(
        `select b.key, e.next_step, e.steps_sent, e.next_due_on::text, e.paused, e.resume_on::text, e.last_outbox_id
           from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 and e.stopped_at is null`,
        [id],
      )
    ).rows[0] ?? null;
  const bucketId = async (key: string) =>
    (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!
      .id;
  const nyToday = async () =>
    (
      await t.pool.query<{ d: string }>(
        "select (now() at time zone 'America/New_York')::date::text as d",
      )
    ).rows[0]!.d;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "isaac-engine2-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    // a postal address so nothing waits on the CAN-SPAM gate
    await t.pool.query("update shop_settings set postal_address = '1 Main St, Miami FL'");
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("undoing a hand-off resumes at the step the hand-off cancelled, and that step goes again", async () => {
    const id = await merchant("Resume Co");
    await t.pool.query("select enroll_in_bucket($1, $2)", [id, await bucketId("interested")]);
    await runBucketSteps({ db: t.db, appUrl: APP });
    const before = (await live(id))!;
    expect(before).toMatchObject({ key: "interested", next_step: 2, steps_sent: 1 });
    expect(before.last_outbox_id).toBeTruthy();

    await t.db.withUser(rep, (q) => handOff(q, id));
    const lost = await t.pool.query<{ status: string; source: string }>(
      "select status, source from outbox where id = $1",
      [before.last_outbox_id],
    );
    expect(lost.rows[0]!.status).toBe("cancelled");
    expect(lost.rows[0]!.source).toMatch(/:step:1$/);

    await t.db.withUser(rep, (q) => undoHandOff(q, id));
    expect(await live(id)).toMatchObject({
      key: "interested",
      next_step: 1,
      steps_sent: 0,
      next_due_on: await nyToday(),
      last_outbox_id: null,
    });
    await runBucketSteps({ db: t.db, appUrl: APP });
    const again = await t.pool.query(
      "select 1 from outbox where client_id = $1 and source like '%:step:1' and status = 'queued'",
      [id],
    );
    expect(again.rowCount).toBe(1);
  });

  it("undoing a hand-off re-checks the checklist: documents that came in meanwhile move the merchant on", async () => {
    const id = await merchant("Came In Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    expect((await live(id))!.key).toBe("missing_app");
    await t.db.withUser(rep, (q) => handOff(q, id));
    await upload(id, "signed_application");
    await upload(id, "bank_statement", "2026-10-01");
    expect(await live(id)).toBeNull();
    await t.db.withUser(rep, (q) => undoHandOff(q, id));
    expect((await live(id))!.key).toBe("ready_for_ops");
  });

  it("a removed file moves a paused merchant back, and the pause holds", async () => {
    const id = await merchant("Paused Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    await upload(id, "signed_application");
    const oct = await upload(id, "bank_statement", "2026-10-01");
    expect((await live(id))!.key).toBe("ready_for_ops");
    await t.pool.query(
      "update enrollments set paused = true, resume_on = date '2026-12-20' where client_id = $1 and stopped_at is null",
      [id],
    );
    await t.db.withUser(rep, (q) => deleteDocument(q, store, oct.documentId, rep));
    expect(await live(id)).toMatchObject({
      key: "missing_statements",
      paused: true,
      resume_on: "2026-12-20",
      next_due_on: "2026-12-20",
    });
  });

  it("an un-ticked box never enrols a merchant who has no live bucket", async () => {
    const id = await merchant("Stopped Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    const app = await upload(id, "signed_application");
    await t.pool.query("select stop_enrollment($1, 'removed')", [id]);
    await t.db.withUser(rep, (q) => deleteDocument(q, store, app.documentId, rep));
    expect(await live(id)).toBeNull();
  });

  it("a closed chase (opted out) is never re-opened by a document", async () => {
    const id = await merchant("Opted Out Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    await t.pool.query("select stop_enrollment($1, 'opted_out')", [id]);
    await t.pool.query("update clients set email_opt_out = true where id = $1", [id]);
    await upload(id, "signed_application");
    expect(await live(id)).toBeNull();
  });

  it("a file the safety scan rejects un-ticks the box it backed", async () => {
    const id = await merchant("Scan Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-10-01" },
    ]);
    const app = await upload(id, "signed_application");
    const got = () =>
      t.pool
        .query<{ got: boolean }>(
          "select received_at is not null as got from stips where client_id = $1 and kind = 'signed_application'",
          [id],
        )
        .then((r) => r.rows[0]!.got);
    expect(await got()).toBe(true);
    await t.pool.query("update documents set scan_status = 'rejected' where id = $1", [
      app.documentId,
    ]);
    expect(await got()).toBe(false);
    const line = await t.pool.query(
      "select 1 from activities where client_id = $1 and body like '%failed the safety check'",
      [id],
    );
    expect(line.rowCount).toBe(1);
  });

  it("the statement clock slides the window: the oldest month still missing drops off", async () => {
    const id = await merchant("Window Co");
    await checklist(id, [
      { kind: "signed_application", period: null },
      { kind: "bank_statement", period: "2026-06-01" },
      { kind: "bank_statement", period: "2026-07-01" },
      { kind: "bank_statement", period: "2026-08-01" },
      { kind: "bank_statement", period: "2026-09-01" },
    ]);
    await upload(id, "signed_application");
    for (const m of ["2026-07-01", "2026-08-01", "2026-09-01"])
      await upload(id, "bank_statement", m);
    expect((await live(id))!.key).toBe("missing_statements");

    await runStatementClock(t.db, TODAY);
    const months = await t.pool.query<{ period: string; required: boolean }>(
      "select period::text, required from stips where client_id = $1 and kind = 'bank_statement' order by period",
      [id],
    );
    expect(months.rows).toEqual([
      { period: "2026-06-01", required: false },
      { period: "2026-07-01", required: true },
      { period: "2026-08-01", required: true },
      { period: "2026-09-01", required: true },
      { period: "2026-10-01", required: true },
    ]);
    expect((await live(id))!.key).toBe("missing_newest");
  });

  it("a blast pressed twice in the rep's evening is one email, keyed to the rep's own day", async () => {
    const id = await merchant("Blast Co");
    const tpl = (
      await t.pool.query<{ id: string }>(
        "select open_nudge_upload_template as id from shop_settings",
      )
    ).rows[0]!.id;
    // 7:55pm and 8:05pm in New York are two UTC days
    for (const at of ["2026-11-18T00:55:00Z", "2026-11-18T01:05:00Z"])
      await t.db.withUser(rep, (q) =>
        queueBlast(q, { templateId: tpl, clientIds: [id], appUrl: APP, now: new Date(at) }),
      );
    const rows = await t.pool.query<{ source: string }>(
      "select source from outbox where client_id = $1 and lane = 'blast'",
      [id],
    );
    expect(rows.rows.map((r) => r.source)).toEqual([`blast:${tpl}:2026-11-17`]);
  });

  it("do-not-contact merchants are never on the opened or overdue lists", async () => {
    const opened = await merchant("Opened DNC Co");
    await t.pool.query(
      "insert into link_opens (client_id, kind, opened_at) values ($1, 'upload', now() - interval '1 hour')",
      [opened],
    );
    const late = await merchant("Late DNC Co");
    // not a new lead (that is the "call now" list, which outranks overdue)
    await t.pool.query("update clients set created_at = now() - interval '5 days' where id = $1", [
      late,
    ]);
    await t.pool.query(
      "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date - 3)",
      [rep, late, await nyToday()],
    );
    const queue = async () =>
      (
        await t.db.withUser(rep, async (q) => {
          const today = await nyToday();
          return loadOverview(q, { today, month: monthOf(today), manager: false });
        })
      ).queue.filter((x) => x.clientId === opened || x.clientId === late);
    expect((await queue()).map((x) => x.kind).sort()).toEqual(["opened", "overdue"]);
    await t.pool.query(
      "update clients set contact_status = 'dnc', contact_status_note = 'asked us to stop' where id = any($1::uuid[])",
      [[opened, late]],
    );
    expect(await queue()).toEqual([]);
  });

  it("the same real email is the same merchant; a placeholder email matches nothing", async () => {
    const id = await merchant("Inbox Co", "owner@inbox-co.com");
    const dupes = (input: { phone?: string; email?: string }) =>
      t.db.withUser(rep, (q) => findDuplicates(q, input)).then((r) => r.map((m) => m.id));
    expect(await dupes({ email: "owner@inbox-co.com" })).toContain(id);
    expect(await dupes({ email: "owner@inbox-co.com", phone: "3125550199" })).toContain(id);
    await t.pool.query("update clients set email = 'none@none.com' where id = $1", [id]);
    expect(await dupes({ email: "none@none.com" })).not.toContain(id);
  });
});
