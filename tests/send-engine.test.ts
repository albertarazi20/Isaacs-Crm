import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelQueued, enqueueEmail } from "@/lib/send/enqueue";
import {
  capAllows,
  effectiveCap,
  gauge,
  inSendWindow,
  legalFooter,
  merchantCapAllows,
  nextSendTime,
} from "@/lib/send/rules";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

describe("send rules (pure)", () => {
  it("the cap never exceeds the provider's limit, with a margin on gmail.com", () => {
    expect(effectiveCap(1500, 2000)).toBe(1500);
    expect(effectiveCap(1500, 500)).toBe(400);
    expect(effectiveCap(300, 500)).toBe(300);
  });
  it("bulk lanes stop early so intake and replies keep the reserved slice", () => {
    const c = { shopCap: 1500, providerLimit: 2000, reserved: 150 };
    expect(capAllows("sequence", { ...c, sent24h: 1349 }).ok).toBe(true);
    expect(capAllows("sequence", { ...c, sent24h: 1350 }).ok).toBe(false);
    expect(capAllows("intake", { ...c, sent24h: 1350 }).ok).toBe(true);
    expect(capAllows("intake", { ...c, sent24h: 1500 }).ok).toBe(false);
  });
  it("the gauge", () => {
    expect(gauge(100, 1500, 1200)).toBe("green");
    expect(gauge(1200, 1500, 1200)).toBe("amber");
    expect(gauge(1500, 1500, 1200)).toBe("locked");
  });
  it("send window: weekdays 9-11 in the merchant's zone, spread across the window", () => {
    const w = { timezone: "America/Los_Angeles", startHour: 9, endHour: 11, weekends: false };
    // 2026-11-16 is a Monday. 17:00Z = 09:00 PST.
    expect(inSendWindow(new Date("2026-11-16T17:00:00Z"), w)).toBe(true);
    expect(inSendWindow(new Date("2026-11-16T16:59:00Z"), w)).toBe(false);
    expect(inSendWindow(new Date("2026-11-16T19:00:00Z"), w)).toBe(false);
    expect(inSendWindow(new Date("2026-11-15T17:30:00Z"), w)).toBe(false); // Sunday
    // from 3am PST Monday, with spread 0.5 → 10:00 PST
    const t = nextSendTime(new Date("2026-11-16T11:00:00Z"), w, 0.5);
    expect(t.toISOString()).toBe("2026-11-16T18:00:00.000Z");
    // already inside the window → now
    expect(nextSendTime(new Date("2026-11-16T17:40:00Z"), w, 0.9).toISOString()).toBe(
      "2026-11-16T17:40:00.000Z",
    );
  });
  it("per-merchant frequency", () => {
    expect(merchantCapAllows({ sent24h: 0, sent7d: 2, perDay: 1, perWeek: 3 })).toBe(true);
    expect(merchantCapAllows({ sent24h: 1, sent7d: 1, perDay: 1, perWeek: 3 })).toBe(false);
    expect(merchantCapAllows({ sent24h: 0, sent7d: 3, perDay: 1, perWeek: 3 })).toBe(false);
  });
  it("the footer carries the shop name, the postal address and the unsubscribe link", () => {
    const f = legalFooter({
      shopName: "Selective Capital",
      postalAddress: "1 Main St, Miami FL",
      unsubscribeUrl: "https://x/u/abc",
    });
    expect(f.text).toContain("1 Main St");
    expect(f.html).toContain('href="https://x/u/abc"');
  });
});

describe("the outbox, from a real database", () => {
  let t: TestDb;
  let rep: string;
  let clientId: string;
  const sent: { via: string; to: string; subject: string; text: string }[] = [];
  const deliver: Deliverer = {
    gmail: async (_u, m) => (sent.push({ via: "gmail", ...m }), `g_${sent.length}`),
    resend: async (m) => (
      sent.push({ via: "resend", to: m.to, subject: m.subject, text: m.text }),
      `r_${sent.length}`
    ),
  };
  const client = async (name: string, email: string, state = "CA") =>
    (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Owner', '3105550100', $3, $4) returning id",
        [rep, name, email, state],
      )
    ).rows[0]?.id as string;
  const outbox = async (id: string) =>
    (
      await t.pool.query<{
        status: string;
        skip_reason: string | null;
        lane: string;
        last_error: string | null;
      }>("select status, skip_reason, lane, last_error from outbox where id = $1", [id])
    ).rows[0];

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
      [rep],
    );
    await t.pool.query(
      "update shop_settings set postal_address = '1 Main St, Miami FL 33101', daily_cap = 60, reserved_for_intake = 10, amber_at = 40",
    );
    clientId = await client("Cali Tacos", "owner@calitacos.com");
  });
  afterAll(async () => {
    await t.drop();
  });

  it("enqueue: a sequence email waits for the merchant's local window; intake goes now", async () => {
    const r = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        {
          clientId,
          lane: "sequence",
          source: "bucket:x:step:1",
          subject: "Statements",
          text: "Hi",
        },
        new Date("2026-11-16T11:00:00Z"),
      ),
    );
    expect(r.queued).toBe(true);
    if (!r.queued) return;
    // 03:00 PST Monday → inside Monday's 9–11 PST window
    const nb = new Date(r.notBefore);
    expect(nb.getTime()).toBeGreaterThanOrEqual(new Date("2026-11-16T17:00:00Z").getTime());
    expect(nb.getTime()).toBeLessThan(new Date("2026-11-16T19:00:00Z").getTime());
    const i = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId, lane: "intake", source: "intake", subject: "Welcome", text: "Hi" },
        new Date("2026-11-16T11:00:00Z"),
      ),
    );
    expect(i.queued && i.notBefore).toBe("2026-11-16T11:00:00.000Z");
  });
  it("enqueue refuses: no address, do-not-contact, opted out, suppressed", async () => {
    const noMail = await client("No Mail", "");
    expect(
      (
        await t.db.withUser(rep, (q) =>
          enqueueEmail(q, {
            clientId: noMail,
            lane: "intake",
            source: "intake",
            subject: "s",
            text: "t",
          }),
        )
      ).queued,
    ).toBe(false);
    const dnc = await client("DNC Co", "dnc@x.com");
    await t.pool.query("update clients set contact_status = 'dnc' where id = $1", [dnc]);
    const r1 = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, { clientId: dnc, lane: "intake", source: "intake", subject: "s", text: "t" }),
    );
    expect(r1).toEqual({ queued: false, reason: "dnc" });
    const sup = await client("Bounced Co", "dead@x.com");
    await t.db.withUser(rep, (q) => q.query("select opt_out($1, 'email', 'hard_bounce')", [sup]));
    const r2 = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, { clientId: sup, lane: "intake", source: "intake", subject: "s", text: "t" }),
    );
    expect(r2.queued).toBe(false);
    // the suppression outlives the merchant row
    await t.pool.query("delete from clients where id = $1", [sup]);
    const again = await client("Bounced Again", "DEAD@x.com");
    const r3 = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, {
        clientId: again,
        lane: "intake",
        source: "intake",
        subject: "s",
        text: "t",
      }),
    );
    expect(r3).toEqual({ queued: false, reason: "suppressed" });
  });
  it("the worker sends due rows through Gmail, writes the ledger and the timeline, appends the footer to bulk mail", async () => {
    // The sequence row was spread at random across the 17:00–19:00Z window (nextSendTime); draining at the window's
    // last millisecond is due for any spread and still inside the window (bulk mail goes only inside it). Draining
    // mid-window made this a coin flip.
    const now = new Date("2026-11-16T18:59:59.999Z");
    const s = await drainOutbox({ db: t.db, deliver, now, appUrl: "https://crm.test" });
    expect(s.sent).toBe(2);
    expect(sent.map((x) => x.subject).sort()).toEqual(["Statements", "Welcome"]);
    const seq = sent.find((x) => x.subject === "Statements");
    expect(seq?.text).toContain("1 Main St, Miami FL 33101");
    expect(seq?.text).toMatch(/https:\/\/crm\.test\/u\/[A-Za-z0-9]+/);
    expect(sent.find((x) => x.subject === "Welcome")?.text).not.toContain("1 Main St");
    const ledger = await t.pool.query<{ n: number }>("select count(*)::int as n from send_ledger");
    expect(ledger.rows[0]?.n).toBe(2);
    const acts = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and kind = 'email'",
      [clientId],
    );
    expect(acts.rows[0]?.n).toBe(2);
  });
  it("one automated email per merchant per day: a second sequence step is deferred, not sent", async () => {
    // The drain clock is pinned, so the row is queued on the same clock. Queued on the wall clock it stopped being
    // due once the day passed 19:30Z and the drain claimed nothing (this file first failed at that hour).
    const r = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        {
          clientId,
          lane: "sequence",
          source: "bucket:x:step:2",
          subject: "Still need",
          text: "Hi",
          when: "now",
        },
        new Date("2026-11-16T18:50:00Z"),
      ),
    );
    if (!r.queued) throw new Error("not queued");
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-11-16T18:59:59.999Z"),
      appUrl: "https://crm.test",
    });
    expect(s.deferred).toBe(1);
    expect(await outbox(r.outboxId)).toMatchObject({
      status: "queued",
      last_error: "per_merchant_cap",
    });
  });
  it("the cap: bulk stops at cap minus the reserved slice; intake keeps going until the cap", async () => {
    // 60 cap, 10 reserved → bulk stops at 50 sent in 24h. Pre-fill the ledger to 50.
    const mb = await t.pool.query<{ id: string }>(
      "select id from mailboxes where kind = 'gmail' limit 1",
    );
    for (let i = 0; i < 48; i += 1)
      await t.pool.query(
        "insert into send_ledger (mailbox_id, lane, sent_at) values ($1, 'sequence', '2026-11-16T18:45:00Z')",
        [mb.rows[0]?.id],
      );
    const other = await client("Other Co", "other@x.com");
    // every clock in this test is the pinned one (see the per-merchant test above)
    const queuedAt = new Date("2026-11-16T18:50:00Z");
    const bulk = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId: other, lane: "blast", source: "blast:1", subject: "B", text: "t", when: "now" },
        queuedAt,
      ),
    );
    const intake = await t.db.withUser(rep, (q) =>
      enqueueEmail(
        q,
        { clientId: other, lane: "intake", source: "intake", subject: "I", text: "t" },
        queuedAt,
      ),
    );
    if (!bulk.queued || !intake.queued) throw new Error("not queued");
    const s = await drainOutbox({
      db: t.db,
      deliver,
      now: new Date("2026-11-16T18:59:59.999Z"),
      appUrl: "https://crm.test",
    });
    expect(s.sent).toBe(1);
    expect(s.deferred).toBe(1);
    expect((await outbox(intake.outboxId))?.status).toBe("sent");
    expect(await outbox(bulk.outboxId)).toMatchObject({
      status: "queued",
      skip_reason: null,
      last_error: "cap",
    });
  });
  it("cancelQueued drops every queued automated email to a merchant (a reply came in)", async () => {
    const n = await t.db.withUser(rep, (q) => cancelQueued(q, clientId, "replied"));
    expect(n).toBe(1);
    const left = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from outbox where client_id = $1 and status = 'queued'",
      [clientId],
    );
    expect(left.rows[0]?.n).toBe(0);
  });
});
