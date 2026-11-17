import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERT_KIND_LABELS, listAlerts, unreadAlertCount } from "@/lib/alerts/feed";
import { queueBlast, runBucketSteps } from "@/lib/buckets/engine";
import { toActionError } from "@/lib/data/errors";
import { handOff, undoHandOff } from "@/lib/followup/handoff";
import { enqueueEmail } from "@/lib/send/enqueue";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The follow-up engine fixes in db/migrations/0543 and src/lib/buckets/engine.ts (defects 4, 5, 6, 9, 11 and 13 of
 * the 2026-11-17 bug hunt). Every claim is read back from the database.
 */

let t: TestDb;
let rep: string;
let phone = 3055550400;

const bucket = async (key: string) =>
  (await t.pool.query<{ id: string }>("select id from buckets where key = $1", [key])).rows[0]!.id;
const client = async (name: string) => {
  phone += 1;
  return (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Mike', $3, $4, 'FL') returning id",
      [rep, name, String(phone), `owner${phone}@x.com`],
    )
  ).rows[0]!.id;
};
const enrol = (id: string, bucketId: string) =>
  t.db.withUser(rep, (q) => q.query("select enroll_in_bucket($1, $2)", [id, bucketId]));
const live = async (id: string) =>
  (
    await t.pool.query<{
      key: string | null;
      next_step: number;
      next_due_on: string | null;
      steps_sent: number;
      paused: boolean;
    }>(
      `select b.key, e.next_step, e.next_due_on::text, e.steps_sent, e.paused
         from enrollments e join buckets b on b.id = e.bucket_id
        where e.client_id = $1 and e.stopped_at is null`,
      [id],
    )
  ).rows;
const enrolments = async (id: string) =>
  (
    await t.pool.query<{ key: string | null; stop_reason: string | null }>(
      `select b.key, e.stop_reason from enrollments e join buckets b on b.id = e.bucket_id
        where e.client_id = $1 order by e.entered_at, e.stopped_at nulls last`,
      [id],
    )
  ).rows;
const outbox = async (id: string) =>
  (
    await t.pool.query<{
      lane: string;
      source: string;
      status: string;
      skip_reason: string | null;
    }>(
      "select lane, source, status, skip_reason from outbox where client_id = $1 order by created_at",
      [id],
    )
  ).rows;
const openTimers = async (id: string) =>
  (
    await t.pool.query<{ note: string }>(
      "select note from timers where client_id = $1 and done_at is null",
      [id],
    )
  ).rows;
const lines = async (id: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'system' order by occurred_at",
      [id],
    )
  ).rows.map((r) => r.body);
/** A day counted from the merchant's own today (Florida), as the engine and enroll_in_bucket compute it. */
const plusDays = async (n: number) =>
  (
    await t.pool.query<{ d: string }>(
      "select (((now() at time zone 'America/New_York')::date) + $1::int)::text as d",
      [n],
    )
  ).rows[0]!.d;
/** Make a live enrolment's given step due yesterday, as if the days had passed. */
const dueNow = (id: string, step: number) =>
  t.pool.query(
    "update enrollments set next_step = $2, next_due_on = current_date - 1 where client_id = $1 and stopped_at is null",
    [id, step],
  );
const run = () => runBucketSteps({ db: t.db, appUrl: "https://crm.test" });
const reply = async (id: string, gmailId: string) =>
  (
    await t.pool.query<{ id: string }>(
      `insert into inbound_emails (mailbox_user_id, gmail_id, client_id, from_address, subject, snippet, received_at)
       values ($1, $2, $3, 'owner@x.com', 'Re: statements', 'Not now, try me in a couple of days', now()) returning id`,
      [rep, gmailId, id],
    )
  ).rows[0]!.id;
const notNow = (emailId: string) =>
  t.db.withSystem((q) =>
    q.query("select apply_reply_tag($1, 'not_now', 0.9, 'not now', true, 'test', 2)", [emailId]),
  );
const blastTemplate = async () =>
  (
    await t.pool.query<{ id: string }>(
      "select id from templates where owner_id is null and name = 'Cold — monthly nudge'",
    )
  ).rows[0]!.id;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep' where id = $1",
    [rep],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
});
afterAll(async () => {
  await t.drop();
});

describe("4: a 'not now' reply never re-opens the chase for a merchant whose chase is over", () => {
  it("a handed-off merchant stays out of every bucket, and the revive day brings no email and no call", async () => {
    const id = await client("Handed Co");
    await enrol(id, await bucket("missing_id"));
    await t.db.withUser(rep, (q) => handOff(q, id));
    const before = await enrolments(id);

    await notNow(await reply(id, "g-handed"));

    expect(await live(id)).toEqual([]);
    expect(await enrolments(id)).toEqual(before);
    expect(await lines(id)).toContain(
      "Merchant said not now — already handed off, so no follow-up emails were scheduled",
    );
    // the engine finds nothing to do for it: no email and no call task
    await run();
    expect((await outbox(id)).filter((o) => o.status !== "cancelled")).toEqual([]);
    expect(await openTimers(id)).toEqual([]);
  });

  it("an opted-out merchant and one whose address bounced are not put back either; any other merchant is", async () => {
    const out = await client("Opted Out Co");
    await enrol(out, await bucket("missing_statements"));
    await t.db.withUser(rep, (q) => q.query("select opt_out($1, 'email', 'unsubscribe')", [out]));
    await notNow(await reply(out, "g-out"));
    expect(await live(out)).toEqual([]);

    const bounced = await client("Bounced Co");
    await enrol(bounced, await bucket("missing_statements"));
    const email = (
      await t.pool.query<{ email: string }>("select email from clients where id = $1", [bounced])
    ).rows[0]!.email;
    await t.pool.query(
      "select app.suppress('email', app.suppression_key($1), $1, 'hard_bounce', '', $2, null)",
      [email, bounced],
    );
    await t.pool.query("select stop_enrollment($1, 'bounced')", [bounced]);
    await notNow(await reply(bounced, "g-bounced"));
    expect(await live(bounced)).toEqual([]);

    // the control: the reply itself stopped the chase, so it picks up again on the revive day
    const later = await client("Later Co");
    await enrol(later, await bucket("missing_statements"));
    await t.pool.query("select stop_enrollment($1, 'replied')", [later]);
    await notNow(await reply(later, "g-later"));
    expect(await live(later)).toEqual([
      {
        key: "missing_statements",
        next_step: 1,
        next_due_on: await plusDays(2),
        steps_sent: 0,
        paused: true,
      },
    ]);
  });

  it("the engine never takes a step for a handed-off merchant, even with a live enrolment left over", async () => {
    const id = await client("Leftover Co");
    await enrol(id, await bucket("missing_id"));
    // an enrolment left live by older code: hand_off now stops it, so write the mark directly
    await t.pool.query("update clients set brought_in_at = now() where id = $1", [id]);
    await dueNow(id, 3);
    await run();
    expect(await openTimers(id)).toEqual([]);
    expect(await live(id)).toMatchObject([{ key: "missing_id", next_step: 3, steps_sent: 0 }]);
  });
});

describe("5: a handed-off merchant cannot be moved into a bucket", () => {
  it("enroll_in_bucket refuses in plain words until the hand-off is undone", async () => {
    const id = await client("Moved Back Co");
    await enrol(id, await bucket("interested"));
    await t.db.withUser(rep, (q) => handOff(q, id));

    const err = await enrol(id, await bucket("missing_id")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("22023");
    expect(toActionError(err)).toBe("That merchant was handed off. Undo the hand-off first.");
    expect(await live(id)).toEqual([]);

    await t.db.withUser(rep, (q) => undoHandOff(q, id));
    await enrol(id, await bucket("missing_id"));
    expect(await live(id)).toMatchObject([{ key: "missing_id" }]);
  });
});

describe("6: two engine runs at once take each step once", () => {
  it("every due merchant gets one copy of step 1 and its enrolment moves on once", async () => {
    const b = await bucket("interested");
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = await client(`Race ${i}`);
      await enrol(id, b);
      ids.push(id);
    }
    const pending = async () =>
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from outbox where lane = 'sequence' and status <> 'cancelled'",
        )
      ).rows[0]!.n;
    const before = await pending();
    const [a, c] = await Promise.all([run(), run()]);

    const copies = await t.pool.query<{ client_id: string; n: number }>(
      `select client_id, count(*)::int as n from outbox
        where client_id = any($1) and status <> 'cancelled' group by client_id`,
      [ids],
    );
    expect(copies.rows).toHaveLength(20);
    expect(copies.rows.every((r) => r.n === 1)).toBe(true);
    const steps = await t.pool.query<{ next_step: number; steps_sent: number }>(
      "select next_step, steps_sent from enrollments where client_id = any($1) and stopped_at is null",
      [ids],
    );
    expect(steps.rows).toHaveLength(20);
    expect(steps.rows.every((r) => r.next_step === 2 && r.steps_sent === 1)).toBe(true);
    // the two summaries add up to what was really written
    expect(a.emailed + c.emailed).toBe((await pending()) - before);
  });

  it("the outbox itself refuses a second pending copy of a step; enqueue reports it as a duplicate", async () => {
    const id = await client("Twice Co");
    const source = `bucket:${await bucket("interested")}:step:1`;
    const first = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, { clientId: id, lane: "sequence", source, subject: "s", text: "t" }),
    );
    expect(first.queued).toBe(true);
    const second = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, { clientId: id, lane: "sequence", source, subject: "s", text: "t" }),
    );
    expect(second).toEqual({ queued: false, reason: "duplicate" });
    await expect(
      t.pool.query(
        "insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body) values ($1, $2, 'sequence', $3, 'a@x.com', 's', 't')",
        [rep, id, source],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(await outbox(id)).toHaveLength(1);
    // once it has gone, the same step may be sent again (a revive, or step 1 daily with sequences off)
    await t.pool.query("update outbox set status = 'sent', sent_at = now() where client_id = $1", [
      id,
    ]);
    const again = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, { clientId: id, lane: "sequence", source, subject: "s", text: "t" }),
    );
    expect(again.queued).toBe(true);
  });
});

describe("9: a sequence that runs out hands over to Cold", () => {
  it("Missing ID ends on its call step and the merchant lands in Cold, its first nudge a month out", async () => {
    const id = await client("Seq End Co");
    await enrol(id, await bucket("missing_id"));
    await dueNow(id, 3);
    const s = await run();
    expect(s.finished).toBeGreaterThanOrEqual(1);
    expect(await openTimers(id)).toHaveLength(1); // the call step itself still happened
    expect(await enrolments(id)).toEqual([
      { key: "missing_id", stop_reason: "sequence_done" },
      { key: "cold", stop_reason: null },
    ]);
    expect(await live(id)).toEqual([
      { key: "cold", next_step: 1, next_due_on: await plusDays(30), steps_sent: 0, paused: false },
    ]);
    expect((await lines(id)).at(-1)).toBe("Moved to bucket Cold");
  });

  it("when the last step is an email, it still goes: the move to Cold does not cancel it", async () => {
    const mine = (
      await t.pool.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule) values ('One email', $1, 'manual') returning id",
        [rep],
      )
    ).rows[0]!.id;
    await t.pool.query(
      "insert into bucket_steps (bucket_id, step_no, day_offset, template_id) values ($1, 1, 0, $2)",
      [mine, await blastTemplate()],
    );
    const id = await client("Last Email Co");
    await enrol(id, mine);
    await run();
    expect(await outbox(id)).toEqual([
      { lane: "sequence", source: `bucket:${mine}:step:1`, status: "queued", skip_reason: null },
    ]);
    expect(await live(id)).toMatchObject([{ key: "cold", next_due_on: await plusDays(30) }]);
  });

  it("a merchant whose address is suppressed is not parked in Cold: the enrolment just ends", async () => {
    const id = await client("Suppressed Co");
    await enrol(id, await bucket("missing_id"));
    const email = (
      await t.pool.query<{ email: string }>("select email from clients where id = $1", [id])
    ).rows[0]!.email;
    await t.pool.query(
      "select app.suppress('email', app.suppression_key($1), $1, 'complaint', '', null, null)",
      [email],
    );
    await dueNow(id, 3);
    await run();
    expect(await live(id)).toEqual([]);
    expect(await enrolments(id)).toEqual([{ key: "missing_id", stop_reason: "sequence_done" }]);
  });

  it("Cold keeps its member after the last nudge, live with nothing more scheduled", async () => {
    const id = await client("Cold Forever Co");
    await enrol(id, await bucket("cold"));
    await dueNow(id, 3);
    await run();
    expect(await live(id)).toEqual([
      { key: "cold", next_step: 4, next_due_on: null, steps_sent: 1, paused: false },
    ]);
    expect((await outbox(id)).map((o) => o.status)).toEqual(["queued"]);
    // later runs leave it alone
    await run();
    expect(await outbox(id)).toHaveLength(1);
    expect(await enrolments(id)).toEqual([{ key: "cold", stop_reason: null }]);
  });
});

describe("11: blasts are counted from the rows and never doubled", () => {
  it("pressing Blast twice, before or after the first went, writes one row and says so", async () => {
    const id = await client("Blast Twice Co");
    const tpl = await blastTemplate();
    const blast = () =>
      t.db.withUser(rep, (q) =>
        queueBlast(q, { templateId: tpl, clientIds: [id], appUrl: "https://crm.test" }),
      );
    expect(await blast()).toEqual({ queued: 1, skipped: [] });
    expect(await blast()).toEqual({ queued: 0, skipped: [{ clientId: id, reason: "duplicate" }] });
    await t.pool.query("update outbox set status = 'sent', sent_at = now() where client_id = $1", [
      id,
    ]);
    expect(await blast()).toEqual({ queued: 0, skipped: [{ clientId: id, reason: "duplicate" }] });
    expect((await outbox(id)).map((o) => [o.lane, o.status])).toEqual([["blast", "sent"]]);
  });

  it("a blast to a handed-off merchant is reported as not queued, matching the cancelled row", async () => {
    const id = await client("Blast Handed Co");
    await t.db.withUser(rep, (q) => handOff(q, id));
    const r = await t.db.withUser(rep, async (q) =>
      queueBlast(q, {
        templateId: await blastTemplate(),
        clientIds: [id],
        appUrl: "https://crm.test",
      }),
    );
    expect(r).toEqual({ queued: 0, skipped: [{ clientId: id, reason: "brought_in" }] });
    expect(await outbox(id)).toMatchObject([
      { lane: "blast", status: "cancelled", skip_reason: "brought_in" },
    ]);
  });
});

describe("13: a complete file tells the rep once", () => {
  it("reaching Ready to hand off writes one 'file complete' alert to the rep, and only one", async () => {
    const id = await client("Complete Co");
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify([{ kind: "signed_application", period: null, required: true }]),
      ]),
    );
    expect(await live(id)).toMatchObject([{ key: "missing_app" }]);
    const stip = (
      await t.pool.query<{ id: string }>("select id from stips where client_id = $1", [id])
    ).rows[0]!.id;
    await t.db.withUser(rep, (q) => q.query("select set_stip_received($1, true)", [stip]));
    expect(await live(id)).toMatchObject([{ key: "ready_for_ops" }]);

    const alerts = async () =>
      (
        await t.pool.query<{ user_id: string; kind: string; title: string; href: string }>(
          "select user_id, kind, title, href from user_alerts where client_id = $1",
          [id],
        )
      ).rows;
    expect(await alerts()).toEqual([
      {
        user_id: rep,
        kind: "file_complete",
        title: "Complete Co is ready to hand off",
        href: `/clients/${id}`,
      },
    ]);
    // out and back in again: still the one alert
    await enrol(id, await bucket("cold"));
    await enrol(id, await bucket("ready_for_ops"));
    expect(await alerts()).toHaveLength(1);

    // the rep's feed shows it under its own label
    const feed = await t.db.withUser(rep, (q) => listAlerts(q));
    expect(feed.find((a) => a.kind === "file_complete")).toMatchObject({
      title: "Complete Co is ready to hand off",
      business_name: "Complete Co",
    });
    expect(ALERT_KIND_LABELS.file_complete).toBe("File complete");
  });

  it("alerts left over from the removed features are not shown or counted", async () => {
    await t.pool.query(
      "insert into user_alerts (user_id, kind, title, body, href, dedupe_key) values ($1, 'stale_deal', 'Sitting with lenders for 4 days', '', '/deals/x', 'old-1')",
      [rep],
    );
    const feed = await t.db.withUser(rep, (q) => listAlerts(q));
    expect(feed.map((a) => a.kind)).not.toContain("stale_deal");
    const unread = await t.db.withUser(rep, (q) => unreadAlertCount(q));
    const live = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from user_alerts where user_id = $1 and read_at is null and kind = any($2::text[])",
      [rep, Object.keys(ALERT_KIND_LABELS)],
    );
    expect(unread).toBe(live.rows[0]!.n);
    expect(unread).toBeGreaterThan(0);
  });
});
