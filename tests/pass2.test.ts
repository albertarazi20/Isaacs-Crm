/**
 * Regressions from the second manual pass (docs/ISSUES.md, P2-*), each run the way the app runs it: as the role
 * through row security, not as the database owner.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "@/lib/leads/token";
import { enqueueEmail } from "@/lib/send/enqueue";
import { drainOutbox, type Deliverer } from "@/lib/send/worker";
import { checkLeadToken } from "@/lib/system/leads";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("pass 2 regressions", () => {
  let t: TestDb;
  let rep: string;
  let ops: string;
  let manager: string;
  let funder: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    ops = await insertUser(t.pool, "ops@x.com");
    manager = await insertUser(t.pool, "boss@x.com");
    await t.pool.query("update app_users set role = 'ops' where id = $1", [ops]);
    await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
    funder = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, submission_email) values ($1, 'Pearl Capital', 'subs@pearl.test') returning id",
        [manager],
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("P2-41 / P2-42: ops send a queued file to lenders, record the answer and the offer, as the ops role", async () => {
    const client = await insertClient(t.db, rep, "Marlin Charters");
    await t.db.withUser(rep, (q) =>
      q.query("select submit_to_ops($1, 'new', 4500000, 'engine')", [client]),
    );
    const subs = await t.db.withUser(ops, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "select id from create_submissions($1, $2::uuid[], null, 'as ops')",
        [client, [funder]],
      );
      return rows;
    });
    expect(subs).toHaveLength(1);
    const deal = (
      await t.pool.query<{ ops_status: string; status: string }>(
        "select ops_status, app.deal_status(d) as status from deals d where client_id = $1",
        [client],
      )
    ).rows[0];
    expect(deal).toEqual({ ops_status: "sent", status: "pending_lenders" });
    // a chase timer was written under the rep's user_id by the ops role
    const chase = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from timers where submission_id = $1 and kind = 'chase' and done_at is null",
      [subs[0]!.id],
    );
    expect(chase.rows[0]?.n).toBe(1);
    await t.db.withUser(ops, (q) =>
      q.query("select set_submission_status($1, 'stips_requested', null, 'voided check')", [
        subs[0]!.id,
      ]),
    );
    await t.db.withUser(ops, (q) =>
      q.query("select record_offer($1, $2::jsonb)", [
        subs[0]!.id,
        JSON.stringify({
          amount_cents: 4500000,
          factor_rate: 1.32,
          payment_cents: 42000,
          frequency: "daily",
        }),
      ]),
    );
    const offers = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from offers where client_id = $1",
      [client],
    );
    expect(offers.rows[0]?.n).toBe(1);
  });

  it("P2-27: a confirmed funding's money is frozen for the rep and open to a manager", async () => {
    const client = await insertClient(t.db, rep, "Blue Door Bistro");
    const funding = (
      await t.pool.query<{ id: string }>(
        `insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency,
                               commission_cents, confirmed_by, confirmed_at, ledger_state)
         values ($1, $2, current_date, 'Pearl Capital', 5000000, 1.3, 50000, 'daily', 500000, $3, now(), 'at_risk') returning id`,
        [rep, client, manager],
      )
    ).rows[0]!.id;
    await expect(
      t.db.withUser(rep, (q) =>
        q.query("update fundings set commission_cents = 900000 where id = $1", [funding]),
      ),
    ).rejects.toThrow(/confirmed/);
    await expect(
      t.db.withUser(rep, (q) =>
        q.query(
          "update fundings set commission_received_cents = 900000, commission_received_on = current_date where id = $1",
          [funding],
        ),
      ),
    ).rejects.toThrow(/confirmed/);
    // a note is not money
    await t.db.withUser(rep, (q) =>
      q.query("update fundings set note = 'typo fixed' where id = $1", [funding]),
    );
    await t.db.withUser(manager, (q) =>
      q.query("update fundings set commission_cents = 520000 where id = $1", [funding]),
    );
    const row = (
      await t.pool.query<{ commission_cents: number; note: string }>(
        "select commission_cents::int as commission_cents, note from fundings where id = $1",
        [funding],
      )
    ).rows[0];
    expect(row).toEqual({ commission_cents: 520000, note: "typo fixed" });
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
});
