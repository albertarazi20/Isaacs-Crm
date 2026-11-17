/**
 * Regressions from the second manual pass (docs/ISSUES.md, P2-*), each run the way the app runs it: as the role
 * through row security, not as the database owner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openUploadPage, rotateUploadToken } from "@/lib/docs/upload";
import { hashToken } from "@/lib/leads/token";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { checkLeadToken } from "@/lib/system/leads";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("pass 2 regressions", () => {
  let t: TestDb;
  let rep: string;
  let rep2: string;
  let manager: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    rep2 = await insertUser(t.pool, "rep2@x.com");
    manager = await insertUser(t.pool, "boss@x.com");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
  });
  afterAll(async () => {
    await t.drop();
  });

  it("P2-25: disabling an account revokes its lead-intake tokens, and a token on an inactive account is invalid", async () => {
    const token = "isl_" + "a".repeat(40);
    await t.pool.query(
      "insert into lead_tokens (user_id, label, token_hash) values ($1, 'zap', $2)",
      [rep, hashToken(token)],
    );
    expect((await checkLeadToken(token, t.db)).ok).toBe(true);
    await t.db.withUser(manager, (q) => q.query("select set_team_member($1, 'rep', false)", [rep]));
    const revoked = await t.pool.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from lead_tokens where token_hash = $1",
      [hashToken(token)],
    );
    expect(revoked.rows[0]?.revoked).toBe(true);
    expect((await checkLeadToken(token, t.db)).ok).toBe(false);
    // a fresh token on the still-disabled account is refused by the account check alone
    const token2 = "isl_" + "b".repeat(40);
    await t.pool.query(
      "insert into lead_tokens (user_id, label, token_hash) values ($1, 'zap2', $2)",
      [rep, hashToken(token2)],
    );
    expect((await checkLeadToken(token2, t.db)).ok).toBe(false);
    await t.db.withUser(manager, (q) => q.query("select set_team_member($1, 'rep', true)", [rep]));
  });

  it("P2-13: automated mail waits while the shop has no postal address; intake still goes", async () => {
    const sent: string[] = [];
    const deliver: Deliverer = {
      gmail: async (_u, m) => (sent.push(m.subject), `g_${sent.length}`),
      resend: async (m) => (sent.push(m.subject), `r_${sent.length}`),
    };
    await t.pool.query(
      "insert into gmail_connections (user_id, google_email, refresh_token_enc, scope, status) values ($1, 'rep@selectivecap.com', 'enc', 'send', 'ok')",
      [rep],
    );
    await t.pool.query("update shop_settings set postal_address = ''");
    const client = (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Cali Tacos', 'Owner', '3105550100', 'owner@calitacos.com', 'CA') returning id",
        [rep],
      )
    ).rows[0]!.id;
    const seq = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, {
        clientId: client,
        lane: "sequence",
        source: "bucket:x:step:1",
        subject: "Statements",
        text: "Hi",
        when: "now",
      }),
    );
    const intake = await t.db.withUser(rep, (q) =>
      enqueueEmail(q, {
        clientId: client,
        lane: "intake",
        source: "intake",
        subject: "Welcome",
        text: "Hi",
        when: "now",
      }),
    );
    if (!seq.queued || !intake.queued) throw new Error("not queued");
    const s = await drainOutbox({ db: t.db, deliver, appUrl: "https://crm.test" });
    expect(s.sent).toBe(1);
    expect(s.deferred).toBe(1);
    const row = (
      await t.pool.query<{ status: string; last_error: string | null }>(
        "select status, last_error from outbox where id = $1",
        [seq.outboxId],
      )
    ).rows[0];
    expect(row).toEqual({ status: "queued", last_error: "no_postal_address" });
    expect(sent).toEqual(["Welcome"]);
  });

  it("P2-29: resetting the merchant's permanent upload link kills the old link and the sessions it opened", async () => {
    const client = await insertClient(t.db, rep, "Oak Barbers");
    const tokenOf = async () =>
      (
        await t.pool.query<{ u: string }>("select upload_token as u from clients where id = $1", [
          client,
        ])
      ).rows[0]!.u;
    const before = await tokenOf();
    const opened = await openUploadPage(t.db, before, t.today);
    expect(opened).not.toBeNull();
    await t.db.withUser(rep, (q) => rotateUploadToken(q, client));
    const after = await tokenOf();
    expect(after).not.toBe(before);
    expect(await openUploadPage(t.db, before, t.today)).toBeNull();
    expect(await openUploadPage(t.db, opened!.token, t.today)).toBeNull();
    expect((await openUploadPage(t.db, after, t.today))?.token).toBeDefined();
    const note = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body like 'Upload link reset%'",
      [client],
    );
    expect(note.rows[0]?.n).toBe(1);
    // someone else's merchant is not theirs to reset
    await expect(t.db.withUser(rep2, (q) => rotateUploadToken(q, client))).rejects.toThrow(
      /isn't in your view/,
    );
  });
});
