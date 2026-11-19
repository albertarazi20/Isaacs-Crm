import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceApproval } from "@/lib/approvals/engine";
import { createApproval, saveApprovalDesign } from "@/lib/approvals/mutations";
import { approvalSchema } from "@/lib/approvals/schemas";
import { runBucketSteps } from "@/lib/buckets/engine";
import { openApplicationPage } from "@/lib/docs/apply";
import { openUploadPage, rotateUploadToken } from "@/lib/docs/upload";
import { syncInbox } from "@/lib/inbox/sync";
import { isAutoReply } from "@/lib/inbox/autoReply";
import { merchantOwnWords, stripMerchantText, checkClaims } from "@/lib/messaging/claims";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { recordLinkOpen } from "@/lib/system/linkSignals";
import { resolveUnsubscribe, unsubscribeByToken } from "@/lib/system/replies";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Review fixes, proved in the database: a merge keeps the dropped card's links and addresses, a sync survives a
 * deleted message / skips auto-replies / stays inside a rep's own merchants, the claim check ignores the merchant's own
 * name, an unsent bucket step leaves a note, and a Pause no longer makes the rest of a sequence fire on consecutive days.
 */

let t: TestDb;
let rep: string;
let rep2: string;
let boss: string;
let dir: string;
const APP = "https://crm.test";
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;

let n = 0;
async function card(
  rows: Partial<{ email: string; phone: string; user: string; name: string }> = {},
) {
  n += 1;
  return one<{
    id: string;
    unsub: string;
    upload: string;
    apply: string;
    email: string;
    phone: string;
  }>(
    `insert into clients (user_id, business_name, contact_name, phone, email, state)
     values ($1, $2, 'rosa diaz', $3, $4, 'FL')
     returning id, unsubscribe_token as unsub, upload_token as upload, application_token as apply, email, phone`,
    [
      rows.user ?? rep,
      rows.name ?? `Shop ${n}`,
      rows.phone ?? `30555509${String(n).padStart(2, "0")}`,
      rows.email ?? `owner${n}@shop${n}.test`,
    ],
  );
}
const merge = (keep: string, drop: string) =>
  t.db.withUser(rep, (q) => q.query("select * from merge_clients($1, $2)", [keep, drop]));

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-fixes-"));
  process.env.DATABASE_URL = "postgres://unused@localhost/unused";
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.DOCS_DIR = dir;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  rep2 = await insertUser(t.pool, "rep2@x.com", "America/New_York");
  boss = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [boss]);
  await t.pool.query(
    "update app_users set name = 'Sam Rep', application_link = 'https://apply.test/x' where id = $1",
    [rep],
  );
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
    [rep],
  );
  await t.pool.query(
    "update shop_settings set postal_address = '5301 N Federal Hwy, Boca Raton, FL 33487', automation_from = ''",
  );
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("1. a merge keeps the dropped card's links and addresses", () => {
  it("old unsubscribe, upload and application links still resolve to the kept card; the other address and number are kept", async () => {
    const keep = await card({ email: "keep@a.test", phone: "3055550001" });
    const drop = await card({ email: "drop@b.test", phone: "(786) 555-0002" });
    // before: the dropped card's links belong to it
    expect((await resolveUnsubscribe(t.db, drop.unsub))?.clientId).toBe(drop.id);

    await merge(keep.id, drop.id);

    expect(await one("select 1 from clients where id = $1", [drop.id])).toBeUndefined();
    // the three links are on file, pointing at the kept card
    const aliases = await t.pool.query<{ kind: string; client_id: string }>(
      "select kind, client_id from client_token_aliases where token in ($1, $2, $3) order by kind",
      [drop.unsub, drop.upload, drop.apply],
    );
    expect(aliases.rows).toEqual([
      { kind: "application", client_id: keep.id },
      { kind: "unsubscribe", client_id: keep.id },
      { kind: "upload", client_id: keep.id },
    ]);
    // unsubscribe: the page resolves, the one-click POST works, and it is the KEPT card that is opted out
    expect((await resolveUnsubscribe(t.db, drop.unsub))?.clientId).toBe(keep.id);
    expect(await unsubscribeByToken(t.db, drop.unsub, "one_click")).toBe(true);
    expect(
      (
        await one<{ email_opt_out: boolean }>("select email_opt_out from clients where id = $1", [
          keep.id,
        ])
      ).email_opt_out,
    ).toBe(true);
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from suppressions where client_id = $1 and reason = 'unsubscribe'",
          [keep.id],
        )
      ).n,
    ).toBe(1);
    // upload and application links open the kept card's pages
    expect((await openUploadPage(t.db, drop.upload, t.today))?.client_id).toBe(keep.id);
    expect((await openApplicationPage(t.db, drop.apply))?.business_name).toMatch(/^Shop /);
    expect(await recordLinkOpen(t.db, "upload", drop.upload)).toBe(true);
    expect(
      (
        await one<{ n: number }>("select count(*)::int as n from link_opens where client_id = $1", [
          keep.id,
        ])
      ).n,
    ).toBe(1);
    // a made-up token is still nothing
    expect(await resolveUnsubscribe(t.db, "a".repeat(64))).toBeNull();
    // the other address and number are on the kept card, where inbound mail and duplicate checks look
    const k = await one<{ email: string; email2: string; phone: string; phone2: string }>(
      "select email, email2, phone, phone2 from clients where id = $1",
      [keep.id],
    );
    expect(k).toEqual({
      email: "keep@a.test",
      email2: "drop@b.test",
      phone: "3055550001",
      phone2: "(786) 555-0002",
    });
  });

  it("the same address on both cards is not copied, a blank one fills the main slot as before, and the second slot is not overwritten", async () => {
    const same = await card({ email: "same@a.test", phone: "(305) 555-0001" });
    const dup = await card({ email: "SAME@a.test", phone: "305-555-0001" });
    await merge(same.id, dup.id);
    expect(await one("select email2, phone2 from clients where id = $1", [same.id])).toEqual({
      email2: "",
      phone2: "",
    });

    const blank = await card({ email: "", phone: "" });
    await t.pool.query("update clients set email = '', phone = '' where id = $1", [blank.id]);
    const full = await card({ email: "full@a.test", phone: "3055550099" });
    await merge(blank.id, full.id);
    expect(
      await one("select email, email2, phone, phone2 from clients where id = $1", [blank.id]),
    ).toEqual({
      email: "full@a.test",
      email2: "",
      phone: "3055550099",
      phone2: "",
    });

    const k = await card({ email: "k@a.test" });
    await t.pool.query("update clients set email2 = 'mine@a.test' where id = $1", [k.id]);
    const d = await card({ email: "d@a.test" });
    await merge(k.id, d.id);
    expect(
      (await one<{ email2: string }>("select email2 from clients where id = $1", [k.id])).email2,
    ).toBe("mine@a.test");
    // the address that found no free slot is named in the merge note
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from activities where client_id = $1 and body like 'Merged with%Not kept%email d@a.test%'",
          [k.id],
        )
      ).n,
    ).toBe(1);
  });

  it("links survive a chain of merges, and resetting the upload link ends the old card's link too", async () => {
    const a = await card();
    const b = await card();
    const c = await card();
    await merge(b.id, a.id);
    await merge(c.id, b.id);
    for (const token of [a.unsub, b.unsub])
      expect((await resolveUnsubscribe(t.db, token))?.clientId).toBe(c.id);
    expect((await openUploadPage(t.db, a.upload, t.today))?.client_id).toBe(c.id);
    await t.db.withUser(rep, (q) => rotateUploadToken(q, c.id));
    expect(await openUploadPage(t.db, a.upload, t.today)).toBeNull();
    expect(await openUploadPage(t.db, b.upload, t.today)).toBeNull();
    // an unsubscribe link in an email already sent never stops working
    expect((await resolveUnsubscribe(t.db, a.unsub))?.clientId).toBe(c.id);
  });

  it("the alias table is system-only (a rep session cannot read or write it)", async () => {
    await expect(
      t.db.withUser(rep, (q) => q.query("select * from client_token_aliases")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.db.withUser(rep, (q) => q.query("delete from client_token_aliases")),
    ).rejects.toThrow(/permission denied/);
    const rls = await one<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'client_token_aliases'",
    );
    expect(rls.relrowsecurity).toBe(true);
  });

  it("a queued approval email moved to the kept card carries the old unsubscribe link, and it still works", async () => {
    const NOW = new Date("2026-11-18T19:00:00Z");
    // follow-up 1 (step 2) is the first email the system sends: the rep sends step 1 from their own mailbox
    await t.db.withUser(boss, (q) =>
      saveApprovalDesign(
        q,
        {
          step: 2,
          subject: "Your offer",
          html: `<html><head><title>x</title></head><body><p>Hi {{first_name}}</p>
<p>5301 N Federal Hwy, Boca Raton, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`,
          fileName: "",
        },
        boss,
      ),
    );
    const keep = await card();
    const drop = await card();
    const { approvalId } = await t.db.withUser(rep, (q) =>
      createApproval(
        q,
        {
          ...approvalSchema.parse({ clientId: drop.id, amount: "85000" }),
          firstSentAt: new Date(NOW.getTime() - 24 * 3_600_000),
        },
        { userId: rep, now: NOW, appUrl: APP },
      ),
    );
    const r = await t.db.withSystem((q) =>
      advanceApproval(q, approvalId, { now: NOW, appUrl: APP }),
    );
    expect(r).toMatchObject({ kind: "queued", step: 2 });
    await merge(keep.id, drop.id);
    const row = await one<{ client_id: string; html_body: string; status: string }>(
      "select client_id, html_body, status from outbox where lane = 'approval' and source like $1",
      [`approval:${approvalId}:%`],
    );
    expect(row.client_id).toBe(keep.id);
    expect(row.status).toBe("queued");
    expect(row.html_body).toContain(`/u/${drop.unsub}`);
    expect((await resolveUnsubscribe(t.db, drop.unsub))?.clientId).toBe(keep.id);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3, 4, 8: the inbox sync

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const AUTH = "mx.google.com; spf=pass smtp.mailfrom=shop.test; dkim=pass header.i=@shop.test";
function gmailMessage(
  id: string,
  from: string,
  subject: string,
  body: string,
  history: string,
  extra: { name: string; value: string }[] = [],
  authFor = "shop.test",
) {
  return {
    id,
    threadId: `t-${id}`,
    historyId: history,
    internalDate: String(Date.now() - 60_000),
    snippet: body,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "boss@selectivecap.com" },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@mail.test>` },
        {
          name: "Authentication-Results",
          value: AUTH.replaceAll("shop.test", authFor),
        },
        ...extra,
      ],
      body: { data: b64url(body) },
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** A fake Gmail: `ids` are listed; `messages` serve them; a value of a number is that HTTP status. */
function fakeGmail(
  messages: Record<string, ReturnType<typeof gmailMessage> | number>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (/\/messages\?/.test(u))
      return json({ messages: Object.keys(messages).map((id) => ({ id, threadId: `t-${id}` })) });
    const m = /\/messages\/([^/?]+)\?format=full/.exec(u);
    const found = m ? messages[m[1] ?? ""] : undefined;
    if (typeof found === "number") return new Response("nope", { status: found });
    return found ? json(found) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const sync = (fetchImpl: typeof fetch) =>
  syncInbox({ db: t.db, tokenFor: async () => "tok", fetchImpl, now: new Date() });
const cursor = async (user: string) =>
  (
    await t.pool.query<{ history_id: string | null }>(
      "select history_id from mail_sync_state where user_id = $1",
      [user],
    )
  ).rows[0]?.history_id ?? null;

describe("3. one deleted message does not stop the mailbox", () => {
  let mailbox: string;
  let pizza: string;
  beforeAll(async () => {
    mailbox = await insertUser(t.pool, "mb3@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [mailbox]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'mb3@gmail.com', 'enc', true)",
      [mailbox],
    );
    pizza = (await card({ email: "mike@shop.test", name: "Pizza Palace" })).id;
  });

  it("a 404 on one message is skipped and counted, the next reply is recorded and the cursor moves", async () => {
    const s = await sync(
      fakeGmail({
        gone: 404,
        ok: gmailMessage("ok", "Mike <mike@shop.test>", "Re: October", "Sending it tonight", "205"),
      }),
    );
    expect(s).toMatchObject({ mailboxes: 1, fetched: 2, unreadable: 1, failed: [] });
    expect(s.merchantReplies).toEqual([pizza]);
    expect(await cursor(mailbox)).toBe("205");
    expect(
      (
        await one<{ since: string | null }>(
          "select reply_waiting_since::text as since from clients where id = $1",
          [pizza],
        )
      ).since,
    ).not.toBeNull();
  });

  it("a server error still aborts the run and leaves the cursor where it was", async () => {
    await t.pool.query("update mail_sync_state set history_id = '205' where user_id = $1", [
      mailbox,
    ]);
    // no cursor path: the fallback search lists both; the second one fails with a 503
    await t.pool.query("update mail_sync_state set history_id = null where user_id = $1", [
      mailbox,
    ]);
    await t.pool.query("delete from inbound_emails where mailbox_user_id = $1", [mailbox]);
    const s = await sync(
      fakeGmail({
        fine: gmailMessage("fine", "Mike <mike@shop.test>", "Re: again", "Hello", "301"),
        boom: 503,
      }),
    );
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]?.error).toMatch(/Gmail 503/);
    expect(await cursor(mailbox)).toBeNull();
  });
});

describe("4. an auto-reply is not a reply", () => {
  it("header and subject rules", () => {
    expect(isAutoReply({ "auto-submitted": "auto-replied" }, "Re: hi")).toBe(true);
    expect(isAutoReply({ "auto-submitted": "no" }, "Re: hi")).toBe(false);
    expect(isAutoReply({ "x-autoreply": "yes" }, "Re: hi")).toBe(true);
    expect(isAutoReply({ precedence: "auto_reply" }, "Re: hi")).toBe(true);
    expect(isAutoReply({ precedence: "Bulk" }, "Re: hi")).toBe(true);
    expect(isAutoReply({ precedence: "junk" }, "Re: hi")).toBe(true);
    expect(isAutoReply({ "x-auto-response-suppress": "All" }, "Re: hi")).toBe(true);
    // the weak headers (bulk, junk, auto-response-suppress) never hide a real STOP from the sender
    expect(isAutoReply({ precedence: "bulk" }, "Re: hi", "Please stop emailing me")).toBe(false);
    expect(isAutoReply({ "x-auto-response-suppress": "All" }, "Re: hi", "STOP")).toBe(false);
    expect(isAutoReply({ precedence: "bulk" }, "Re: hi", "Thanks, will review")).toBe(true);
    // but a machine that says so outright stays an auto-reply whatever its text
    expect(isAutoReply({ "auto-submitted": "auto-replied" }, "Re: hi", "STOP")).toBe(true);
    expect(isAutoReply({}, "Automatic reply: Your statements")).toBe(true);
    expect(isAutoReply({}, "Out of Office: Your statements")).toBe(true);
    expect(isAutoReply({}, "Re: Out of office until Monday")).toBe(true);
    expect(isAutoReply({}, "Re: Your statements")).toBe(false);
    expect(isAutoReply({}, "Out of office hours: can you call later?")).toBe(false);
  });

  it("an out-of-office from the merchant is stored apart: no reply flag, the sequence keeps running, a real reply still counts", async () => {
    const mb = await insertUser(t.pool, "mb4@x.com", "America/New_York");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [mb]);
    await t.pool.query("delete from gmail_connections where user_id <> $1 and can_read_mail", [mb]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'mb4@gmail.com', 'enc', true)",
      [mb],
    );
    const c = await card({ email: "ooo@shop.test" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    const s = await sync(
      fakeGmail({
        auto: gmailMessage(
          "auto",
          "Owner <ooo@shop.test>",
          "Automatic reply: Re: your offer",
          "I am away",
          "401",
          [{ name: "Auto-Submitted", value: "auto-replied" }],
        ),
        ooo2: gmailMessage(
          "ooo2",
          "Owner <ooo@shop.test>",
          "Out of Office",
          "STOP all mail while I am away",
          "402",
        ),
      }),
    );
    expect(s.merchantReplies).toEqual([]);
    expect(s.autoReplies).toBe(2);
    const rows = await t.pool.query<{ client_id: string | null; kind: string; matched_by: string }>(
      "select client_id, kind, matched_by from inbound_emails where mailbox_user_id = $1 order by gmail_id",
      [mb],
    );
    expect(rows.rows).toEqual([
      { client_id: null, kind: "other", matched_by: "none" },
      { client_id: null, kind: "other", matched_by: "none" },
    ]);
    const after = await one<{ since: string | null; opt: boolean }>(
      "select reply_waiting_since::text as since, email_opt_out as opt from clients where id = $1",
      [c.id],
    );
    expect(after).toEqual({ since: null, opt: false });
    // the follow-up is still running
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
          [c.id],
        )
      ).n,
    ).toBe(1);
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from activities where client_id = $1 and body like 'Automatic reply received%'",
          [c.id],
        )
      ).n,
    ).toBe(2);
    // the merchant then really writes: that one counts
    const s2 = await sync(
      fakeGmail({
        real: gmailMessage(
          "real",
          "Owner <ooo@shop.test>",
          "Re: your offer",
          "Call me tomorrow",
          "403",
        ),
      }),
    );
    expect(s2.merchantReplies).toEqual([c.id]);
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from enrollments where client_id = $1 and stopped_at is null",
          [c.id],
        )
      ).n,
    ).toBe(0);
  });
});

describe("8. a rep's mailbox reads only that rep's merchants", () => {
  it("rep mailbox ignores another rep's merchant (nothing stored); a manager mailbox still matches it; email2 matches", async () => {
    const repMb = rep;
    await t.pool.query("delete from gmail_connections where can_read_mail");
    await t.pool.query("delete from mail_sync_state");
    await t.pool.query("update gmail_connections set can_read_mail = false");
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'rep@gmail.com', 'enc', true) on conflict (user_id) do update set can_read_mail = true, status = 'ok'",
      [repMb],
    );
    const mine = await card({ email: "mine@shop.test", user: rep });
    await t.pool.query("update clients set email2 = 'mine2@shop.test' where id = $1", [mine.id]);
    const theirs = await card({ email: "theirs@shop.test", user: rep2 });
    const feed = fakeGmail({
      a: gmailMessage("a", "Mine <mine@shop.test>", "Re: offer", "yes please", "501"),
      b: gmailMessage("b", "Theirs <theirs@shop.test>", "Re: offer", "yes please", "502"),
      c: gmailMessage("c", "Mine <mine2@shop.test>", "Re: offer", "second address", "503"),
    });
    const s = await sync(feed);
    expect(s.merchantReplies.sort()).toEqual([mine.id, mine.id].sort());
    expect(
      (
        await t.pool.query(
          "select 1 from inbound_emails where mailbox_user_id = $1 and from_address = 'theirs@shop.test'",
          [repMb],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await one<{ since: string | null }>(
          "select reply_waiting_since::text as since from clients where id = $1",
          [theirs.id],
        )
      ).since,
    ).toBeNull();
    expect(
      (await t.pool.query("select 1 from inbound_emails where mailbox_user_id = $1", [repMb]))
        .rowCount,
    ).toBe(2);

    // the manager's mailbox sees every merchant
    await t.pool.query("update gmail_connections set can_read_mail = false where user_id = $1", [
      repMb,
    ]);
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true)",
      [boss],
    );
    const s2 = await sync(feed);
    expect(s2.merchantReplies).toContain(theirs.id);
    expect(
      (
        await one<{ since: string | null }>(
          "select reply_waiting_since::text as since from clients where id = $1",
          [theirs.id],
        )
      ).since,
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5: the claim check ignores the merchant's own name

describe("5. the merchant's own business name is not the shop's claim", () => {
  it("pure: only the merchant's words are removed", () => {
    expect(checkClaims("Hi Mike, about Guaranteed Roofing").ok).toBe(false);
    const own = merchantOwnWords({ businessName: "Guaranteed Roofing", contactName: "Mike" });
    expect(checkClaims(stripMerchantText("Hi Mike, about Guaranteed Roofing", own)).ok).toBe(true);
    expect(
      checkClaims(
        stripMerchantText(
          "About Mike's Loan Office: the link",
          merchantOwnWords({ businessName: "Mike's Loan Office" }),
        ),
      ).ok,
    ).toBe(true);
    // the same word on its own, said by the shop, still counts
    expect(
      checkClaims(stripMerchantText("Guaranteed Roofing: funding is guaranteed", own)).reasons,
    ).toEqual(['Says "guaranteed": nothing in funding is guaranteed']);
    expect(
      checkClaims(
        stripMerchantText(
          "We can offer you a loan for Loan Office",
          merchantOwnWords({ businessName: "Loan Office" }),
        ),
      ).ok,
    ).toBe(false);
    // a name that trips nothing is never touched
    expect(stripMerchantText("Hi Al, you are approved", ["Al"])).toBe("Hi Al, you are approved");
  });

  const sent: string[] = [];
  const deliver: Deliverer = {
    gmail: async (_u, m) => (sent.push(m.subject), `g_${sent.length}`),
    resend: async (m) => (sent.push(m.subject), `r_${sent.length}`),
  };
  const IN_WINDOW = new Date("2026-11-16T15:00:00Z");
  const queueFor = async (clientId: string, text: string, k: number) =>
    t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId, lane: "sequence", source: `bucket:b${k}:step:1`, subject: "Quick note", text },
        IN_WINDOW,
      ),
    );

  it.each([["Guaranteed Roofing"], ["Mike's Loan Office"], ["Loan Office"]])(
    "a sequence email to %s goes out",
    async (name) => {
      const c = await card({ name });
      const r = await queueFor(c.id, `Hi Rosa,\n\nWe would love to help ${name} grow.\n\nSam`, n);
      expect(r.queued).toBe(true);
      const s = await drainOutbox({ db: t.db, deliver, now: IN_WINDOW, appUrl: APP });
      expect(s.sent).toBe(1);
      expect(
        (
          await one<{ status: string }>("select status from outbox where id = $1", [
            (r as { outboxId: string }).outboxId,
          ])
        ).status,
      ).toBe("sent");
    },
  );

  it("but the shop's own claim next to such a name is still held", async () => {
    const c = await card({ name: "Guaranteed Roofing" });
    const r = await queueFor(
      c.id,
      "Hi Rosa,\n\nGuaranteed Roofing, funding is guaranteed.\n\nSam",
      n,
    );
    const s = await drainOutbox({ db: t.db, deliver, now: IN_WINDOW, appUrl: APP });
    expect(s.sent).toBe(0);
    expect(
      (
        await one<{ last_error: string }>("select last_error from outbox where id = $1", [
          (r as { outboxId: string }).outboxId,
        ])
      ).last_error,
    ).toBe("claim_check");
  });

  it("an approval email to a merchant called Guaranteed Roofing is queued, not held", async () => {
    const NOW = new Date("2026-11-18T19:00:00Z");
    await t.db.withUser(boss, (q) =>
      saveApprovalDesign(
        q,
        {
          step: 2,
          subject: "About {{business_name}}",
          html: `<html><head><title>x</title></head><body><p>Hi {{first_name}}, your file for {{business_name}} is ready.</p>
<p>5301 N Federal Hwy, Boca Raton, FL 33487 <a href="{{unsubscribe_link}}">Unsubscribe</a></p></body></html>`,
          fileName: "",
        },
        boss,
      ),
    );
    const c = await card({ name: "Guaranteed Roofing & Loan Office" });
    const { approvalId } = await t.db.withUser(rep, (q) =>
      createApproval(
        q,
        {
          ...approvalSchema.parse({ clientId: c.id, amount: "85000" }),
          firstSentAt: new Date(NOW.getTime() - 24 * 3_600_000),
        },
        { userId: rep, now: NOW, appUrl: APP },
      ),
    );
    const r = await t.db.withSystem((q) =>
      advanceApproval(q, approvalId, { now: NOW, appUrl: APP }),
    );
    expect(r).toMatchObject({ kind: "queued", step: 2 });
    expect(
      (
        await one<{ n: number }>(
          "select count(*)::int as n from outbox where lane = 'approval' and source like $1",
          [`approval:${approvalId}:%`],
        )
      ).n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6 and 7: unsent bucket steps, and a Pause

describe("6. a bucket step that expires unsent is written on the timeline and not counted", () => {
  it("the expiry leaves a note and steps_sent drops; the call note counts emails that really went out", async () => {
    const c = await card({ email: "six@shop.test", name: "Six Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    const s = await runBucketSteps({ db: t.db, appUrl: APP });
    expect(s.emailed).toBeGreaterThanOrEqual(1);
    const enr = () =>
      one<{ steps_sent: number }>(
        "select steps_sent from enrollments where client_id = $1 and stopped_at is null",
        [c.id],
      );
    expect((await enr()).steps_sent).toBe(1);
    const row = await one<{ id: string; source: string }>(
      "select id, source from outbox where client_id = $1 and lane = 'sequence'",
      [c.id],
    );
    // the rep's Gmail was never connected for this row: it sat past its 36 hours
    await t.pool.query(
      "update outbox set expires_at = now() - interval '1 hour', last_error = 'gmail_not_connected', not_before = now() - interval '1 minute' where id = $1",
      [row.id],
    );
    const d = await drainOutbox({
      db: t.db,
      deliver: { gmail: async () => "g", resend: async () => "r" },
      now: new Date(),
      appUrl: APP,
    });
    expect(d.skipped).toBe(1);
    expect(
      await one<{ status: string; skip_reason: string }>(
        "select status, skip_reason from outbox where id = $1",
        [row.id],
      ),
    ).toEqual({ status: "skipped", skip_reason: "expired" });
    const note = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Bucket email step%'",
      [c.id],
    );
    expect(note.rows).toEqual([
      { body: "Bucket email step 1 expired unsent: the rep's Gmail is not connected" },
    ]);
    expect((await enr()).steps_sent).toBe(0);

    // the call step: one email really went out, one expired: "no reply to 1 email", not 2
    await t.pool.query(
      `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, status, sent_at, expires_at)
       select $1, $2, 'sequence', $3, 'six@shop.test', 's', 't', 'sent', now() - interval '3 days', null`,
      [rep, c.id, row.source.replace(":step:1", ":step:2")],
    );
    await t.pool.query(
      "update enrollments set next_step = 3, steps_sent = 2, next_due_on = current_date - 1 where client_id = $1 and stopped_at is null",
      [c.id],
    );
    const s2 = await runBucketSteps({ db: t.db, appUrl: APP });
    expect(s2.called).toBeGreaterThanOrEqual(1);
    const timer = await t.pool.query<{ note: string }>(
      "select note from timers where client_id = $1 and note like 'Call:%'",
      [c.id],
    );
    expect(timer.rows[0]?.note).toMatch(/^Call: no reply to 1 email \(/);
  });

  it("a sequence that ends with nothing sent says so before it hands over to Cold", async () => {
    const c = await card({ email: "seven@shop.test", name: "Seven Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    // jump to the last step with no email ever sent or queued
    await t.pool.query("delete from outbox where client_id = $1", [c.id]);
    await t.pool.query(
      "update enrollments set next_step = 5, next_due_on = current_date - 1 where client_id = $1 and stopped_at is null",
      [c.id],
    );
    await runBucketSteps({ db: t.db, appUrl: APP });
    const note = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and body like '%sequence ended with none of its emails actually sent'",
      [c.id],
    );
    expect(note.rows).toHaveLength(1);
  });
});

describe("7. un-pausing after a long pause keeps the spacing between steps", () => {
  const live = (id: string) =>
    one<{ next_due_on: string; entered_at: string; paused_at: string | null; next_step: number }>(
      "select next_due_on::text, entered_at::text, paused_at::text, next_step from enrollments where client_id = $1 and stopped_at is null",
      [id],
    );
  it("a rep's pause of 30 days moves the next step and the offsets forward by 30 days", async () => {
    const c = await card({ email: "pause@shop.test", name: "Pause Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    await runBucketSteps({ db: t.db, appUrl: APP }); // step 1 goes; step 2 is scheduled two days on
    const before = await live(c.id);
    expect(before.next_step).toBe(2);
    await t.db.withUser(rep, (q) => q.query("select set_enrollment_paused($1, true)", [c.id]));
    expect((await live(c.id)).paused_at).not.toBeNull();
    // thirty days go by while it is paused: the stored dates are 30 days old and so is the pause
    await t.pool.query(
      `update enrollments set entered_at = entered_at - interval '30 days', next_due_on = next_due_on - 30,
              paused_at = paused_at - interval '30 days' where client_id = $1 and stopped_at is null`,
      [c.id],
    );
    await t.db.withUser(rep, (q) => q.query("select set_enrollment_paused($1, false)", [c.id]));
    const after = await live(c.id);
    expect(after.next_due_on).toBe(before.next_due_on);
    expect(after.paused_at).toBeNull();
    expect(
      (
        await one<{ days: number }>(
          "select extract(epoch from ($1::timestamptz - $2::timestamptz)) / 86400 as days",
          [after.entered_at, before.entered_at],
        )
      ).days,
    ).toBeCloseTo(0, 0);
    // step 2 is not due on the resume day: it is the schedule's two days from the original start, not today
    const s = await runBucketSteps({ db: t.db, appUrl: APP });
    expect(s.due).toBe(0);
  });

  it("a dated pause that the engine lifts shifts the same way; a 'not now' pause (its own dates) is left alone", async () => {
    const c = await card({ email: "dated@shop.test", name: "Dated Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    await runBucketSteps({ db: t.db, appUrl: APP });
    const before = await live(c.id);
    await t.db.withUser(rep, (q) => q.query("select set_enrollment_paused($1, true)", [c.id]));
    await t.pool.query(
      `update enrollments set resume_on = current_date - 1, entered_at = entered_at - interval '10 days',
              next_due_on = next_due_on - 10, paused_at = paused_at - interval '10 days'
        where client_id = $1 and stopped_at is null`,
      [c.id],
    );
    const s = await runBucketSteps({ db: t.db, appUrl: APP });
    expect(s.resumed).toBeGreaterThanOrEqual(1);
    expect((await live(c.id)).next_due_on).toBe(before.next_due_on);

    // a pause that set its own dates has no paused_at: nothing is shifted when it lifts
    const d = await card({ email: "notnow@shop.test", name: "Not Now Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        d.id,
      ]),
    );
    await t.pool.query(
      `update enrollments set paused = true, resume_on = current_date - 1, next_due_on = current_date
        where client_id = $1 and stopped_at is null`,
      [d.id],
    );
    const before2 = await live(d.id);
    await t.pool.query(
      "update enrollments set paused = false where client_id = $1 and stopped_at is null",
      [d.id],
    );
    expect(await live(d.id)).toEqual(before2);
  });

  it("a rep's pause followed by a 'not now' reply keeps the revive day: the earlier pause adds nothing on top", async () => {
    const c = await card({ email: "both@shop.test", name: "Both Co" });
    await t.db.withUser(rep, async (q) =>
      q.query("select enroll_in_bucket($1, (select id from buckets where key = 'interested'))", [
        c.id,
      ]),
    );
    await runBucketSteps({ db: t.db, appUrl: APP });
    await t.db.withUser(rep, (q) => q.query("select set_enrollment_paused($1, true)", [c.id]));
    // the rep paused 39 days ago (stamped), then the merchant said "not now": the same row gets its own revive dates
    await t.pool.query(
      "update enrollments set paused_at = paused_at - interval '39 days' where client_id = $1 and stopped_at is null",
      [c.id],
    );
    await t.pool.query(
      `update enrollments set paused = true, resume_on = current_date - 1, next_step = 1, next_due_on = current_date,
              entered_at = now() where client_id = $1 and stopped_at is null`,
      [c.id],
    );
    expect((await live(c.id)).paused_at).toBeNull(); // its own dates cleared the rep's stamp
    const revive = await live(c.id);
    await t.pool.query(
      "update enrollments set paused = false where client_id = $1 and stopped_at is null",
      [c.id],
    );
    const after = await live(c.id);
    expect(after.next_due_on).toBe(revive.next_due_on);
    expect(after.entered_at).toBe(revive.entered_at);
  });
});
