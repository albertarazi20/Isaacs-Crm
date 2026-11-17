import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAppPage } from "@/lib/assistant/tools";
import { importClients } from "@/lib/data/import";
import { importRowSchema } from "@/lib/data/schemas";
import { userContext } from "@/lib/data/queries";
import { ingestLead } from "@/lib/leads/intake";
import { OwnedElsewhereError } from "@/lib/leads/owner";
import { assistantState } from "@/lib/leads/assistant";
import { leadSchema } from "@/lib/leads/schema";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The four defects the security review of 2026-11-17 found, each proved fixed against the DATABASE:
 * the AI cap stops a rep too, a rep reads their own merchants' replies (and only theirs), the lead webhook and the
 * CSV import never add another rep's merchant a second time, and the assistant's links are judged by where they land.
 */

let t: TestDb;
let rep: string;
let other: string;
let otherMerchant: string;
let repMerchant: string;

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T | undefined;

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
  other = await insertUser(t.pool, "other@x.com");
  await t.pool.query("update app_users set name = 'Ola Other' where id = $1", [other]);
  otherMerchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Owned By Ola LLC', 'Sam', '(212) 555-7319', 'sam@ola.com', 'NY') returning id",
    [other],
  ))!.id;
  repMerchant = (await one<{ id: string }>(
    "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Rep Tacos', 'Rosa', '(305) 555-0101', 'rosa@tacos.com', 'FL') returning id",
    [rep],
  ))!.id;
});
afterAll(async () => {
  await t.drop();
});

describe("the AI daily cap", () => {
  it("counts the whole shop's spend for a rep too, so a rep is stopped at the cap", async () => {
    await t.pool.query("update shop_settings set ai_enabled = true, ai_daily_cap_cents = 50");
    await t.pool.query(
      "insert into ai_runs (purpose, model, prompt_version, input_hash, cost_cents) values ('assistant', 'm', 'v', 'h', 100)",
    );
    const spent = await t.db.withUser(rep, (q) =>
      q.query<{ c: string }>("select app.ai_spent_today_cents()::text as c"),
    );
    expect(Number(spent.rows[0]!.c)).toBe(100);
    const state = await t.db.withUser(rep, (q) => assistantState(q, true));
    expect(state.ready).toBe(false);
    expect(state.reason).toMatch(/budget/);
    // the rep still cannot read the run log itself
    const runs = await t.db.withUser(rep, (q) => q.query("select * from ai_runs"));
    expect(runs.rows).toHaveLength(0);
  });
});

describe("a merchant's replies", () => {
  it("are readable by the rep whose merchant it is, and not by another rep", async () => {
    await t.pool.query(
      `insert into inbound_emails (mailbox_user_id, gmail_id, kind, client_id, from_address, subject, snippet, received_at)
       values ($3, 'm-rep', 'merchant', $1, 'rosa@tacos.com', 'Re: statements', 'Sending them tonight', now()),
              ($4, 'm-other', 'merchant', $2, 'sam@ola.com', 'Re: hello', 'Call me', now())`,
      [repMerchant, otherMerchant, rep, other],
    );
    const mine = await t.db.withUser(rep, (q) =>
      q.query<{ subject: string }>("select subject from inbound_emails order by subject"),
    );
    expect(mine.rows.map((r) => r.subject)).toEqual(["Re: statements"]);
  });
});

describe("another rep's merchant", () => {
  it("is refused by the lead webhook (and nothing is created)", async () => {
    const lead = leadSchema.parse({
      businessName: "Owned By Ola LLC",
      phone: "212-555-7319",
      email: "sam@ola.com",
    });
    await expect(
      t.db.withUser(rep, async (q) => ingestLead(q, lead, await userContext(q))),
    ).rejects.toBeInstanceOf(OwnedElsewhereError);
    const copies = await one<{ n: number }>(
      "select count(*)::int as n from clients where regexp_replace(phone, '\\D', '', 'g') = '2125557319'",
    );
    expect(copies!.n).toBe(1);
  });

  it("is listed as failed by the CSV import, and the other rows still import", async () => {
    const rows = [
      {
        line: 2,
        businessName: "Owned By Ola LLC",
        phone: "2125557319",
        stage: "name_in",
        followUpOn: t.today,
      },
      {
        line: 3,
        businessName: "Fresh Import Co",
        phone: "3055550199",
        stage: "name_in",
        followUpOn: t.today,
      },
    ].map((r) => importRowSchema.parse(r));
    const result = await t.db.withUser(rep, async (q) =>
      importClients(q, rows, await userContext(q)),
    );
    expect(result.created).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.line).toBe(2);
    const copies = await one<{ n: number }>(
      "select count(*)::int as n from clients where regexp_replace(phone, '\\D', '', 'g') = '2125557319'",
    );
    expect(copies!.n).toBe(1);
    const fresh = await one<{ user_id: string }>(
      "select user_id from clients where business_name = 'Fresh Import Co'",
    );
    expect(fresh!.user_id).toBe(rep);
  });
});

describe("the assistant's links", () => {
  it("are judged by where they really land", () => {
    for (const ok of ["/", "/today", "/follow-up?b=1", "/clients/abc", "/settings/email"])
      expect(isAppPage(ok), ok).toBe(true);
    for (const bad of [
      "/clients/../api/export/backup",
      "/settings/../api/auth/google?purpose=gmail",
      "/clients/%2e%2e/api/export",
      "/clients/..%2fapi",
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "/api/export/backup",
      "/today#x",
      "/nowhere",
    ])
      expect(isAppPage(bad), bad).toBe(false);
  });
});
