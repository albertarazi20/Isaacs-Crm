import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRecommendationFacts } from "@/lib/assistant/recommendations";
import { monthOf } from "@/lib/dashboard/queries";
import { listCards, userContext } from "@/lib/data/queries";
import { buildToday } from "@/lib/data/views";
import { loadOverview } from "@/lib/followup/overview";
import { intakeLead, intakeSchema } from "@/lib/leads/form";
import { addDays } from "@/lib/mca/dates";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Findings of the engine review of 2026-11-17 that live outside the engine, proved against the DATABASE:
 * the Overview's overdue number is the call list's number, the recommendations count past the capped list, and the
 * intake treats the same email or a second phone in the rep's own book as the same merchant.
 */

let t: TestDb;
let rep: string;

const merchant = async (name: string, phone: string, extra: Record<string, unknown> = {}) => {
  const { rows } = await t.pool.query<{ id: string }>(
    `insert into clients (user_id, business_name, contact_name, phone, email, phone2, email2, state, contact_status)
     values ($1, $2, 'Owner', $3, $4, $5, $6, 'FL', $7) returning id`,
    [
      rep,
      name,
      phone,
      extra.email ?? "",
      extra.phone2 ?? "",
      extra.email2 ?? "",
      extra.contact_status ?? "ok",
    ],
  );
  return rows[0]!.id;
};
const timer = (clientId: string, dueOn: string) =>
  t.pool.query(
    "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', $3::date)",
    [rep, clientId, dueOn],
  );

beforeAll(async () => {
  t = await createTestDb();
  rep = await insertUser(t.pool, "rep@x.com");
});
afterAll(async () => {
  await t.drop();
});

describe("the Overview's overdue number", () => {
  it("counts merchants the way the call list does: one per merchant, never do-not-contact", async () => {
    const twoTimers = await merchant("Two Timers Co", "3055550201");
    await timer(twoTimers, addDays(t.today, -3));
    await timer(twoTimers, addDays(t.today, -1));
    const dnc = await merchant("Do Not Call LLC", "3055550202", { contact_status: "dnc" });
    await timer(dnc, addDays(t.today, -2));
    const plain = await merchant("Plain Overdue", "3055550203");
    await timer(plain, addDays(t.today, -5));

    const { overview, callList } = await t.db.withUser(rep, async (q) => {
      const ctx = await userContext(q);
      return {
        overview: await loadOverview(q, {
          today: ctx.today,
          month: monthOf(ctx.today),
          manager: false,
        }),
        callList: buildToday(await listCards(q), ctx.today, ctx.timezone),
      };
    });
    expect(callList.kpis.overdue).toBe(2);
    expect(overview.kpis.overdue).toBe(callList.kpis.overdue);
  });
});

describe("the recommendations", () => {
  it("count every uncalled new lead and bounced address, not the 25 the list shows", async () => {
    for (let i = 0; i < 30; i++)
      await merchant(`New Lead ${i}`, `30555503${String(i).padStart(2, "0")}`);
    await t.pool.query(
      "update clients set email_bounced_at = now() where business_name in ('New Lead 1', 'New Lead 2', 'New Lead 3')",
    );
    const facts = await t.db.withUser(rep, (q) =>
      loadRecommendationFacts(q, { today: t.today, manager: false, gmailConnected: true }),
    );
    const inDb = await t.pool.query<{ n: number }>(
      `select count(*)::int as n from clients c where c.user_id = $1 and c.brought_in_at is null
          and c.created_at > now() - interval '24 hours'
          and not exists (select 1 from activities a where a.client_id = c.id and a.kind = 'call')`,
      [rep],
    );
    expect(facts.queue.call_now).toBe(inDb.rows[0]!.n);
    expect(facts.queue.call_now).toBeGreaterThan(25);
    expect(facts.queue.bounced).toBe(3);
  });
});

describe("the intake form", () => {
  const add = (fields: Record<string, unknown>) =>
    t.db.withUser(rep, (q) => intakeLead(q, intakeSchema.parse(fields), "https://crm.test"));

  it("treats the same email, or a phone that is a merchant's second phone, as the merchant already here", async () => {
    const first = await add({
      businessName: "Email Twin Co",
      phone: "3055550801",
      email: "Owner@Twin.com",
    });
    expect(first.result).toBe("created");
    const sameEmail = await add({
      businessName: "Email Twin",
      phone: "3055550899",
      email: "owner@twin.com",
    });
    expect(sameEmail.result).toBe("duplicate");
    expect(sameEmail.clientId).toBe(first.clientId);

    const withSecond = await merchant("Second Phone Co", "3055550901", {
      phone2: "(305) 555-0902",
    });
    const bySecond = await add({ businessName: "Second Phone", phone: "305-555-0902" });
    expect(bySecond.result).toBe("duplicate");
    expect(bySecond.clientId).toBe(withSecond);

    const copies = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from clients where user_id = $1 and business_name ilike '%twin%'",
      [rep],
    );
    expect(copies.rows[0]!.n).toBe(1);
  });
});
