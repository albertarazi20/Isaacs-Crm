import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userContext } from "@/lib/data/queries";
import { moveClient } from "@/lib/data/mutations";
import { moveSchema } from "@/lib/data/schemas";
import { addDays } from "@/lib/mca/dates";
import {
  dateAtPaydown,
  paybackCents,
  payoffDate,
  renewalDate,
  type Frequency,
  type FundingTerms,
} from "@/lib/mca/funding";
import { loadEarningsData, listAdvances } from "@/lib/earnings/queries";
import { buildEarnings, commissionContext } from "@/lib/earnings/view";
import { pipelineDeals } from "@/lib/earnings/expected";
import { recordCommissionReceived, updateFundingTerms } from "@/lib/earnings/mutations";
import { termsUpdateSchema } from "@/lib/earnings/schemas";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
/** Both users keep UTC so the database's idea of "today" is the one the tests use. */
let today: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
  b = await insertUser(t.pool, "other@x.com", "UTC");
  today = (await t.pool.query<{ d: string }>("select (now() at time zone 'UTC')::date::text as d"))
    .rows[0]?.d as string;
});
afterAll(async () => {
  await t.drop();
});

interface Fund {
  fundedOn: string;
  amount: string;
  factorRate: string;
  payment: string;
  frequency: Frequency;
  funderName: string;
  commission?: string;
}
const BASE: Fund = {
  fundedOn: "",
  amount: "50000",
  factorRate: "1.32",
  payment: "550",
  frequency: "daily",
  funderName: "Alpha Capital",
};

/** Funds a client through the real Funded flow (record_funding + its timers). Returns the advance id. */
async function fund(userId: string, clientId: string, over: Partial<Fund> = {}): Promise<string> {
  const funding = { ...BASE, fundedOn: addDays(today, -10), ...over };
  await t.db.withUser(userId, async (q) =>
    moveClient(q, moveSchema.parse({ clientId, stage: "funded", funding }), await userContext(q)),
  );
  const { rows } = await t.pool.query<{ id: string }>(
    "select id from fundings where client_id = $1 order by created_at desc limit 1",
    [clientId],
  );
  return rows[0]?.id as string;
}

const edit = (userId: string, fundingId: string, terms: Record<string, unknown>) =>
  t.db.withUser(userId, (q) =>
    q.query("select * from update_funding_terms($1, $2::jsonb)", [
      fundingId,
      JSON.stringify(terms),
    ]),
  );

const timers = async (clientId: string) =>
  (
    await t.pool.query<{ id: string; kind: string; due_on: string; note: string }>(
      "select id, kind, due_on, note from timers where client_id = $1 and done_at is null order by kind, due_on",
      [clientId],
    )
  ).rows;
const row = async (fundingId: string) =>
  (await t.pool.query("select * from fundings where id = $1", [fundingId])).rows[0];
const bodies = async (clientId: string) =>
  (
    await t.pool.query<{ kind: string; body: string }>(
      "select kind, body from activities where client_id = $1 order by occurred_at, id",
      [clientId],
    )
  ).rows;

const terms = (over: Partial<FundingTerms> = {}): FundingTerms => ({
  fundedOn: addDays(today, -10),
  amountCents: 5_000_000,
  factorRate: 1.32,
  paymentCents: 55_000,
  frequency: "daily",
  ...over,
});

describe("update_funding_terms: the row", () => {
  it("changes every term in the database and recomputes the generated payback", async () => {
    const client = await insertClient(t.db, a, "Typo Co");
    const id = await fund(a, client);
    expect((await row(id)).payback_cents).toBe(6_600_000);

    await edit(a, id, {
      funded_on: addDays(today, -12),
      funder_name: "Beta Funding",
      amount_cents: 5_200_000,
      factor_rate: 1.35,
      payment_cents: 60_000,
      frequency: "weekly",
      position_no: 2,
      term_days: 180,
      commission_cents: 260_000,
      paid_back_override_cents: 100_000,
      last_payment_on: addDays(today, -3),
      promise_amount_cents: 50_000,
      note: "fixed the typo",
    });

    const r = await row(id);
    expect(r).toMatchObject({
      funded_on: addDays(today, -12),
      funder_name: "Beta Funding",
      amount_cents: 5_200_000,
      factor_rate: 1.35,
      payment_cents: 60_000,
      frequency: "weekly",
      position_no: 2,
      term_days: 180,
      commission_cents: 260_000,
      paid_back_override_cents: 100_000,
      last_payment_on: addDays(today, -3),
      promise_amount_cents: 50_000,
      note: "fixed the typo",
    });
    expect(r.payback_cents).toBe(7_020_000);
    expect(r.status).toBe("active");
  });

  it("leaves a field alone when its key is absent and clears it when the key is null", async () => {
    const client = await insertClient(t.db, a, "Partial Co");
    const id = await fund(a, client, { commission: "2500" });
    await edit(a, id, { note: "only the note" });
    expect(await row(id)).toMatchObject({ commission_cents: 250_000, note: "only the note" });
    await edit(a, id, { commission_cents: null });
    expect((await row(id)).commission_cents).toBeNull();
    expect((await row(id)).amount_cents).toBe(5_000_000);
  });

  it("writes a timeline entry in plain words", async () => {
    const client = await insertClient(t.db, a, "Words Co");
    const id = await fund(a, client);
    await edit(a, id, { amount_cents: 5_200_000 });
    const last = (await bodies(client)).at(-1);
    expect(last?.kind).toBe("funding");
    expect(last?.body).toMatch(/^Advance terms corrected: amount \$50,000 → \$52,000/);
    await edit(a, id, {
      factor_rate: 1.4,
      payment_cents: 80_000,
      frequency: "weekly",
      position_no: 3,
    });
    const second = (await bodies(client)).at(-1)?.body ?? "";
    expect(second).toContain("factor rate 1.32 → 1.40");
    expect(second).toContain("remittance $550/day → $800/week");
    expect(second).toContain("position 1st → 3rd");
    // nothing changed → nothing logged
    const n = (await bodies(client)).length;
    await edit(a, id, { amount_cents: 5_200_000 });
    expect(await bodies(client)).toHaveLength(n);
  });

  it("refuses bad terms in words he can act on, and leaves the row and timers untouched", async () => {
    const client = await insertClient(t.db, a, "Reject Co");
    const id = await fund(a, client);
    const before = await row(id);
    const timersBefore = await timers(client);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ factor_rate: 0.9 }, /Factor rate must be between 1.00 and 3.00/],
      [{ factor_rate: 3.5 }, /Factor rate must be between 1.00 and 3.00/],
      [{ amount_cents: 0 }, /advance amount must be more than \$0/],
      [{ payment_cents: 0 }, /Enter the remittance amount/],
      [{ payment_cents: 9_000_000 }, /One remittance can't be more than the whole payback/],
      [{ payment_cents: 1 }, /more than 5 years/],
      [{ frequency: "hourly" }, /Pick how often/],
      [{ position_no: 0 }, /Position must be/],
      [{ term_days: 0 }, /Term must be/],
      [{ funded_on: addDays(today, 5) }, /in the future/],
      [{ funded_on: null }, /Pick the funded date/],
      [{ commission_cents: 6_000_000 }, /Commission can't be more than the advance/],
      [{ last_payment_on: addDays(today, -400) }, /before the funded date/],
      [{ commission_received_cents: 1000 }, /both the commission received and the day/],
      [{ commission_received_on: today }, /both the commission received and the day/],
    ];
    for (const [terms, message] of cases) {
      await expect(edit(a, id, terms), JSON.stringify(terms)).rejects.toThrow(message);
    }
    expect(await row(id)).toEqual(before);
    expect(await timers(client)).toEqual(timersBefore);
    expect((await bodies(client)).filter((x) => /corrected/.test(x.body))).toHaveLength(0);
  });

  it("is atomic: a bad value after good ones saves nothing", async () => {
    const client = await insertClient(t.db, a, "Atomic Co");
    const id = await fund(a, client);
    await expect(edit(a, id, { amount_cents: 6_000_000, factor_rate: 9 })).rejects.toThrow(
      /Factor rate/,
    );
    expect((await row(id)).amount_cents).toBe(5_000_000);
  });
});

describe("update_funding_terms: the renewal call", () => {
  it("re-derives the renewal call from the new terms and nothing else", async () => {
    const client = await insertClient(t.db, a, "Renew Co");
    const id = await fund(a, client, { fundedOn: addDays(today, -2) });
    const before = await timers(client);
    const checkIn = before.find((x) => x.kind === "check_in");
    const renewal = before.find((x) => x.kind === "renewal");
    expect(renewal?.due_on).toBe(renewalDate(terms({ fundedOn: addDays(today, -2) }), today));

    // a typo in the remittance: $55/day not $550/day pushes the 50% date far out
    await edit(a, id, { payment_cents: 5_500 });
    const after = await timers(client);
    const next = renewalDate(terms({ fundedOn: addDays(today, -2), paymentCents: 5_500 }), today);
    expect(after.find((x) => x.kind === "renewal")?.due_on).toBe(next);
    expect(after.find((x) => x.kind === "renewal")?.id).toBe(renewal?.id);
    expect(after.find((x) => x.kind === "check_in")).toEqual(checkIn);
    expect(after).toHaveLength(before.length);
    const last = (await bodies(client)).at(-1)?.body ?? "";
    expect(last).toMatch(/remittance \$550\/day → \$55\/day; renewal call moved to /);
  });

  it("does not move the other open timers, even a booked call", async () => {
    const client = await insertClient(t.db, a, "Booked Co");
    const id = await fund(a, client, { fundedOn: addDays(today, -2) });
    await t.db.withUser(a, (q) =>
      q.query("select * from schedule_call($1, $2)", [client, `${addDays(today, 3)}T15:00:00Z`]),
    );
    const before = await timers(client);
    await edit(a, id, { amount_cents: 9_000_000 });
    const after = await timers(client);
    expect(after.filter((x) => x.kind !== "renewal")).toEqual(
      before.filter((x) => x.kind !== "renewal"),
    );
    expect(after.map((x) => x.kind).sort()).toEqual(before.map((x) => x.kind).sort());
  });

  it("only touches the latest active advance: an older one changes its row and no timer", async () => {
    const client = await insertClient(t.db, a, "Two Advances Co");
    const first = await fund(a, client, { fundedOn: addDays(today, -200), payment: "600" });
    const second = await fund(a, client, { fundedOn: addDays(today, -1) });
    expect((await row(first)).status).toBe("renewed");
    expect((await row(second)).status).toBe("active");

    const before = await timers(client);
    await edit(a, first, { amount_cents: 4_000_000, payment_cents: 20_000 });
    expect(await timers(client)).toEqual(before);
    expect((await row(first)).amount_cents).toBe(4_000_000);
    const note = (await bodies(client)).at(-1)?.body ?? "";
    expect(note).toMatch(/^Past advance \(funded .*\) terms corrected: amount \$50,000 → \$40,000/);
    expect(note).not.toContain("renewal call moved");

    // ...and the latest one still moves its renewal call
    await edit(a, second, { payment_cents: 20_000 });
    const renewal = (await timers(client)).find((x) => x.kind === "renewal");
    expect(renewal?.due_on).toBe(
      renewalDate(terms({ fundedOn: addDays(today, -1), paymentCents: 20_000 }), today),
    );
  });

  it("does not touch timers when the latest advance is no longer active", async () => {
    const client = await insertClient(t.db, a, "Paid Co");
    const id = await fund(a, client);
    await t.pool.query("update fundings set status = 'paid_off' where id = $1", [id]);
    const before = await timers(client);
    await edit(a, id, { payment_cents: 8_000 });
    expect(await timers(client)).toEqual(before);
  });

  it("creates no renewal call for a client who has none (already made, or moved to Pays off soon)", async () => {
    const client = await insertClient(t.db, a, "No Renewal Co");
    const id = await fund(a, client);
    await t.pool.query(
      "update timers set done_at = now(), done_reason = 'completed' where client_id = $1 and kind = 'renewal'",
      [client],
    );
    await edit(a, id, { payment_cents: 8_000 });
    expect((await timers(client)).filter((x) => x.kind === "renewal")).toHaveLength(0);
  });

  it("does not undo a snooze, and does not forgive an overdue call", async () => {
    const client = await insertClient(t.db, a, "Snooze Co");
    const id = await fund(a, client, { fundedOn: addDays(today, -30) });
    const snoozeTo = addDays(today, 200);
    await t.pool.query("update timers set due_on = $2 where client_id = $1 and kind = 'renewal'", [
      client,
      snoozeTo,
    ]);
    // a correction that would bring the 50% date forward still respects the snooze
    await edit(a, id, { payment_cents: 90_000 });
    expect((await timers(client)).find((x) => x.kind === "renewal")?.due_on).toBe(snoozeTo);

    // an overdue renewal call stays overdue when the merchant is past 50% under the new terms
    const overdue = addDays(today, -6);
    await t.pool.query("update timers set due_on = $2 where client_id = $1 and kind = 'renewal'", [
      client,
      overdue,
    ]);
    await edit(a, id, { payment_cents: 3_000_000 });
    expect((await timers(client)).find((x) => x.kind === "renewal")?.due_on).toBe(overdue);
  });

  it("leaves the renewal call alone when the 50% date does not change", async () => {
    const client = await insertClient(t.db, a, "Same Date Co");
    const id = await fund(a, client, { fundedOn: addDays(today, -2) });
    const before = await timers(client);
    await edit(a, id, { funder_name: "Gamma", commission_cents: 100_000, note: "x" });
    expect(await timers(client)).toEqual(before);
  });
});

describe("update_funding_terms: other users", () => {
  it("user B cannot edit user A's advance — not found, and nothing changes", async () => {
    const client = await insertClient(t.db, a, "A's Co");
    const id = await fund(a, client);
    const before = await row(id);
    const timersBefore = await timers(client);
    await expect(edit(b, id, { amount_cents: 1_000_000 })).rejects.toThrow(/no longer exists/);
    await expect(
      t.db.withUser(b, (q) =>
        recordCommissionReceived(q, {
          fundingId: id,
          amount: 100_000,
          receivedOn: today,
        }),
      ),
    ).rejects.toThrow(/no longer exists/);
    expect(await row(id)).toEqual(before);
    expect(await timers(client)).toEqual(timersBefore);
  });

  it("an edit never reaches another user's advance or timers", async () => {
    const clientA = await insertClient(t.db, a, "Mine Co");
    const clientB = await insertClient(t.db, b, "Theirs Co");
    const idA = await fund(a, clientA, { fundedOn: addDays(today, -2) });
    const idB = await fund(b, clientB, { fundedOn: addDays(today, -2) });
    const beforeB = await row(idB);
    const timersB = await timers(clientB);
    await edit(a, idA, { payment_cents: 20_000, amount_cents: 7_000_000 });
    expect(await row(idB)).toEqual(beforeB);
    expect(await timers(clientB)).toEqual(timersB);
    expect(await t.db.withUser(b, (q) => listAdvances(q))).toHaveLength(1);
  });
});

describe("commission received", () => {
  it("is stored with its day, shows on the timeline, and can be corrected and cleared", async () => {
    const client = await insertClient(t.db, a, "Paid Me Co");
    const id = await fund(a, client, { commission: "2500" });
    await t.db.withUser(a, (q) =>
      recordCommissionReceived(q, { fundingId: id, amount: 250_000, receivedOn: today }),
    );
    expect(await row(id)).toMatchObject({
      commission_received_cents: 250_000,
      commission_received_on: today,
    });
    expect((await bodies(client)).at(-1)?.body).toMatch(/^Commission received: \$2,500 on /);
    // a correction
    await edit(a, id, { commission_received_cents: 280_000, commission_received_on: today });
    expect((await bodies(client)).at(-1)?.body).toMatch(
      /^Commission received corrected: \$2,500 → \$2,800 on /,
    );
    // clearing needs both to go
    await edit(a, id, { commission_received_cents: null, commission_received_on: null });
    expect((await row(id)).commission_received_cents).toBeNull();
    expect((await bodies(client)).at(-1)?.body).toBe("Commission received cleared");
  });

  it("the table refuses an amount without a day even if the function were bypassed", async () => {
    const client = await insertClient(t.db, a, "Constraint Co");
    const id = await fund(a, client);
    await expect(
      t.pool.query("update fundings set commission_received_cents = 100 where id = $1", [id]),
    ).rejects.toThrow(/fundings_commission_received_pair/);
  });

  it("the full-form mutation sends exactly the terms the form shows (zod → JSON → row)", async () => {
    const client = await insertClient(t.db, a, "Form Co");
    const id = await fund(a, client);
    const input = termsUpdateSchema.parse({
      fundingId: id,
      fundedOn: addDays(today, -10),
      funderName: " Alpha Capital ",
      amount: "$52,000",
      factorRate: "1.35",
      payment: "600",
      frequency: "daily",
      positionNo: "2",
      termDays: "",
      commission: "2600",
      commissionReceived: "2600",
      commissionReceivedOn: today,
      paidBackOverride: "",
      lastPaymentOn: null,
      promiseToPayAt: `${today}T14:30`,
      promiseAmount: "1,500",
      note: "typo fixed",
    });
    await t.db.withUser(a, async (q) => updateFundingTerms(q, input, await userContext(q)));
    const r = await row(id);
    expect(r).toMatchObject({
      funder_name: "Alpha Capital",
      amount_cents: 5_200_000,
      factor_rate: 1.35,
      payment_cents: 60_000,
      position_no: 2,
      term_days: null,
      commission_cents: 260_000,
      commission_received_cents: 260_000,
      promise_amount_cents: 150_000,
      note: "typo fixed",
    });
    expect(new Date(r.promise_to_pay_at).toISOString()).toBe(`${today}T14:30:00.000Z`);
  });
});

// ---------------------------------------------------------------------------------------------
// the database and TypeScript must agree on when a merchant crosses 50%

/** Small seeded generator so a failure can be reproduced. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FREQS: Frequency[] = ["daily", "weekly", "biweekly", "monthly"];

function randomTerms(rand: () => number, anchor: string): FundingTerms {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  for (;;) {
    const amountCents =
      (5 + Math.floor(rand() * 495)) * 1000 * 100 + pick([0, 0, 0, 5_000, 12_300]);
    const hundredths = 110 + Math.floor(rand() * 50); // 1.10 .. 1.59
    const f = rand() < 0.25 ? (hundredths * 10 + Math.floor(rand() * 10)) / 1000 : hundredths / 100;
    // an exact half-cent payback ties on round(): PostgreSQL rounds half up, JavaScript's float product may not
    if ((amountCents * Math.round(f * 1000)) % 1000 === 500) continue;
    const frequency = pick(FREQS);
    const ranges: Record<Frequency, [number, number]> = {
      daily: [40, 300],
      weekly: [10, 120],
      biweekly: [6, 60],
      monthly: [3, 36],
    };
    const [lo, hi] = ranges[frequency];
    const per = lo + Math.floor(rand() * (hi - lo));
    const payback = paybackCents(amountCents, f);
    const paymentCents = Math.max(100, Math.round(payback / per / 100) * 100);
    // funded dates all over the calendar: weekends, month ends, leap days
    const fundedOn = addDays(anchor, Math.floor(rand() * 1200) - 600);
    return { fundedOn, amountCents, factorRate: f, paymentCents, frequency };
  }
}

describe("database dates agree with src/lib/mca/funding.ts", () => {
  it("app.date_at_paydown equals dateAtPaydown for 600 random terms at 25%, 50%, 75% and 100%", async () => {
    const rand = mulberry32(20261023);
    for (let i = 0; i < 600; i += 1) {
      const x = randomTerms(rand, today);
      const pct = [25, 50, 75, 100][i % 4] as number;
      const { rows } = await t.pool.query<{ d: string | null }>(
        "select app.date_at_paydown($1::date, $2::bigint, $3::numeric, $4::bigint, $5, $6)::text as d",
        [x.fundedOn, x.amountCents, x.factorRate, x.paymentCents, x.frequency, pct],
      );
      expect(rows[0]?.d, JSON.stringify({ ...x, pct })).toBe(dateAtPaydown(x, pct));
    }
  });

  it("agrees with payoffDate on the 100% mark and handles a weekend start and month-end clamping", async () => {
    const cases: FundingTerms[] = [
      terms({ fundedOn: "2026-10-24" }), // Saturday
      terms({ fundedOn: "2026-10-25" }), // Sunday
      terms({ fundedOn: "2026-01-31", frequency: "monthly", paymentCents: 700_000 }),
      terms({ fundedOn: "2024-02-29", frequency: "biweekly", paymentCents: 300_000 }),
      terms({ fundedOn: "2026-10-23", frequency: "weekly", paymentCents: 250_000 }),
    ];
    for (const x of cases) {
      const { rows } = await t.pool.query<{ d: string }>(
        "select app.date_at_paydown($1::date, $2::bigint, $3::numeric, $4::bigint, $5, 100)::text as d",
        [x.fundedOn, x.amountCents, x.factorRate, x.paymentCents, x.frequency],
      );
      expect(rows[0]?.d, JSON.stringify(x)).toBe(payoffDate(x));
    }
  });

  it("the renewal call update_funding_terms leaves on the timer equals renewalDate for 40 random edits", async () => {
    const rand = mulberry32(777);
    const client = await insertClient(t.db, a, "Random Co");
    const id = await fund(a, client, { fundedOn: addDays(today, -1) });
    for (let i = 0; i < 40; i += 1) {
      // keep the funded date within the last 300 days so a share of renewal calls land in the future
      let x = randomTerms(rand, addDays(today, -150));
      x = { ...x, fundedOn: addDays(today, -Math.floor(rand() * 300)) };
      // reset to a known timer first: the previous edit may have left it at "today", which is what a fresh funding does
      await t.pool.query(
        "update timers set due_on = $2 where client_id = $1 and kind = 'renewal' and done_at is null",
        [client, addDays(today, -1)],
      );
      await edit(a, id, {
        funded_on: x.fundedOn,
        amount_cents: x.amountCents,
        factor_rate: x.factorRate,
        payment_cents: x.paymentCents,
        frequency: x.frequency,
        last_payment_on: null,
      });
      const renewal = (await timers(client)).find((r) => r.kind === "renewal");
      const expected = renewalDate(x, today) as string;
      // an overdue call (yesterday) stays overdue when the merchant is already past 50%; otherwise it matches exactly
      const want = expected <= today ? addDays(today, -1) : expected;
      expect(renewal?.due_on, JSON.stringify(x)).toBe(want);
    }
  });
});

describe("earnings queries", () => {
  it("lists advances with commission fields and keeps users apart", async () => {
    const client = await insertClient(t.db, a, "Listed Co");
    const id = await fund(a, client, { commission: "1000" });
    await t.db.withUser(a, (q) =>
      recordCommissionReceived(q, { fundingId: id, amount: 90_000, receivedOn: today }),
    );
    const mine = await t.db.withUser(a, (q) => listAdvances(q));
    const found = mine.find((x) => x.id === id);
    expect(found).toMatchObject({
      businessName: "Listed Co",
      amountCents: 5_000_000,
      commissionCents: 100_000,
      commissionReceivedCents: 90_000,
      commissionReceivedOn: today,
      status: "active",
    });
    expect((await t.db.withUser(b, (q) => listAdvances(q))).some((x) => x.id === id)).toBe(false);
  });

  it("loads with the Funders tables missing (feature-detected), and with them present", async () => {
    const withTables = await t.db.withUser(a, (q) => loadEarningsData(q));
    expect(withTables.hasOffers).toBe(true);
    expect(withTables.hasFunders).toBe(true);

    const own = await createTestDb();
    try {
      await own.pool.query("drop table offers, submissions, funders cascade");
      const uid = await insertUser(own.pool, "solo@x.com", "UTC");
      await insertClient(own.db, uid, "Solo Co");
      const data = await own.db.withUser(uid, (q) => loadEarningsData(q));
      expect(data.hasOffers).toBe(false);
      expect(data.hasFunders).toBe(false);
      expect(data.offers).toEqual([]);
      expect(data.funders).toEqual([]);
      expect(data.cards).toHaveLength(1);
    } finally {
      await own.drop();
    }
  });
});

describe("earnings queries and functions, against real rows", () => {
  it("hides a merchant who is in the trash", async () => {
    const client = await insertClient(t.db, a, "Trash Me Co");
    const id = await fund(a, client);
    expect((await t.db.withUser(a, (q) => listAdvances(q))).some((x) => x.id === id)).toBe(true);
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      client,
      a,
    ]);
    expect((await t.db.withUser(a, (q) => listAdvances(q))).some((x) => x.id === id)).toBe(false);
  });

  it("reads funders, offers and competing offers, and prices a deal from the funder's own points", async () => {
    const uid = await insertUser(t.pool, "pipeline@x.com", "UTC");
    const client = await insertClient(t.db, uid, "Pipeline Co");
    await t.pool.query(
      "update clients set stage = 'offers_in', industry = 'Restaurant' where id = $1",
      [client],
    );
    const funder = (
      await t.pool.query<{ id: string }>(
        "insert into funders (user_id, name, commission_points, renewal_paydown_pct) values ($1, 'Pearl Funding', 8, 60) returning id",
        [uid],
      )
    ).rows[0]?.id;
    const submission = (
      await t.pool.query<{ id: string }>(
        "insert into submissions (user_id, client_id, funder_id) values ($1, $2, $3) returning id",
        [uid, client, funder],
      )
    ).rows[0]?.id;
    await t.pool.query(
      "insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate, position_no) values ($1, $2, $3, 4000000, 1.31, 2)",
      [uid, client, submission],
    );
    await t.pool.query(
      "insert into competing_offers (user_id, client_id, funder_name, factor_rate, won) values ($1, $2, 'Rival', 1.42, true)",
      [uid, client],
    );

    const data = await t.db.withUser(uid, (q) => loadEarningsData(q));
    expect(data.funders).toEqual([
      { name: "Pearl Funding", commissionPoints: 8, renewalPaydownPct: 60 },
    ]);
    expect(data.offers).toMatchObject([
      {
        funderName: "Pearl Funding",
        amountCents: 4_000_000,
        factorRate: 1.31,
        industry: "Restaurant",
      },
    ]);
    expect(data.competing).toMatchObject([
      { funderName: "Rival", factorRate: 1.42, won: true, businessName: "Pipeline Co" },
    ]);
    const p = pipelineDeals(data.deals, data.offers, commissionContext(data));
    expect(p.deals).toHaveLength(1);
    expect(p.deals[0]?.expected).toEqual({ cents: 320_000, basis: "funder", points: 8 });

    // and the whole page model builds from real rows
    const view = buildEarnings(data, today);
    expect(view.price.loss.deals).toHaveLength(1);
    expect(view.price.loss.deals[0]).toMatchObject({
      ourBestFactor: 1.31,
      competitorFactor: 1.42,
      gap: 0.11,
    });
    expect(view.price.observations.map((o) => o.source).sort()).toEqual(["competitor", "offer"]);
  });

  it("the functions are SECURITY INVOKER with a pinned search_path", async () => {
    const { rows } = await t.pool.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('update_funding_terms', 'date_at_paydown', 'earnings_add_business_days',
                            'earnings_fmt_money', 'earnings_fmt_factor', 'earnings_fmt_date',
                            'earnings_ordinal', 'earnings_fmt_remittance')`,
    );
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(false);
      expect(r.proconfig?.join(","), r.proname).toMatch(/search_path=public, pg_temp/);
    }
  });
});
