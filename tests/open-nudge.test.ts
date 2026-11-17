import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { runOpenNudges } from "@/lib/system/openNudge";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The "opened but did not finish" nudge (0548): off until switched on; then one email with the link again, a day
 * after the open, once a week at most, and never when the merchant or a person already moved. Every claim is read
 * from the DATABASE (outbox rows, activities), not from the function's return value alone.
 */

let t: TestDb;
let rep: string;
let boss: string;
const APP = "https://crm.example.com";

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;

let n = 0;
/** A merchant being chased: in the Interested bucket (the nudge is only for merchants in a live bucket). */
async function merchant(): Promise<string> {
  n += 1;
  const id = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Rosa Diaz', $3, $4, 'FL') returning id",
    [rep, `Shop ${n}`, `30555501${String(n).padStart(2, "0")}`, `owner${n}@shop${n}.com`],
  ))!.id;
  await t.pool.query(
    "select enroll_in_bucket($1, (select id from buckets where key = 'interested'))",
    [id],
  );
  return id;
}
const opened = (id: string, kind: "upload" | "apply", hoursAgo: number) =>
  t.pool.query(
    "insert into link_opens (client_id, kind, opened_at) values ($1, $2, now() - make_interval(hours => $3))",
    [id, kind, hoursAgo],
  );
const nudges = async (id: string) =>
  (
    await t.pool.query<{
      source: string;
      lane: string;
      status: string;
      text_body: string;
      template_id: string;
    }>(
      "select source, lane, status, text_body, template_id from outbox where client_id = $1 and source like 'nudge:%'",
      [id],
    )
  ).rows;
const run = () => runOpenNudges({ db: t.db, appUrl: APP });
const switchOn = (on: boolean) => t.pool.query("update shop_settings set open_nudge = $1", [on]);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  boss = await insertUser(t.pool, "boss@x.com");
  await t.pool.query("update app_users set role = 'manager' where id = $1", [boss]);
});
afterAll(async () => {
  await t.drop();
});

describe("the open nudge", () => {
  it("is off until a manager switches it on, and ships with two shop templates wired in", async () => {
    const s = (await one<{ open_nudge: boolean; up: string | null; ap: string | null }>(
      "select open_nudge, open_nudge_upload_template as up, open_nudge_apply_template as ap from shop_settings",
    ))!;
    expect(s.open_nudge).toBe(false);
    expect(s.up).toBeTruthy();
    expect(s.ap).toBeTruthy();
    const m = await merchant();
    await opened(m, "upload", 25);
    expect(await run()).toEqual({ queued: 0, skipped: 0 });
    expect(await nudges(m)).toHaveLength(0);
  });

  it("queues one email with the merchant's own upload link a day after the open, and a timeline line", async () => {
    await switchOn(true);
    const m = await merchant();
    await opened(m, "upload", 25);
    await run();
    const rows = await nudges(m);
    expect(rows).toHaveLength(1);
    const token = (await one<{ upload_token: string }>(
      "select upload_token from clients where id = $1",
      [m],
    ))!.upload_token;
    expect(rows[0]).toMatchObject({ lane: "sequence", status: "queued" });
    expect(rows[0]!.source).toMatch(/^nudge:upload:\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]!.text_body).toContain(`${APP}/upload/${token}`);
    expect(rows[0]!.text_body).toContain("Hi Rosa");
    const line = await one<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Opened the upload link and sent nothing%'",
      [m],
    );
    expect(line).toBeDefined();

    // the next hourly run does not send it again
    await run();
    expect(await nudges(m)).toHaveLength(1);
  });

  it("sends the application link for an application that was opened and not signed", async () => {
    const m = await merchant();
    await opened(m, "apply", 30);
    await run();
    const rows = await nudges(m);
    expect(rows).toHaveLength(1);
    const token = (await one<{ application_token: string }>(
      "select application_token from clients where id = $1",
      [m],
    ))!.application_token;
    expect(rows[0]!.text_body).toContain(`${APP}/apply/${token}`);
  });

  it("waits for a day, and lets an old open go", async () => {
    const fresh = await merchant();
    await opened(fresh, "upload", 5);
    const stale = await merchant();
    await opened(stale, "upload", 80);
    await run();
    expect(await nudges(fresh)).toHaveLength(0);
    expect(await nudges(stale)).toHaveLength(0);
  });

  it("says nothing when the merchant or a person already moved since the open", async () => {
    const sent = await merchant();
    await opened(sent, "upload", 26);
    await t.pool.query(
      `insert into documents (client_id, user_id, kind, filename, content_type, size_bytes, sha256, storage_key, source)
       values ($1, $2, 'bank_statement', 's.pdf', 'application/pdf', 10, repeat('a', 64), 'k/s.pdf', 'upload_link')`,
      [sent, rep],
    );
    const called = await merchant();
    await opened(called, "upload", 26);
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body, outcome) values ($1, $2, 'call', 'Talked', 'reached')",
      [rep, called],
    );
    const paused = await merchant();
    await opened(paused, "upload", 26);
    const bucket = (await one<{ id: string }>(
      "select id from buckets where key = 'missing_statements'",
    ))!.id;
    await t.pool.query("select enroll_in_bucket($1, $2)", [paused, bucket]);
    await t.pool.query(
      "update enrollments set paused = true where client_id = $1 and stopped_at is null",
      [paused],
    );
    await t.pool.query("update outbox set status = 'cancelled' where client_id = $1", [paused]);
    const handed = await merchant();
    await opened(handed, "upload", 26);
    await t.pool.query("update clients set brought_in_at = now() where id = $1", [handed]);
    const optedOut = await merchant();
    await opened(optedOut, "upload", 26);
    await t.pool.query("update clients set email_opt_out = true where id = $1", [optedOut]);

    await run();
    for (const id of [sent, called, paused, handed, optedOut])
      expect(await nudges(id)).toHaveLength(0);
  });

  it("sends nothing from an archived template", async () => {
    const m = await merchant();
    await opened(m, "upload", 27);
    await t.pool.query(
      "update templates set archived = true where id = (select open_nudge_upload_template from shop_settings)",
    );
    await run();
    expect(await nudges(m)).toHaveLength(0);
    await t.pool.query(
      "update templates set archived = false where id = (select open_nudge_upload_template from shop_settings)",
    );
  });

  it("never for a merchant out of follow-up, one whose file is complete, or an application already signed", async () => {
    await switchOn(true);
    const removed = await merchant();
    await opened(removed, "upload", 30);
    await t.pool.query("select stop_enrollment($1, 'removed')", [removed]);
    const complete = await merchant();
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        complete,
        JSON.stringify([{ kind: "bank_statement", period: "2026-10-01", required: true }]),
      ]),
    );
    await t.pool.query("update stips set received_at = now() where client_id = $1", [complete]);
    await opened(complete, "upload", 30);
    const signed = await merchant();
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        signed,
        JSON.stringify([{ kind: "signed_application", period: null, required: true }]),
      ]),
    );
    await t.pool.query(
      "update stips set received_at = now() - interval '3 days' where client_id = $1",
      [signed],
    );
    await opened(signed, "apply", 30);
    // a rep emailed them by hand after the open
    const emailed = await merchant();
    await opened(emailed, "upload", 30);
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'Email sent: checking in')",
      [rep, emailed],
    );
    await run();
    for (const id of [removed, complete, signed, emailed]) expect(await nudges(id)).toHaveLength(0);
  });

  it("only opens after the switch was turned on count", async () => {
    await switchOn(false);
    const old = await merchant();
    await opened(old, "upload", 30);
    await t.db.withUser(boss, (q) =>
      q.query("update shop_settings set open_nudge_since = now(), open_nudge = true"),
    );
    await run();
    expect(await nudges(old)).toHaveLength(0);
    await t.pool.query("update shop_settings set open_nudge_since = null");
  });

  it("a queued nudge is cancelled by the worker when the merchant replies before it goes", async () => {
    await switchOn(true);
    const id = await merchant();
    await opened(id, "upload", 26);
    await run();
    expect(await nudges(id)).toHaveLength(1);
    await t.pool.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', 'Merchant replied: sending tonight')",
      [rep, id],
    );
    await t.pool.query(
      "update outbox set not_before = now() - interval '1 minute' where client_id = $1 and source like 'nudge:%'",
      [id],
    );
    let k = 0;
    const deliver: Deliverer = { gmail: async () => `g_${++k}`, resend: async () => `r_${++k}` };
    await drainOutbox({ db: t.db, deliver, now: new Date(), appUrl: APP });
    const row = await one<{ status: string; skip_reason: string }>(
      "select status, skip_reason from outbox where client_id = $1 and source like 'nudge:%'",
      [id],
    );
    expect(row).toMatchObject({ status: "cancelled", skip_reason: "overtaken" });
    expect(k).toBe(0);
  });

  it("a manager's switch in Settings is what turns it off", async () => {
    await switchOn(false);
    const m = await merchant();
    await opened(m, "upload", 28);
    await run();
    expect(await nudges(m)).toHaveLength(0);
  });
});
