import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as m from "@/lib/data/mutations";
import type { UserContext } from "@/lib/data/types";
import { ingestLead } from "@/lib/leads/intake";
import { leadSchema } from "@/lib/leads/schema";
import { generateToken, hashToken, MAX_PER_MINUTE } from "@/lib/leads/token";
import { addMonths } from "@/lib/mca/dates";
import { checkLeadToken } from "@/lib/system/leads";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
let ctx: UserContext;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  b = await insertUser(t.pool, "other@x.com", "UTC");
  ctx = { today: t.today, timezone: "UTC" };
});
afterAll(async () => {
  await t.drop();
});

const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows;
const asA = <T>(fn: (q: Parameters<Parameters<typeof t.db.withUser>[1]>[0]) => Promise<T>) =>
  t.db.withUser(a, fn);
const makeToken = async (user: string, label = "Website form") => {
  const token = generateToken();
  await t.db.withUser(user, (q) =>
    q.query(
      "insert into lead_tokens (user_id, label, token_hash) values (app.current_user_id(), $1, $2)",
      [label, hashToken(token)],
    ),
  );
  return token;
};
const lead = (over: Record<string, unknown>) =>
  leadSchema.parse({ businessName: "New Lead Pizza", phone: "3055550199", ...over });
const openTimers = (id: string) =>
  rows(
    "select kind, due_on::text, note from timers where client_id = $1 and done_at is null order by created_at",
    [id],
  );

describe("lead tokens in the database", () => {
  it("only the hash is stored — the token itself is nowhere in the table", async () => {
    const token = await makeToken(a);
    const all = JSON.stringify(await rows("select * from lead_tokens"));
    expect(all).not.toContain(token);
    expect(all).toContain(hashToken(token));
  });
  it("the app role can list its tokens but can never read the hash", async () => {
    await expect(asA((q) => q.query("select token_hash from lead_tokens"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asA((q) => q.query("select * from lead_tokens"))).rejects.toThrow(
      /permission denied/,
    );
    const ok = await asA((q) =>
      q.query("select id, label, created_at, last_used_at, revoked_at from lead_tokens"),
    );
    expect(ok.rowCount).toBeGreaterThan(0);
  });
  it("the app role can't change the rate window or the hash, only revoke", async () => {
    await expect(asA((q) => q.query("update lead_tokens set window_count = 0"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asA((q) => q.query("update lead_tokens set token_hash = 'x'"))).rejects.toThrow(
      /permission denied/,
    );
    await asA((q) =>
      q.query("update lead_tokens set revoked_at = now() where label = 'to-revoke'"),
    );
  });
  it("user B can't see, revoke or add tokens for user A", async () => {
    await makeToken(a, "A only");
    const seen = await t.db.withUser(b, (q) => q.query("select label from lead_tokens"));
    expect(seen.rows).toEqual([]);
    const res = await t.db.withUser(b, (q) =>
      q.query("update lead_tokens set revoked_at = now() where label = 'A only'"),
    );
    expect(res.rowCount).toBe(0);
    expect(
      (await rows("select 1 from lead_tokens where label = 'A only' and revoked_at is null"))
        .length,
    ).toBe(1);
    await expect(
      t.db.withUser(b, (q) =>
        q.query("insert into lead_tokens (user_id, label, token_hash) values ($1, 'x', 'h')", [a]),
      ),
    ).rejects.toThrow();
  });
});

describe("checkLeadToken", () => {
  it("accepts a live token and says whose it is, and records the use", async () => {
    const token = await makeToken(a, "Live");
    const r = await checkLeadToken(token, t.db);
    expect(r).toEqual({ ok: true, userId: a, email: "isaac@x.com" });
    const [row] = await rows(
      "select last_used_at, window_count from lead_tokens where token_hash = $1",
      [hashToken(token)],
    );
    expect(row.last_used_at).not.toBeNull();
    expect(row.window_count).toBe(1);
  });
  it("refuses a token nobody made", async () => {
    expect(await checkLeadToken(generateToken(), t.db)).toEqual({ ok: false, reason: "invalid" });
  });
  it("refuses a revoked token at once", async () => {
    const token = await makeToken(a, "Revoked");
    await asA((q) => q.query("update lead_tokens set revoked_at = now() where label = 'Revoked'"));
    expect(await checkLeadToken(token, t.db)).toEqual({ ok: false, reason: "invalid" });
  });
  it("stops after the per-minute limit, counts the refused tries, and opens again after a minute", async () => {
    const token = await makeToken(a, "Busy");
    for (let i = 0; i < MAX_PER_MINUTE; i += 1)
      expect((await checkLeadToken(token, t.db)).ok).toBe(true);
    expect(await checkLeadToken(token, t.db)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await checkLeadToken(token, t.db)).toEqual({ ok: false, reason: "rate_limited" });
    await t.pool.query(
      "update lead_tokens set window_start = now() - interval '61 seconds' where token_hash = $1",
      [hashToken(token)],
    );
    expect((await checkLeadToken(token, t.db)).ok).toBe(true);
  });
  it("one token's busy minute doesn't slow another's", async () => {
    const other = await makeToken(a, "Quiet");
    expect((await checkLeadToken(other, t.db)).ok).toBe(true);
  });
  it("a token dies with its user", async () => {
    const token = await makeToken(b, "B token");
    await t.pool.query("delete from app_users where id = $1", [b]);
    expect(await checkLeadToken(token, t.db)).toEqual({ ok: false, reason: "invalid" });
    b = await insertUser(t.pool, "other2@x.com", "UTC");
  });
});

describe("ingestLead", () => {
  it("a new lead becomes a merchant due TODAY with a 'call now' timer, its ask, and its notes", async () => {
    const res = await asA((q) =>
      ingestLead(
        q,
        lead({
          contactName: "Sam Lee",
          wantedAmount: "40k",
          source: "Lead vendor X",
          state: "TX",
          notes: "Wants it for a new truck",
        }),
        ctx,
      ),
    );
    expect(res.status).toBe("created");
    const [c] = await rows(
      "select business_name, contact_name, phone, source, stage, state from clients where id = $1",
      [res.clientId],
    );
    expect(c).toMatchObject({
      business_name: "New Lead Pizza",
      contact_name: "Sam Lee",
      source: "Lead vendor X",
      stage: "name_in",
      state: "TX",
    });
    expect(await openTimers(res.clientId)).toEqual([
      { kind: "follow_up", due_on: t.today, note: "New lead — call now" },
    ]);
    const [ask] = await rows("select wanted_amount_cents from client_asks where client_id = $1", [
      res.clientId,
    ]);
    expect(ask.wanted_amount_cents).toBe(4_000_000);
    const notes = await rows("select body from activities where client_id = $1 and kind = 'note'", [
      res.clientId,
    ]);
    expect(notes.map((n) => n.body)).toEqual([
      "Lead came in via Lead vendor X: Wants it for a new truck",
    ]);
  });

  it("with no source it says 'Lead intake'", async () => {
    const res = await asA((q) =>
      ingestLead(q, lead({ businessName: "No Source Co", phone: "3055550201" }), ctx),
    );
    expect(
      (await rows("select source from clients where id = $1", [res.clientId]))[0]?.source,
    ).toBe("Lead intake");
  });

  it("the same phone again is NOT a second card: a note, and the follow-up moves to today", async () => {
    const first = await asA((q) =>
      ingestLead(q, lead({ businessName: "Echo Auto", phone: "3055550300" }), ctx),
    );
    await t.pool.query(
      "update timers set due_on = current_date + 20 where client_id = $1 and done_at is null",
      [first.clientId],
    );
    const again = await asA((q) =>
      ingestLead(
        q,
        lead({
          businessName: "Echo Auto Repair",
          phone: "(305) 555-0300",
          source: "Website",
          notes: "Filled the form again",
        }),
        ctx,
      ),
    );
    expect(again).toEqual({ status: "duplicate", clientId: first.clientId, matchedOn: "phone" });
    expect((await rows("select 1 from clients where phone like '%3055550300'")).length).toBe(1);
    expect((await openTimers(first.clientId)).map((x) => [x.kind, x.due_on, x.note])).toEqual([
      ["follow_up", t.today, "Came in again — call now"],
    ]);
    const notes = await rows("select body from activities where client_id = $1 and kind = 'note'", [
      first.clientId,
    ]);
    expect(notes.map((n) => n.body)).toEqual([
      "Came in again via Website: Filled the form again (business Echo Auto Repair, phone (305) 555-0300)",
    ]);
  });

  it("the same business name with no phone also counts as already here", async () => {
    const first = await asA((q) =>
      ingestLead(q, lead({ businessName: "Mikes Pizza", phone: "", email: "m@x.com" }), ctx),
    );
    const again = await asA((q) =>
      ingestLead(q, lead({ businessName: "Mike's Pizza", phone: "", email: "m2@x.com" }), ctx),
    );
    expect(again.status).toBe("duplicate");
    expect(again.clientId).toBe(first.clientId);
  });

  it("a do-not-contact merchant who comes back gets a note and NO new follow-up", async () => {
    const first = await asA((q) =>
      ingestLead(q, lead({ businessName: "Stop Diner", phone: "3055550400" }), ctx),
    );
    await asA((q) =>
      m.setContactStatus(q, { clientId: first.clientId, status: "dnc", note: "asked to stop" }),
    );
    const before = await openTimers(first.clientId);
    const again = await asA((q) =>
      ingestLead(q, lead({ businessName: "Stop Diner", phone: "3055550400" }), ctx),
    );
    expect(again).toEqual({
      status: "duplicate",
      clientId: first.clientId,
      matchedOn: "phone",
      doNotContact: true,
    });
    expect(await openTimers(first.clientId)).toEqual(before);
    expect(before.map((x) => x.due_on)).toEqual([addMonths(t.today, 36)]); // still the 36-month review
    expect(
      (
        await rows("select 1 from activities where client_id = $1 and body like 'Came in again%'", [
          first.clientId,
        ])
      ).length,
    ).toBe(1);
  });

  it("a merchant in the trash counts as gone: the lead is added fresh", async () => {
    const first = await asA((q) =>
      ingestLead(q, lead({ businessName: "Gone Grill", phone: "3055550500" }), ctx),
    );
    await asA((q) => m.trashClient(q, first.clientId));
    const again = await asA((q) =>
      ingestLead(q, lead({ businessName: "Gone Grill", phone: "3055550500" }), ctx),
    );
    expect(again.status).toBe("created");
    expect(again.clientId).not.toBe(first.clientId);
  });

  it("lands in the right account only", async () => {
    const res = await t.db.withUser(b, (q) =>
      ingestLead(q, lead({ businessName: "B Lead", phone: "3055550600" }), ctx),
    );
    expect(
      (await rows("select user_id from clients where id = $1", [res.clientId]))[0]?.user_id,
    ).toBe(b);
    const mine = await asA((q) => q.query("select 1 from clients where business_name = 'B Lead'"));
    expect(mine.rowCount).toBe(0);
  });

  it("a malformed lead creates nothing", async () => {
    const before = (await rows("select count(*)::int n from clients"))[0]?.n;
    expect(leadSchema.safeParse({ businessName: "No Contact Co" }).success).toBe(false);
    expect((await rows("select count(*)::int n from clients"))[0]?.n).toBe(before);
  });
});

describe("lead intake under real-world delivery (review 3A: A-1, A-2)", () => {
  const send = (user: string, over: Record<string, unknown>) =>
    t.db.withUser(user, (q) => ingestLead(q, lead(over), ctx));

  it("the same NEW lead arriving 12 times at once becomes ONE card, with no failures", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        send(a, { businessName: "Twin Pizza", phone: "3057770000" }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : "failed"));
    expect(statuses.filter((s) => s === "created")).toHaveLength(1);
    expect(statuses.filter((s) => s === "duplicate")).toHaveLength(11);
    expect(
      (await rows("select 1 from clients where user_id = $1 and phone like '%3057770000'", [a]))
        .length,
    ).toBe(1);
  });

  it("the same lead arriving 12 times at once for an EXISTING merchant: no deadlocks, one open follow-up", async () => {
    const first = await send(a, { businessName: "Known Auto", phone: "3057771111" });
    await t.pool.query(
      "update timers set due_on = current_date + 30 where client_id = $1 and done_at is null",
      [first.clientId],
    );
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        send(a, { businessName: "Known Auto", phone: "3057771111", notes: "again" }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect((await openTimers(first.clientId)).length).toBe(1);
    expect((await openTimers(first.clientId))[0]?.due_on).toBe(t.today);
  });

  it("two different businesses with the same name are two merchants when the phones differ", async () => {
    const one = await send(a, {
      businessName: "Subway",
      phone: "3057772222",
      email: "one@subway.example",
    });
    const two = await send(a, {
      businessName: "Subway",
      phone: "7867773333",
      email: "owner@othersubway.example",
      contactName: "Dana",
      wantedAmount: "80k",
    });
    expect(one.status).toBe("created");
    expect(two.status).toBe("created");
    expect(two.clientId).not.toBe(one.clientId);
    expect(
      (await rows("select 1 from clients where user_id = $1 and business_name = 'Subway'", [a]))
        .length,
    ).toBe(2);
  });

  it("a name match with no phone on the old card still counts, and the note keeps what the new lead knew", async () => {
    const old = await send(a, {
      businessName: "Phoneless Diner",
      phone: "",
      email: "old@diner.example",
    });
    const again = await send(a, {
      businessName: "Phoneless Diner",
      phone: "3057774444",
      contactName: "Sam",
      wantedAmount: "40k",
    });
    expect(again).toMatchObject({ status: "duplicate", clientId: old.clientId, matchedOn: "name" });
    const note = (
      await rows(
        "select body from activities where client_id = $1 and body like 'Came in again%'",
        [old.clientId],
      )
    )[0]?.body;
    expect(note).toContain("phone 3057774444");
    expect(note).toContain("contact Sam");
    expect(note).toContain("wants 40k");
  });

  it("a phone match says so", async () => {
    const first = await send(a, { businessName: "Phone Match Co", phone: "3057775555" });
    const again = await send(a, {
      businessName: "Totally Different Name",
      phone: "(305) 777-5555",
    });
    expect(again).toMatchObject({
      status: "duplicate",
      clientId: first.clientId,
      matchedOn: "phone",
    });
  });
});
