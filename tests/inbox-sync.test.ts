import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncInbox } from "@/lib/inbox/sync";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

/**
 * The inbox job's one remaining read: a merchant writing back. A fake Gmail serves three messages; the database
 * says what the sync did with each.
 */

const b64url = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");
const pdf = new TextEncoder().encode("%PDF-1.4\n% statement\n%%EOF\n");

let t: TestDb;
let dir: string;
let rep: string;
let manager: string;
let pizza: string;
let taco: string;
let prevName: string;
let prev: string;

const message = (
  id: string,
  from: string,
  subject: string,
  body: string,
  auth: string,
  history: string,
  attachment?: { filename: string; id: string },
) => ({
  id,
  threadId: `t-${id}`,
  historyId: history,
  internalDate: String(Date.now() - 60_000),
  snippet: body,
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "boss@selectivecap.com" },
      { name: "Subject", value: subject },
      { name: "Message-ID", value: `<${id}@mail.test>` },
      { name: "Authentication-Results", value: auth },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64url(body) } },
      ...(attachment
        ? [
            {
              mimeType: "application/pdf",
              filename: attachment.filename,
              body: { attachmentId: attachment.id, size: pdf.length },
            },
          ]
        : []),
    ],
  },
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "isaac-sync-"));
  // the sync files attachments through the environment's document store
  process.env.DATABASE_URL = "postgres://unused@localhost/unused";
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.DOCS_DIR = dir;
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  manager = await insertUser(t.pool, "boss@x.com", "America/New_York");
  await t.pool.query("update app_users set role = 'manager', name = 'Boss' where id = $1", [
    manager,
  ]);
  await t.pool.query(
    "insert into gmail_connections (user_id, google_email, refresh_token_enc, can_read_mail) values ($1, 'boss@gmail.com', 'enc', true)",
    [manager],
  );
  pizza = await insertClient(t.db, rep, "Pizza Palace");
  taco = await insertClient(t.db, rep, "Taco Town");
  await t.pool.query("update clients set email = 'mike@pizza.com' where id = $1", [pizza]);
  await t.pool.query("update clients set email = 'tina@taco.com' where id = $1", [taco]);
  const d = await t.pool.query<{ p: string; n: string }>(
    "select (date_trunc('month', current_date) - interval '1 month')::date::text as p, to_char(date_trunc('month', current_date) - interval '1 month', 'Mon_YYYY') as n",
  );
  prev = d.rows[0]!.p;
  prevName = d.rows[0]!.n;
  await t.db.withUser(rep, (q) =>
    q.query("select add_stips($1, $2::jsonb)", [
      pizza,
      JSON.stringify([{ kind: "bank_statement", period: prev }]),
    ]),
  );
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

const gmail = (async (url: string | URL | Request) => {
  const msgs: Record<string, ReturnType<typeof message>> = {
    m1: message(
      "m1",
      "Mike Ross <mike@pizza.com>",
      "Re: October statement",
      "Sending it tonight",
      "mx.google.com; spf=pass smtp.mailfrom=pizza.com; dkim=pass header.i=@pizza.com",
      "101",
      { filename: `Chase_Statement_${prevName}.pdf`, id: "att1" },
    ),
    m2: message(
      "m2",
      "Deals Weekly <news@vendor.com>",
      "Ten rates you will love",
      "Unsubscribe any time",
      "mx.google.com; spf=pass; dkim=pass",
      "102",
    ),
    // a message that claims to be Tina but fails SPF and DKIM: it must not stop her sequence or tick anything
    m3: message(
      "m3",
      "Tina <tina@taco.com>",
      "Re: statements",
      "STOP",
      "mx.google.com; spf=fail; dkim=none",
      "103",
    ),
  };
  const u = String(url);
  if (u.includes("/attachments/att1")) return json({ data: b64url(pdf), size: pdf.length });
  if (/\/messages\?/.test(u))
    return json({ messages: Object.keys(msgs).map((id) => ({ id, threadId: `t-${id}` })) });
  const m = /\/messages\/([^/?]+)\?format=full/.exec(u);
  const found = m ? msgs[m[1] ?? ""] : undefined;
  return found ? json(found) : new Response("not found", { status: 404 });
}) as typeof fetch;

describe("syncing a mailbox for merchant replies", () => {
  it("records a verified merchant reply, files its attachment, and ignores everything else", async () => {
    const tokens: string[] = [];
    const s = await syncInbox({
      db: t.db,
      tokenFor: async (userId) => (tokens.push(userId), "tok"),
      fetchImpl: gmail,
      now: new Date(),
    });
    expect(tokens).toEqual([manager]);
    expect(s).toMatchObject({ mailboxes: 1, fetched: 3, filed: 1, unverified: 1, failed: [] });
    expect(s.merchantReplies).toEqual([pizza]);

    // Mike's reply: stored as a merchant email, the sequence stops and the flag is raised for the rep
    const stored = await t.pool.query<{ client_id: string; kind: string; matched_by: string }>(
      "select client_id, kind, matched_by from inbound_emails where from_address = 'mike@pizza.com'",
    );
    expect(stored.rows).toEqual([
      { client_id: pizza, kind: "merchant", matched_by: "merchant_reply" },
    ]);
    const flag = await t.pool.query<{ since: string | null; subject: string | null }>(
      "select reply_waiting_since::text as since, reply_waiting_subject as subject from clients where id = $1",
      [pizza],
    );
    expect(flag.rows[0]?.since).not.toBeNull();
    expect(flag.rows[0]?.subject).toBe("Re: October statement");
    // the statement he attached is a document and ticks the checklist
    const docs = await t.pool.query<{ kind: string; source: string }>(
      "select kind, source from documents where client_id = $1",
      [pizza],
    );
    expect(docs.rows).toEqual([{ kind: "bank_statement", source: "email" }]);
    expect(
      (
        await t.pool.query<{ r: string | null }>(
          "select received_at::text as r from stips where client_id = $1",
          [pizza],
        )
      ).rows[0]?.r,
    ).not.toBeNull();

    // the newsletter is not a merchant: nothing of it is kept
    expect(
      (await t.pool.query("select 1 from inbound_emails where from_address = 'news@vendor.com'"))
        .rowCount,
    ).toBe(0);
    // the forged "STOP" did not opt Tina out, flag her, or suppress her address
    const tina = await t.pool.query<{ email_opt_out: boolean; since: string | null }>(
      "select email_opt_out, reply_waiting_since::text as since from clients where id = $1",
      [taco],
    );
    expect(tina.rows[0]).toEqual({ email_opt_out: false, since: null });
    expect((await t.pool.query("select 1 from suppressions")).rowCount).toBe(0);

    // the sync remembers where it got to
    const state = await t.pool.query<{ history_id: string | null; last_error: string | null }>(
      "select history_id, last_error from mail_sync_state where user_id = $1",
      [manager],
    );
    expect(state.rows[0]).toEqual({ history_id: "103", last_error: null });
  });

  it("running it again changes nothing", async () => {
    const before = (await t.pool.query("select 1 from inbound_emails")).rowCount;
    const s = await syncInbox({
      db: t.db,
      tokenFor: async () => "tok",
      fetchImpl: gmail,
      now: new Date(),
    });
    expect(s.merchantReplies).toEqual([]);
    expect(s.filed).toBe(0);
    expect((await t.pool.query("select 1 from inbound_emails")).rowCount).toBe(before);
    expect(
      (await t.pool.query("select 1 from documents where client_id = $1", [pizza])).rowCount,
    ).toBe(1);
  });

  it("a mailbox Google refuses is noted and does not stop the job", async () => {
    await t.pool.query("delete from mail_sync_state");
    const s = await syncInbox({
      db: t.db,
      tokenFor: async () => {
        throw new Error("Gmail needs to be reconnected");
      },
      fetchImpl: gmail,
    });
    expect(s.failed).toEqual([{ userId: manager, error: "Gmail needs to be reconnected" }]);
    expect(
      (
        await t.pool.query<{ last_error: string | null }>(
          "select last_error from mail_sync_state where user_id = $1",
          [manager],
        )
      ).rows[0]?.last_error,
    ).toBe("Gmail needs to be reconnected");
  });
});
