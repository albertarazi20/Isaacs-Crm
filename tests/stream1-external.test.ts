import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueEmail } from "@/lib/send/enqueue";
import { recordExternalSends, type SentMessage, type SentReader } from "@/lib/send/external";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/** Stream 1, S1-1: mail sent outside the CRM counts toward the cap. */

let t: TestDb;
let rep: string;
let other: string;
let clientId: string;

const now = new Date("2026-11-16T15:00:00Z");
const at = (minutesAgo: number) => now.getTime() - minutesAgo * 60_000;
const inbox = new Map<string, SentMessage[]>();
const calls: { list: number[]; get: string[] } = { list: [], get: [] };
const read: SentReader = {
  listSent: async (token, after) => {
    calls.list.push(after);
    return (inbox.get(token) ?? [])
      .filter((m) => m.internalDate >= after * 1000)
      .sort((a, b) => b.internalDate - a.internalDate)
      .map((m) => ({ id: m.id }));
  },
  getSent: async (token, id) => {
    calls.get.push(id);
    const m = (inbox.get(token) ?? []).find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  },
};
const tokenFor = async (userId: string) => `tok-${userId}`;
const ledger = () =>
  t.pool.query<{
    source: string;
    lane: string;
    provider_id: string | null;
    client_id: string | null;
  }>("select source, lane, provider_id, client_id from send_ledger order by sent_at, id");
const sent24h = async () =>
  (
    await t.pool.query<{ n: number }>(
      "select app.mailbox_sent_24h(m.id, $1::timestamptz) as n from mailboxes m where m.kind = 'gmail' and m.user_id = $2",
      [now.toISOString(), rep],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
  other = await insertUser(t.pool, "quiet@x.com");
  await t.pool.query(
    `insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status, can_read_mail) values
       ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok', true),
       ($2, 'quiet@selectivecap.com', 'enc', 'send', 'ok', false)`,
    [rep, other],
  );
  await t.pool.query("update shop_settings set postal_address = '1 Main St'");
  clientId = (
    await t.pool.query<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Cali Tacos', 'Owner', '3105550100', 'owner@calitacos.com', 'CA') returning id",
      [rep],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("S1-1: Sent mail outside the CRM", () => {
  it("records what the CRM did not send, once, and the mailbox's 24-hour count includes it", async () => {
    // one email the CRM sent itself through the outbox: Gmail's id for it is the outbox provider_id
    const r = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId, lane: "intake", source: "intake", subject: "Welcome", text: "Hi" },
        new Date(at(90)),
      ),
    );
    if (!r.queued) throw new Error("not queued");
    const deliver: Deliverer = {
      gmail: async () => "gmail-crm-1",
      resend: async () => "r",
    };
    const drained = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date(at(60)),
      appUrl: "https://crm.test",
    });
    expect(drained.sent).toBe(1);

    inbox.set(`tok-${rep}`, [
      { id: "gmail-crm-1", internalDate: at(60), headers: { to: "owner@calitacos.com" } },
      {
        id: "ext-1",
        internalDate: at(45),
        headers: { to: "Rosa <owner@calitacos.com>", subject: "Re: statements" },
      },
      { id: "ext-2", internalDate: at(30), headers: { to: "someone@elsewhere.com" } },
      { id: "ext-old", internalDate: at(26 * 60), headers: { to: "old@elsewhere.com" } },
    ]);
    const s = await recordExternalSends({ db: t.db, tokenFor, read, now });
    // the mailbox that may not be read is left alone
    expect(s).toMatchObject({ mailboxes: 1, seen: 3, recorded: 2, crm: 1, failed: [] });
    // first run looks back a day, so the 26-hour-old message is never asked for
    expect(calls.list[0]).toBe(Math.floor((now.getTime() - 24 * 3_600_000) / 1000));
    const rows = (await ledger()).rows;
    expect(rows).toEqual([
      { source: "crm", lane: "intake", provider_id: null, client_id: clientId },
      { source: "external", lane: "manual", provider_id: "ext-1", client_id: clientId },
      { source: "external", lane: "manual", provider_id: "ext-2", client_id: null },
    ]);
    expect(await sent24h()).toBe(3);
    const mark = (
      await t.pool.query<{ last_internal_date: string; messages_seen: number }>(
        "select last_internal_date::text, messages_seen from mailbox_sent_sync where user_id = $1",
        [rep],
      )
    ).rows[0];
    expect(mark).toEqual({ last_internal_date: String(at(30)), messages_seen: 3 });
    // external sends never count toward the per-merchant automation limit
    const merchant = await t.pool.query<{ n: number }>(
      "select app.merchant_sent($1, interval '24 hours', $2::timestamptz) as n",
      [clientId, now.toISOString()],
    );
    expect(merchant.rows[0]?.n).toBe(0);
  });

  it("the next run reads from the watermark and adds only what is new", async () => {
    calls.list.length = 0;
    inbox.get(`tok-${rep}`)!.push({
      id: "ext-3",
      internalDate: at(5),
      headers: { to: "new@elsewhere.com" },
    });
    const s = await recordExternalSends({ db: t.db, tokenFor, read, now });
    expect(s).toMatchObject({ seen: 2, recorded: 1, crm: 0 });
    expect(calls.list[0]).toBe(Math.floor(at(30) / 1000));
    expect((await ledger()).rows.map((r) => r.provider_id)).toEqual([
      null,
      "ext-1",
      "ext-2",
      "ext-3",
    ]);
    expect(await sent24h()).toBe(4);
    // nothing new: nothing written
    const again = await recordExternalSends({ db: t.db, tokenFor, read, now });
    expect(again).toMatchObject({ recorded: 0 });
    expect((await ledger()).rowCount).toBe(4);
  });

  it("a mailbox that fails is noted and the others still run", async () => {
    const failing: SentReader = {
      listSent: async () => {
        throw new Error("Gmail 401: token expired");
      },
      getSent: read.getSent,
    };
    const s = await recordExternalSends({ db: t.db, tokenFor, read: failing, now });
    expect(s.failed).toEqual([{ userId: rep, error: "Gmail 401: token expired" }]);
    const mark = (
      await t.pool.query<{ last_error: string | null }>(
        "select last_error from mailbox_sent_sync where user_id = $1",
        [rep],
      )
    ).rows[0];
    expect(mark?.last_error).toBe("Gmail 401: token expired");
  });
});
