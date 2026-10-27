import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, addMonths } from "@/lib/mca/dates";
import { paybackCents, renewalDate, type FundingTerms } from "@/lib/mca/funding";
import { defaultTimers } from "@/lib/mca/stages";
import { defaultStips } from "@/lib/mca/stips";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
let b: string;
const today = () => t.today;
const fu = (days: number, kind = "follow_up") => ({ kind, due_on: addDays(today(), days) });

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
  b = await insertUser(t.pool, "other@x.com");
});
afterAll(async () => {
  await t.drop();
});

const openTimers = async (clientId: string) =>
  (
    await t.pool.query<{ kind: string; due_on: string }>(
      "select kind, due_on from timers where client_id = $1 and done_at is null order by due_on, kind",
      [clientId],
    )
  ).rows;
const stageOf = async (clientId: string) =>
  (await t.pool.query<{ stage: string }>("select stage from clients where id = $1", [clientId]))
    .rows[0]?.stage;
const activities = async (clientId: string) =>
  (
    await t.pool.query<{
      kind: string;
      from_stage: string | null;
      to_stage: string | null;
      body: string;
      outcome: string | null;
    }>(
      "select kind, from_stage, to_stage, body, outcome from activities where client_id = $1 order by created_at, id",
      [clientId],
    )
  ).rows;

describe("create_client", () => {
  it("creates the card, its first timer and a timeline entry in one transaction", async () => {
    const id = await insertClient(t.db, a, "Create Co", addDays(today(), 2));
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: addDays(today(), 2) }]);
    expect(await stageOf(id)).toBe("name_in");
    expect((await activities(id)).map((x) => x.kind)).toEqual(["system"]);
  });
  it("refuses a client with no timer and leaves no orphan row", async () => {
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from create_client($1::jsonb, '[]'::jsonb)", [
          JSON.stringify({ business_name: "Orphan Co" }),
        ]),
      ),
    ).rejects.toThrow(/at least one timer/);
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from clients where business_name = 'Orphan Co'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("refuses a date past 36 months, accepts exactly 36", async () => {
    const edge = addMonths(today(), 36);
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from create_client($1::jsonb, $2::jsonb)", [
          JSON.stringify({ business_name: "Far Co" }),
          timersJson({ kind: "follow_up", due_on: addDays(edge, 5) }),
        ]),
      ),
    ).rejects.toThrow(/36 months/);
    const id = await insertClient(t.db, a, "Edge Co", edge);
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: edge }]);
  });
  it("stamps the row with the calling user, whatever the payload says", async () => {
    const id = await insertClient(t.db, b, "B Co");
    expect(
      (await t.pool.query("select user_id from clients where id = $1", [id])).rows[0].user_id,
    ).toBe(b);
  });
});

describe("move_client", () => {
  it("changes the stage, swaps the timers and writes the timeline — in the database", async () => {
    const id = await insertClient(t.db, a, "Move Co");
    const [timer] = defaultTimers("interested", { today: today() });
    if (!timer) throw new Error("no default timer");
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'interested', $2::jsonb, 'Called, wants 50k')", [
        id,
        timersJson({ kind: timer.kind, due_on: timer.dueOn }),
      ]),
    );
    expect(await stageOf(id)).toBe("interested");
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: timer.dueOn }]);
    const closed = await t.pool.query(
      "select done_reason from timers where client_id = $1 and done_at is not null",
      [id],
    );
    expect(closed.rows).toEqual([{ done_reason: "stage_moved" }]);
    const acts = await activities(id);
    expect(acts.at(-1)).toMatchObject({
      kind: "stage_change",
      from_stage: "name_in",
      to_stage: "interested",
      body: "Called, wants 50k",
    });
  });
  it("bumps stage_changed_at only when the stage really changes", async () => {
    const id = await insertClient(t.db, a, "Stamp Co");
    const before = (await t.pool.query("select stage_changed_at from clients where id = $1", [id]))
      .rows[0].stage_changed_at;
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'name_in', $2::jsonb)", [id, timersJson(fu(5))]),
    );
    const same = (await t.pool.query("select stage_changed_at from clients where id = $1", [id]))
      .rows[0].stage_changed_at;
    expect(same).toEqual(before);
    expect((await activities(id)).filter((x) => x.kind === "stage_change")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 15));
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'dead', $2::jsonb)", [
        id,
        timersJson({ kind: "follow_up", due_on: addMonths(today(), 9) }),
      ]),
    );
    const moved = (await t.pool.query("select stage_changed_at from clients where id = $1", [id]))
      .rows[0].stage_changed_at;
    expect(moved.getTime()).toBeGreaterThan(before.getTime());
  });
  it("rolls the whole move back when the timers are empty — nothing half-applied", async () => {
    const id = await insertClient(t.db, a, "Atomic Co");
    await expect(
      t.db.withUser(a, (q) => q.query("select * from move_client($1, 'dead', '[]'::jsonb)", [id])),
    ).rejects.toThrow(/at least one timer/);
    expect(await stageOf(id)).toBe("name_in");
    expect(await openTimers(id)).toHaveLength(1);
  });
  it("rejects an unknown stage and leaves the old timer open", async () => {
    const id = await insertClient(t.db, a, "Bad Stage Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from move_client($1, 'closed_won', $2::jsonb)", [id, timersJson(fu(3))]),
      ),
    ).rejects.toThrow(/foreign key/);
    expect(await openTimers(id)).toHaveLength(1);
  });
  it("keeps a booked call when the stage moves", async () => {
    const id = await insertClient(t.db, a, "Keep Call Co");
    await t.db.withUser(a, (q) =>
      q.query("select * from schedule_call($1, $2)", [id, `${addDays(today(), 3)}T15:00:00Z`]),
    );
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'application_sent', $2::jsonb)", [
        id,
        timersJson(fu(3)),
      ]),
    );
    expect((await openTimers(id)).map((x) => x.kind).sort()).toEqual([
      "follow_up",
      "scheduled_call",
    ]);
  });
});

describe("set_follow_up (dragging to a follow-up column)", () => {
  it("moves the follow-up, pushes an earlier check-in out, and keeps a later renewal call", async () => {
    const id = await insertClient(t.db, a, "Drag Co");
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'funded', $2::jsonb)", [
        id,
        timersJson(fu(30, "check_in"), fu(80, "renewal")),
      ]),
    );
    expect(await openTimers(id)).toHaveLength(2);
    const target = addMonths(today(), 2);
    await t.db.withUser(a, (q) =>
      q.query("select * from set_follow_up($1, $2, 'busy till then')", [id, target]),
    );
    expect(await openTimers(id)).toEqual([
      { kind: "check_in", due_on: target },
      { kind: "follow_up", due_on: target },
      { kind: "renewal", due_on: addDays(today(), 80) },
    ]);
    const card = await t.db.withUser(a, (q) =>
      q.query("select next_due_on from client_cards where id = $1", [id]),
    );
    expect(card.rows[0].next_due_on).toBe(target);
    expect((await activities(id)).at(-1)?.body).toContain("busy till then");
  });
  it("rejects 37 months and yesterday-and-earlier", async () => {
    const id = await insertClient(t.db, a, "Range Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from set_follow_up($1, $2)", [id, addMonths(today(), 37)]),
      ),
    ).rejects.toThrow(/36 months/);
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from set_follow_up($1, $2)", [id, addDays(today(), -5)]),
      ),
    ).rejects.toThrow(/past/);
    expect((await openTimers(id)).length).toBe(1);
  });
});

describe("log_touch (the one-tap outcome prompt)", () => {
  it("logs the call, stamps last contact and resets the timer", async () => {
    const id = await insertClient(t.db, a, "Touch Co");
    await t.db.withUser(a, (q) =>
      q.query(
        "select * from log_touch($1, 'call', 'reached', 'Wants 75k, call back after tax return', $2)",
        [id, addDays(today(), 14)],
      ),
    );
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: addDays(today(), 14) }]);
    const row = (await t.pool.query("select last_contact_at from clients where id = $1", [id]))
      .rows[0];
    expect(row.last_contact_at).toBeInstanceOf(Date);
    expect((await activities(id)).at(-1)).toMatchObject({ kind: "call", outcome: "reached" });
    const card = (
      await t.db.withUser(a, (q) =>
        q.query("select last_call_at, last_call_note from client_cards where id = $1", [id]),
      )
    ).rows[0];
    expect(card.last_call_note).toBe("Wants 75k, call back after tax return");
    expect(card.last_call_at).toBeInstanceOf(Date);
  });
  it("rejects a bad touch kind or outcome without moving the timer", async () => {
    const id = await insertClient(t.db, a, "Bad Touch Co", addDays(today(), 4));
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from log_touch($1, 'carrier_pigeon', 'reached', '', $2)", [
          id,
          addDays(today(), 1),
        ]),
      ),
    ).rejects.toThrow(/call, text or email/);
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from log_touch($1, 'call', 'ghosted', '', $2)", [
          id,
          addDays(today(), 1),
        ]),
      ),
    ).rejects.toThrow(/check constraint/);
    expect(await openTimers(id)).toEqual([{ kind: "follow_up", due_on: addDays(today(), 4) }]);
  });
  it("never lets the follow-up reset to nothing", async () => {
    const id = await insertClient(t.db, a, "Null Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from log_touch($1, 'call', 'no_answer', '', null)", [id]),
      ),
    ).rejects.toThrow(/due date is required/);
    expect(await openTimers(id)).toHaveLength(1);
  });
});

describe("schedule_call", () => {
  it("books the call on Isaac's local day, not UTC's", async () => {
    const id = await insertClient(t.db, a, "Call Co");
    // 02:00 UTC is 22:00 the previous evening in New York (UTC-4/-5).
    const at = `${addDays(today(), 3)}T02:00:00Z`;
    await t.db.withUser(a, (q) =>
      q.query("select * from schedule_call($1, $2, 'ask about the 2nd position')", [id, at]),
    );
    const call = (await openTimers(id)).find((x) => x.kind === "scheduled_call");
    expect(call?.due_on).toBe(addDays(today(), 2));
    expect(
      (
        await t.pool.query("select scheduled_call_at from clients where id = $1", [id])
      ).rows[0].scheduled_call_at.toISOString(),
    ).toBe(new Date(at).toISOString());
  });
  it("never changes the stage, early or late", async () => {
    const early = await insertClient(t.db, a, "Early Co");
    const late = await insertClient(t.db, a, "Late Co");
    await t.db.withUser(a, (q) =>
      q.query("select * from move_client($1, 'offers_in', $2::jsonb)", [late, timersJson(fu(1))]),
    );
    const at = `${addDays(today(), 3)}T15:00:00Z`;
    await t.db.withUser(a, (q) => q.query("select * from schedule_call($1, $2)", [early, at]));
    await t.db.withUser(a, (q) => q.query("select * from schedule_call($1, $2)", [late, at]));
    expect(await stageOf(early)).toBe("name_in");
    expect(await stageOf(late)).toBe("offers_in");
  });
  it("replaces a previously booked call instead of stacking two", async () => {
    const id = await insertClient(t.db, a, "Rebook Co");
    await t.db.withUser(a, (q) =>
      q.query("select * from schedule_call($1, $2)", [id, `${addDays(today(), 3)}T15:00:00Z`]),
    );
    await t.db.withUser(a, (q) =>
      q.query("select * from schedule_call($1, $2)", [id, `${addDays(today(), 5)}T15:00:00Z`]),
    );
    expect((await openTimers(id)).filter((x) => x.kind === "scheduled_call")).toHaveLength(1);
  });
});

describe("stips", () => {
  const seeds = () =>
    defaultStips(today(), 4).map((s) => ({ kind: s.kind, period: s.period, required: s.required }));

  it("seeds the checklist once — re-running adds nothing", async () => {
    const id = await insertClient(t.db, a, "Stip Co");
    const first = await t.db.withUser(a, (q) =>
      q.query("select add_stips($1, $2::jsonb) as n", [id, JSON.stringify(seeds())]),
    );
    expect(first.rows[0].n).toBe(11);
    const again = await t.db.withUser(a, (q) =>
      q.query("select add_stips($1, $2::jsonb) as n", [id, JSON.stringify(seeds())]),
    );
    expect(again.rows[0].n).toBe(0);
    expect(
      (await t.pool.query("select count(*)::int as n from stips where client_id = $1", [id]))
        .rows[0].n,
    ).toBe(11);
  });
  it("ticking a stip sets received_at, logs it and moves the card counts", async () => {
    const id = await insertClient(t.db, a, "Tick Co");
    await t.db.withUser(a, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [id, JSON.stringify(seeds())]),
    );
    const stip = (
      await t.pool.query("select id from stips where client_id = $1 and kind = 'voided_check'", [
        id,
      ])
    ).rows[0].id;
    await t.db.withUser(a, (q) => q.query("select * from set_stip_received($1, true)", [stip]));
    expect(
      (await t.pool.query("select received_at from stips where id = $1", [stip])).rows[0]
        .received_at,
    ).toBeInstanceOf(Date);
    const card = (
      await t.db.withUser(a, (q) =>
        q.query("select stips_required, stips_received from client_cards where id = $1", [id]),
      )
    ).rows[0];
    expect(card).toEqual({ stips_required: 7, stips_received: 1 });
    expect((await activities(id)).at(-1)?.body).toBe("Stip received: Voided check");
    await t.db.withUser(a, (q) => q.query("select * from set_stip_received($1, false)", [stip]));
    expect(
      (await t.pool.query("select received_at from stips where id = $1", [stip])).rows[0]
        .received_at,
    ).toBeNull();
  });
  it("won't tick another user's stip", async () => {
    const id = await insertClient(t.db, a, "Private Stip Co");
    await t.db.withUser(a, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [id, JSON.stringify(seeds())]),
    );
    const stip = (await t.pool.query("select id from stips where client_id = $1 limit 1", [id]))
      .rows[0].id;
    await expect(
      t.db.withUser(b, (q) => q.query("select * from set_stip_received($1, true)", [stip])),
    ).rejects.toThrow(/stip not found/);
    expect(
      (await t.pool.query("select received_at from stips where id = $1", [stip])).rows[0]
        .received_at,
    ).toBeNull();
  });
});

describe("record_funding", () => {
  const terms = (): FundingTerms => ({
    fundedOn: today(),
    amountCents: 5_000_000,
    factorRate: 1.32,
    paymentCents: 55_000,
    frequency: "daily",
  });
  const payload = (f: FundingTerms) => ({
    funded_on: f.fundedOn,
    amount_cents: f.amountCents,
    factor_rate: f.factorRate,
    payment_cents: f.paymentCents,
    frequency: f.frequency,
    funder_name: "Alpha Capital",
    commission_cents: 400_000,
  });

  it("stores the advance, moves the card to Funded and starts BOTH timers", async () => {
    const id = await insertClient(t.db, a, "Funded Co");
    const f = terms();
    const timers = defaultTimers("funded", { today: today(), funding: f }).map((x) => ({
      kind: x.kind,
      due_on: x.dueOn,
      note: x.note,
    }));
    await t.db.withUser(a, (q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify(payload(f)),
        JSON.stringify(timers),
      ]),
    );
    const row = (
      await t.pool.query(
        "select amount_cents, payback_cents, status, funder_name from fundings where client_id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      amount_cents: 5_000_000,
      payback_cents: paybackCents(5_000_000, 1.32),
      status: "active",
      funder_name: "Alpha Capital",
    });
    expect(await stageOf(id)).toBe("funded");
    expect(await openTimers(id)).toEqual([
      { kind: "check_in", due_on: addDays(today(), 30) },
      { kind: "renewal", due_on: renewalDate(f, today()) },
    ]);
    expect((await activities(id)).map((x) => x.kind)).toEqual([
      "system",
      "stage_change",
      "funding",
    ]);
  });
  it("marks the previous advance renewed when a new one funds", async () => {
    const id = await insertClient(t.db, a, "Renew Co");
    const f = terms();
    const timers = JSON.stringify([fu(30, "check_in")]);
    await t.db.withUser(a, (q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify(payload(f)),
        timers,
      ]),
    );
    await t.db.withUser(a, (q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify({ ...payload(f), amount_cents: 8_000_000 }),
        timers,
      ]),
    );
    const rows = (
      await t.pool.query(
        "select amount_cents, status from fundings where client_id = $1 order by amount_cents",
        [id],
      )
    ).rows;
    expect(rows).toEqual([
      { amount_cents: 5_000_000, status: "renewed" },
      { amount_cents: 8_000_000, status: "active" },
    ]);
  });
  it("rolls back the funding if the timers are invalid", async () => {
    const id = await insertClient(t.db, a, "Rollback Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from record_funding($1, $2::jsonb, '[]'::jsonb)", [
          id,
          JSON.stringify(payload(terms())),
        ]),
      ),
    ).rejects.toThrow(/at least one timer/);
    expect(
      (await t.pool.query("select count(*)::int as n from fundings where client_id = $1", [id]))
        .rows[0].n,
    ).toBe(0);
    expect(await stageOf(id)).toBe("name_in");
  });
});

describe("record_default", () => {
  const funded = async (name: string) => {
    const id = await insertClient(t.db, a, name);
    const payload = {
      funded_on: today(),
      amount_cents: 3_000_000,
      factor_rate: 1.3,
      payment_cents: 40_000,
      frequency: "daily",
    };
    await t.db.withUser(a, (q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify(payload),
        JSON.stringify([fu(30, "check_in")]),
      ]),
    );
    return id;
  };

  it("stamps the default date and promise-to-pay on the advance and moves the card", async () => {
    const id = await funded("Default Co");
    const promise = `${addDays(today(), 4)}T14:30:00Z`;
    await t.db.withUser(a, (q) =>
      q.query(
        "select * from record_default($1, 'default_workable', $2, $3, 150000, $4::jsonb, 'Says Friday')",
        [id, today(), promise, JSON.stringify([fu(3)])],
      ),
    );
    const f = (
      await t.pool.query(
        "select status, defaulted_on, promise_to_pay_at, promise_amount_cents from fundings where client_id = $1",
        [id],
      )
    ).rows[0];
    expect(f.status).toBe("defaulted");
    expect(f.defaulted_on).toBe(today());
    expect(f.promise_to_pay_at.toISOString()).toBe(new Date(promise).toISOString());
    expect(f.promise_amount_cents).toBe(150_000);
    expect(await stageOf(id)).toBe("default_workable");
    const card = (
      await t.db.withUser(a, (q) =>
        q.query("select defaulted_on, promise_amount_cents from client_cards where id = $1", [id]),
      )
    ).rows[0];
    expect(card).toEqual({ defaulted_on: today(), promise_amount_cents: 150_000 });
  });
  it("only accepts default stages and only for a client that was funded", async () => {
    const id = await funded("Wrong Stage Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from record_default($1, 'dead', $2, null, null, $3::jsonb)", [
          id,
          today(),
          JSON.stringify([fu(3)]),
        ]),
      ),
    ).rejects.toThrow(/not a default stage/);
    const never = await insertClient(t.db, a, "Never Funded Co");
    await expect(
      t.db.withUser(a, (q) =>
        q.query("select * from record_default($1, 'default_bad', $2, null, null, $3::jsonb)", [
          never,
          today(),
          JSON.stringify([fu(3)]),
        ]),
      ),
    ).rejects.toThrow(/no funding/);
    expect(await stageOf(never)).toBe("name_in");
  });
});

describe("client_cards", () => {
  it("surfaces the earliest open timer, the newest ask, the stack and the latest funding", async () => {
    const id = await insertClient(t.db, a, "Card Co", addDays(today(), 20));
    await t.db.withUser(a, async (q) => {
      await q.query("select * from set_follow_up($1, $2)", [id, addDays(today(), 20)]);
      await q.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'renewal', $3)",
        [a, id, addDays(today(), 6)],
      );
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms) values ($1, $2, 3000000, 'old ask')",
        [a, id],
      );
    });
    await new Promise((r) => setTimeout(r, 15));
    await t.db.withUser(a, async (q) => {
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms, est_approval_cents) values ($1, $2, 7500000, '75k, 9 months, daily', 5000000)",
        [a, id],
      );
      await q.query(
        "insert into positions (user_id, client_id, position_no, funder_name, funded_amount_cents, payback_cents, balance_cents) values ($1,$2,1,'Alpha',3000000,4200000,2100000), ($1,$2,2,'Beta',1000000,1400000,1400000)",
        [a, id],
      );
    });
    const c = (
      await t.db.withUser(a, (q) => q.query("select * from client_cards where id = $1", [id]))
    ).rows[0];
    expect(c).toMatchObject({
      next_due_on: addDays(today(), 6),
      next_due_kind: "renewal",
      wanted_amount_cents: 7_500_000,
      wanted_terms: "75k, 9 months, daily",
      est_approval_cents: 5_000_000,
      position_count: 2,
      position_balance_cents: 3_500_000,
    });
  });
  it("sorts by due date so a renewal due next week beats a follow-up due next month", async () => {
    const later = await insertClient(t.db, a, "Sort Later Co", addDays(today(), 30));
    const sooner = await insertClient(t.db, a, "Sort Sooner Co", addDays(today(), 30));
    await t.db.withUser(a, (q) =>
      q.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'renewal', $3)",
        [a, sooner, addDays(today(), 6)],
      ),
    );
    const { rows } = await t.db.withUser(a, (q) =>
      q.query("select id from client_cards where id = any($1) order by next_due_on", [
        [later, sooner],
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual([sooner, later]);
  });
});

describe("integrity", () => {
  it("never leaves a client without an open timer after any of the functions above", async () => {
    const { rows } = await t.pool.query(
      "select c.business_name from clients c where not exists (select 1 from timers x where x.client_id = c.id and x.done_at is null)",
    );
    expect(rows).toEqual([]);
  });
  it("keeps timers and notes on the same owner as their client", async () => {
    const id = await insertClient(t.db, a, "Owner Co");
    await expect(
      t.pool.query(
        "insert into timers (user_id, client_id, kind, due_on) values ($1, $2, 'follow_up', current_date)",
        [b, id],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("timeline wording and ordering written by the database", () => {
  it("writes follow-ups, stips and fundings the way Isaac would say them", async () => {
    const id = await insertClient(t.db, a, "Wording Co");
    const due = addMonths(today(), 2);
    await t.db.withUser(a, (q) => q.query("select * from set_follow_up($1, $2)", [id, due]));
    const MON = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const [y, mo, d] = due.split("-").map(Number) as [number, number, number];
    expect((await activities(id)).at(-1)?.body).toBe(`Follow up set for ${MON[mo - 1]} ${d}, ${y}`);

    await t.db.withUser(a, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify([{ kind: "bank_statement", period: "2026-07-01", required: true }]),
      ]),
    );
    const stip = (await t.pool.query("select id from stips where client_id = $1", [id])).rows[0].id;
    await t.db.withUser(a, (q) => q.query("select * from set_stip_received($1, true)", [stip]));
    expect((await activities(id)).at(-1)?.body).toBe("Stip received: Jul 2026 bank statement");
    await t.db.withUser(a, (q) => q.query("select * from set_stip_received($1, false)", [stip]));
    expect((await activities(id)).at(-1)?.body).toBe(
      "Stip marked missing: Jul 2026 bank statement",
    );

    const funding = {
      funded_on: today(),
      amount_cents: 5_000_000,
      factor_rate: 1.32,
      payment_cents: 55_000,
      frequency: "daily",
    };
    await t.db.withUser(a, (q) =>
      q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
        id,
        JSON.stringify(funding),
        JSON.stringify([fu(30, "check_in")]),
      ]),
    );
    expect((await activities(id)).at(-1)?.body).toBe("Funded $50,000 at 1.32 factor");
  });
  it("two asks saved in the same transaction still have a clear newest", async () => {
    const id = await insertClient(t.db, a, "Same Tx Ask Co");
    await t.db.withUser(a, async (q) => {
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 1000000)",
        [a, id],
      );
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 2000000)",
        [a, id],
      );
    });
    const card = (
      await t.db.withUser(a, (q) =>
        q.query("select wanted_amount_cents from client_cards where id = $1", [id]),
      )
    ).rows[0];
    expect(card.wanted_amount_cents).toBe(2_000_000);
  });
});
