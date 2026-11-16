import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  verifyReply,
  type ClassifierResult,
  type ClassifyInput,
  type ClassifyOutcome,
} from "@/lib/ai/classifyReply";
import { runBucketSteps } from "@/lib/buckets/engine";
import { tagMerchantReplies, type ReplyReader } from "@/lib/messaging/replyTags";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/** Stream 1, S1-6: merchant replies tagged by Claude, with the code-side check, the kill switch and the cap. */

let t: TestDb;
let rep: string;
let statements: string;

const answers = new Map<string, Partial<ClassifierResult>>();
let calls = 0;
const reader: ReplyReader = async (i: ClassifyInput, model) => {
  calls += 1;
  const a = answers.get(i.subject);
  if (!a) throw new Error(`no scripted answer for ${i.subject}`);
  const result: ClassifierResult = {
    tag: "other",
    quote: "",
    not_now_days: null,
    summary: "scripted",
    confidence: 0.9,
    ...a,
  };
  const out: ClassifyOutcome = {
    result,
    model,
    inputTokens: 500,
    outputTokens: 60,
    inputHash: "h",
    supported: verifyReply(i, result),
  };
  return out;
};

const client = async (name: string, email: string) => {
  const id = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Rosa', '3055550100', $3, 'FL') returning id",
      [rep, name, email],
    )
  ).rows[0]!.id;
  await t.pool.query("select enroll_in_bucket($1, $2)", [id, statements]);
  return id;
};
/** What the inbox sync does with a merchant's reply: the record, then the stored email. */
const reply = async (clientId: string, subject: string, text: string) => {
  const email = (
    await t.pool.query<{ email: string }>("select email from clients where id = $1", [clientId])
  ).rows[0]!.email;
  await t.pool.query("select record_merchant_reply($1, $2, $3, $4, false)", [
    clientId,
    subject,
    text.slice(0, 100),
    email,
  ]);
  return (
    await t.pool.query<{ id: string }>(
      `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, from_address, from_name, subject, snippet, text_body,
                                   received_at, client_id, matched_by, kind)
       values ($1, $2, 'th', $3, 'Rosa', $4, $5, $6, now(), $7, 'merchant_reply', 'merchant') returning id`,
      [rep, `g-${subject}`, email, subject, text.slice(0, 100), text, clientId],
    )
  ).rows[0]!.id;
};
const enrolment = async (clientId: string) =>
  (
    await t.pool.query<{
      paused: boolean;
      resume_on: string | null;
      next_step: number;
      next_due_on: string | null;
      stopped_at: string | null;
      stop_reason: string | null;
      key: string;
    }>(
      `select e.paused, e.resume_on::text, e.next_step, e.next_due_on::text, e.stopped_at, e.stop_reason, b.key
         from enrollments e join buckets b on b.id = e.bucket_id where e.client_id = $1 order by e.created_at desc limit 1`,
      [clientId],
    )
  ).rows[0]!;
const tagOf = async (emailId: string) =>
  (
    await t.pool.query<{ tag: string; supported: boolean; revive_on: string | null }>(
      "select tag, supported, revive_on::text from reply_tags where email_id = $1",
      [emailId],
    )
  ).rows[0];
const lines = async (clientId: string) =>
  (
    await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 order by occurred_at, id",
      [clientId],
    )
  ).rows.map((r) => r.body);

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  await t.pool.query(
    "update app_users set application_link = 'https://apply.test/x', name = 'Sam Rep' where id = $1",
    [rep],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
  statements = (
    await t.pool.query<{ id: string }>("select id from buckets where key = 'missing_statements'")
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("S1-6: merchant reply tagging", () => {
  it("the code-side check: the quoted words must be the merchant's own, not our quoted email under them", () => {
    const text =
      "Not right now, check back in a month.\n\nOn Mon, Nov 10, 2026 Sam Rep wrote:\n> Here is the upload link, you are approved for a look";
    const i = { from: "rosa@x.com", subject: "Re: statements", text };
    const r = (tag: ClassifierResult["tag"], quote: string): ClassifierResult => ({
      tag,
      quote,
      not_now_days: null,
      summary: "",
      confidence: 0.9,
    });
    expect(verifyReply(i, r("not_now", "check back in a month"))).toBe(true);
    expect(verifyReply(i, r("not_now", "Check Back In A Month"))).toBe(true);
    expect(verifyReply(i, r("interested", "you are approved for a look"))).toBe(false);
    expect(verifyReply(i, r("interested", "next spring"))).toBe(false);
    expect(verifyReply(i, r("other", ""))).toBe(true);
  });

  it("not_now: the chase pauses until the revive date, then the engine re-opens it from step 1 on the day", async () => {
    const id = await client("Later Co", "later@x.com");
    expect((await enrolment(id)).stop_reason).toBeNull();
    const emailId = await reply(
      id,
      "Re: Bank statements",
      "Not right now — check back in a month, things are slow.",
    );
    // the sync already stopped the chase on the reply
    expect((await enrolment(id)).stop_reason).toBe("replied");
    answers.set("Re: Bank statements", {
      tag: "not_now",
      quote: "check back in a month",
      not_now_days: 30,
    });
    const s = await tagMerchantReplies({ db: t.db, reader });
    expect(s).toMatchObject({ read: 1, tagged: 1, failed: 0 });
    expect(s.byTag.not_now).toBe(1);
    const revive = (
      await t.pool.query<{ d: string }>(
        "select ((now() at time zone 'America/New_York')::date + 30)::text as d",
      )
    ).rows[0]!.d;
    expect(await tagOf(emailId)).toEqual({ tag: "not_now", supported: true, revive_on: revive });
    expect(
      (
        await t.pool.query<{ revive_on: string }>(
          "select revive_on::text from clients where id = $1",
          [id],
        )
      ).rows[0]?.revive_on,
    ).toBe(revive);
    let e = await enrolment(id);
    expect(e).toMatchObject({
      paused: true,
      resume_on: revive,
      next_step: 1,
      next_due_on: revive,
      stopped_at: null,
      key: "missing_statements",
    });
    expect(await lines(id)).toContain(
      `Merchant said not now — follow-up emails paused until ${new Date(`${revive}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
    );

    // the day before: still paused, nothing queued
    const dayBefore = new Date(new Date(`${revive}T16:00:00Z`).getTime() - 86_400_000);
    let run = await runBucketSteps({ db: t.db, now: dayBefore, appUrl: "https://crm.test" });
    expect(run.resumed).toBe(0);
    expect((await enrolment(id)).paused).toBe(true);
    // the revive day (11:00 in the merchant's zone): the pause lifts and step 1 is queued
    run = await runBucketSteps({
      db: t.db,
      now: new Date(`${revive}T16:00:00Z`),
      appUrl: "https://crm.test",
    });
    expect(run.resumed).toBe(1);
    e = await enrolment(id);
    expect(e).toMatchObject({ paused: false, resume_on: null, stopped_at: null });
    expect(e.next_step).toBe(2);
    const ob = await t.pool.query<{ source: string; status: string }>(
      "select source, status from outbox where client_id = $1 and status = 'queued'",
      [id],
    );
    expect(ob.rows).toHaveLength(1);
    expect(ob.rows[0]?.source).toBe(`bucket:${statements}:step:1`);
    expect(
      (await t.pool.query("select revive_on from clients where id = $1", [id])).rows[0]?.revive_on,
    ).toBeNull();
    expect((await lines(id)).at(-1)).toMatch(/^Follow-up emails resumed/);
  });

  it("wrong_person flags the merchant and opens the rep's task today; stop opts out; the rest are kept as tags", async () => {
    const wrong = await client("Wrong Co", "wrong@x.com");
    const stop = await client("Stop Co", "stop@x.com");
    const yes = await client("Yes Co", "yes@x.com");
    const docs = await client("Docs Co", "docs@x.com");
    await reply(wrong, "Re: Wrong", "You have the wrong person, I sold the shop last year.");
    await reply(stop, "Re: Stop", "Please take me off this list.");
    await reply(yes, "Re: Yes", "Yes, send me the numbers, I can do a call tomorrow.");
    await reply(docs, "Re: Docs", "Statements attached, let me know if you need October too.");
    answers.set("Re: Wrong", { tag: "wrong_person", quote: "wrong person, I sold the shop" });
    answers.set("Re: Stop", { tag: "stop", quote: "take me off this list" });
    answers.set("Re: Yes", { tag: "interested", quote: "send me the numbers" });
    answers.set("Re: Docs", { tag: "sending_docs", quote: "Statements attached" });
    const s = await tagMerchantReplies({ db: t.db, reader });
    expect(s).toMatchObject({ read: 4, tagged: 4, failed: 0 });
    expect(s.byTag).toMatchObject({ wrong_person: 1, stop: 1, interested: 1, sending_docs: 1 });

    const flagged = (
      await t.pool.query<{ wrong_person_at: string | null }>(
        "select wrong_person_at from clients where id = $1",
        [wrong],
      )
    ).rows[0];
    expect(flagged?.wrong_person_at).not.toBeNull();
    const task = await t.pool.query<{ kind: string; due_on: string; note: string }>(
      "select kind, due_on::text, note from timers where client_id = $1 and done_at is null and note like 'Wrong person%'",
      [wrong],
    );
    const today = (
      await t.pool.query<{ d: string }>(
        "select (now() at time zone 'America/New_York')::date::text as d",
      )
    ).rows[0]!.d;
    expect(task.rows).toEqual([
      {
        kind: "follow_up",
        due_on: today,
        note: "Wrong person on the email — find the right contact",
      },
    ]);

    const stopped = (
      await t.pool.query<{ email_opt_out: boolean; reason: string | null }>(
        "select c.email_opt_out, (select reason from suppressions s where s.client_id = c.id) as reason from clients c where c.id = $1",
        [stop],
      )
    ).rows[0];
    expect(stopped).toEqual({ email_opt_out: true, reason: "stop_reply" });

    expect(await lines(yes)).toContain("Reply tagged: interested");
    expect(await lines(docs)).toContain("Reply tagged: sending docs");
    const tags = await t.pool.query<{ tag: string }>(
      "select tag from reply_tags where client_id = any($1::uuid[]) order by tag",
      [[yes, docs]],
    );
    expect(tags.rows.map((r) => r.tag)).toEqual(["interested", "sending_docs"]);
  });

  it("a tag whose words are not in the reply is stored as other and changes nothing; an email is never read twice", async () => {
    const id = await client("Vague Co", "vague@x.com");
    const emailId = await reply(id, "Re: Vague", "ok");
    answers.set("Re: Vague", {
      tag: "not_now",
      quote: "check back next spring",
      not_now_days: 120,
    });
    const s = await tagMerchantReplies({ db: t.db, reader });
    expect(s.byTag.other).toBe(1);
    expect(await tagOf(emailId)).toEqual({ tag: "other", supported: false, revive_on: null });
    expect(
      (await t.pool.query("select revive_on from clients where id = $1", [id])).rows[0]?.revive_on,
    ).toBeNull();
    expect((await enrolment(id)).stop_reason).toBe("replied");
    const before = calls;
    expect(await tagMerchantReplies({ db: t.db, reader })).toMatchObject({ read: 0, tagged: 0 });
    expect(calls).toBe(before);
    const runs = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from ai_runs where purpose = 'classify_reply' and error is null",
    );
    expect(runs.rows[0]?.n).toBe(6);
  });

  it("the kill switch and the daily spend cap stop the classifier", async () => {
    const id = await client("Capped Co", "capped@x.com");
    await reply(id, "Re: Capped", "Sure, what do you need?");
    answers.set("Re: Capped", { tag: "interested", quote: "what do you need" });
    await t.pool.query("update shop_settings set ai_enabled = false");
    expect(await tagMerchantReplies({ db: t.db, reader })).toMatchObject({ read: 0, skipped: 0 });
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 0");
    expect(await tagMerchantReplies({ db: t.db, reader })).toMatchObject({ read: 0, skipped: 1 });
    await t.pool.query("update shop_settings set ai_daily_cap_cents = 2000");
    expect(await tagMerchantReplies({ db: t.db, reader })).toMatchObject({ read: 1, tagged: 1 });
  });
});
