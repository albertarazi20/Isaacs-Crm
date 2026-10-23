import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/mca/dates";
import { findDuplicates } from "@/lib/data/queries";
import { NAME_KEY_SQL, nameKey } from "@/lib/data/nameKey";
import { termsJson } from "@/lib/earnings/mutations";
import { termsUpdateSchema } from "@/lib/earnings/schemas";
import { changedTermsPayload, checkTerms, termsForm } from "@/lib/earnings/terms";
import type { EditableFunding } from "@/lib/earnings/terms";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;
const d = (n: number) => addDays(t.today, n);

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "UTC");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);
let seq = 0;

async function merchant(name: string, stage = "application_in"): Promise<string> {
  seq += 1;
  const id = await insertClient(t.db, a, `${name} ${seq}`);
  await asA((q) =>
    q.query("select * from move_client($1, $2, $3::jsonb)", [
      id,
      stage,
      timersJson({ kind: "follow_up", due_on: d(2) }),
    ]),
  );
  return id;
}

async function funder(name: string): Promise<string> {
  const { rows } = await t.pool.query<{ id: string }>(
    "insert into funders (user_id, name) values ($1, $2) returning id",
    [a, name],
  );
  return rows[0]?.id as string;
}

/** Funds a merchant through record_funding; returns the new advance's id. */
async function fundIt(clientId: string, fundedOn: string, extra: Record<string, unknown> = {}) {
  await asA((q) =>
    q.query("select * from record_funding($1, $2::jsonb, $3::jsonb)", [
      clientId,
      JSON.stringify({
        funded_on: fundedOn,
        funder_name: "Alpha Capital",
        amount_cents: 5_000_000,
        factor_rate: 1.32,
        payment_cents: 55_000,
        frequency: "daily",
        position_no: 1,
        ...extra,
      }),
      timersJson(
        { kind: "check_in", due_on: d(30) },
        { kind: "renewal", due_on: d(60), note: "Renewal call" },
      ),
    ]),
  );
  const { rows } = await t.pool.query<{ id: string }>(
    "select id from fundings where client_id = $1 order by created_at desc limit 1",
    [clientId],
  );
  return rows[0]?.id as string;
}

const edit = (fundingId: string, terms: Record<string, unknown>) =>
  asA((q) =>
    q.query("select id from update_funding_terms($1, $2::jsonb)", [
      fundingId,
      JSON.stringify(terms),
    ]),
  );
const timersOf = async (clientId: string) =>
  (
    await t.pool.query<{ kind: string; due_on: string }>(
      "select kind, due_on::text from timers where client_id = $1 and done_at is null order by kind",
      [clientId],
    )
  ).rows;
const fundingRow = async (id: string) =>
  (await t.pool.query("select * from fundings where id = $1", [id])).rows[0];

describe("A-7: correcting a funded date", () => {
  async function twoAdvances() {
    const id = await merchant("Two advances", "funded");
    const first = await fundIt(id, d(-200));
    const second = await fundIt(id, d(-10));
    return { id, first, second };
  }

  it("a date that would put this advance on the other side of another one is refused when more is changed", async () => {
    const { id, first, second } = await twoAdvances();
    const before = await timersOf(id);
    await expect(edit(second, { funded_on: d(-300), note: "typo" })).rejects.toThrow(
      /other side of the one funded/,
    );
    expect((await fundingRow(second)).funded_on).toBe(d(-10));
    expect(await timersOf(id)).toEqual(before);
    expect((await fundingRow(first)).status).toBe("renewed");
  });

  it("as the only change it goes through, and the renewal call follows the new date instead of staying stale", async () => {
    const { id, second } = await twoAdvances();
    const renewalBefore = (await timersOf(id)).find((x) => x.kind === "renewal");
    expect((renewalBefore?.due_on ?? "") > t.today).toBe(true);
    await edit(second, { funded_on: d(-300) });
    // 50% paid down 300 days ago + a bit: the call is due now, not on the date the wrong terms gave
    const renewalAfter = (await timersOf(id)).find((x) => x.kind === "renewal");
    expect(renewalAfter?.due_on ?? "9999").toSatisfy((x: string) => x <= t.today);
    const { rows } = await t.pool.query<{ body: string }>(
      "select body from activities where client_id = $1 and kind = 'funding' order by created_at desc limit 1",
      [id],
    );
    expect(rows[0]?.body).toMatch(/^Advance terms corrected: funded date/);
    expect(rows[0]?.body).toMatch(/renewal call moved to/);
  });

  it("a date change that keeps the order is fine alongside other changes", async () => {
    const { id, second } = await twoAdvances();
    await edit(second, { funded_on: d(-20), note: "moved ten days" });
    expect((await fundingRow(second)).note).toBe("moved ten days");
    expect((await timersOf(id)).some((x) => x.kind === "renewal")).toBe(true);
  });
});

describe("A-8: accepting an offer, and undoing it", () => {
  async function threeOffers() {
    const id = await merchant("Offers", "application_in");
    const fs = [await funder(`F1 ${seq}`), await funder(`F2 ${seq}`), await funder(`F3 ${seq}`)];
    const subs = (
      await asA((q) =>
        q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], null, '')", [
          id,
          fs,
        ]),
      )
    ).rows.map((r) => r.id);
    const offers: string[] = [];
    for (const [i, s] of subs.entries()) {
      const o = await asA((q) =>
        q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
          s,
          JSON.stringify({ amount_cents: 4_000_000 + i * 100_000, factor_rate: 1.3 + i / 100 }),
        ]),
      );
      offers.push(o.rows[0]?.id as string);
    }
    return { id, subs, offers };
  }
  const states = async (ids: string[]) =>
    Object.fromEntries(
      (
        await t.pool.query<{ id: string; status: string }>(
          "select id, status from offers where id = any($1::uuid[])",
          [ids],
        )
      ).rows.map((r) => [r.id, r.status]),
    );
  const accept = (id: string) => asA((q) => q.query("select * from accept_offer($1)", [id]));
  const setStatus = (id: string, s: string) =>
    asA((q) => q.query("select * from set_offer_status($1, $2)", [id, s]));

  it("Undo accept brings back the offers the acceptance turned down, as they were", async () => {
    const { offers } = await threeOffers();
    const [o1, o2, o3] = offers as [string, string, string];
    await setStatus(o2, "presented");
    await accept(o1);
    expect(await states(offers)).toEqual({ [o1]: "accepted", [o2]: "declined", [o3]: "declined" });
    await setStatus(o1, "open");
    expect(await states(offers)).toEqual({ [o1]: "open", [o2]: "presented", [o3]: "open" });
    const left = await t.pool.query(
      "select count(*)::int n from offers where id = any($1::uuid[]) and (declined_by is not null or declined_from is not null)",
      [offers],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("an offer the merchant turned down himself is NOT brought back by undoing another acceptance", async () => {
    const { offers } = await threeOffers();
    const [o1, o2, o3] = offers as [string, string, string];
    await setStatus(o3, "declined");
    await accept(o1);
    await setStatus(o1, "open");
    expect(await states(offers)).toEqual({ [o1]: "open", [o2]: "open", [o3]: "declined" });
  });

  it("an offer whose funder pulled out in the meantime stays turned down", async () => {
    const { subs, offers } = await threeOffers();
    const [o1, o2, o3] = offers as [string, string, string];
    await accept(o1);
    await asA((q) =>
      q.query("select * from set_submission_status($1, 'withdrawn', null, '')", [subs[1]]),
    );
    await setStatus(o1, "open");
    expect(await states(offers)).toEqual({ [o1]: "open", [o2]: "declined", [o3]: "open" });
  });

  it("switching the accepted offer works, and undoing the switch puts the first one back", async () => {
    const { offers } = await threeOffers();
    const [o1, o2, o3] = offers as [string, string, string];
    await accept(o1);
    await accept(o2);
    expect(await states(offers)).toEqual({ [o1]: "declined", [o2]: "accepted", [o3]: "declined" });
    await setStatus(o2, "open");
    expect(await states(offers)).toEqual({ [o1]: "open", [o2]: "open", [o3]: "open" });
  });

  it("refuses an offer that lapsed, one he turned down himself, and one from a funder that said no", async () => {
    const { subs, offers } = await threeOffers();
    const [o1, o2, o3] = offers as [string, string, string];
    await setStatus(o1, "expired");
    await expect(accept(o1)).rejects.toThrow(/expired/);
    await setStatus(o2, "declined");
    await expect(accept(o2)).rejects.toThrow(/turned down/);
    await asA((q) =>
      q.query("select * from set_submission_status($1, 'declined', 'credit', '')", [subs[2]]),
    );
    await expect(accept(o3)).rejects.toThrow(/expired/);
    await setStatus(o2, "open");
    expect((await states([o2]))[o2]).toBe("open");
    await expect(setStatus(o3, "open")).rejects.toThrow(/declined this deal/);
    expect((await states([o1, o2, o3]))[o3]).toBe("expired");
  });
});

describe("A-16: no deadlocks between two actions on one merchant", () => {
  it("40 rounds of record_default against update_funding_terms: none die", async () => {
    let deadlocks = 0;
    let other = 0;
    for (let i = 0; i < 40; i += 1) {
      const id = await merchant("Race", "funded");
      const f = await fundIt(id, d(-30));
      const results = await Promise.allSettled([
        asA((q) =>
          q.query(
            "select * from record_default($1, 'default_workable', $2, null, null, $3::jsonb, '')",
            [id, d(-1), timersJson({ kind: "follow_up", due_on: d(3) })],
          ),
        ),
        edit(f, { payment_cents: 60_000 }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          if ((r.reason as { code?: string }).code === "40P01") deadlocks += 1;
          else other += 1;
        }
      }
    }
    expect({ deadlocks, other }).toEqual({ deadlocks: 0, other: 0 });
  });

  it("40 rounds of accept_offer against set_submission_status: none die", async () => {
    let deadlocks = 0;
    for (let i = 0; i < 40; i += 1) {
      const id = await merchant("Race offers");
      const [f1, f2] = [await funder(`RA ${seq}`), await funder(`RB ${seq}`)];
      const subs = (
        await asA((q) =>
          q.query<{ id: string }>("select * from create_submissions($1, $2::uuid[], null, '')", [
            id,
            [f1, f2],
          ]),
        )
      ).rows.map((r) => r.id);
      const mk = async (s: string) =>
        (
          await asA((q) =>
            q.query<{ id: string }>("select * from record_offer($1, $2::jsonb)", [
              s,
              JSON.stringify({ amount_cents: 1_000_000, factor_rate: 1.3 }),
            ]),
          )
        ).rows[0]?.id as string;
      const o1 = await mk(subs[0] as string);
      await mk(subs[1] as string);
      const results = await Promise.allSettled([
        asA((q) => q.query("select * from accept_offer($1)", [o1])),
        asA((q) =>
          q.query("select * from set_submission_status($1, 'declined', 'credit', '')", [subs[1]]),
        ),
      ]);
      for (const r of results) {
        if (r.status === "rejected" && (r.reason as { code?: string }).code === "40P01")
          deadlocks += 1;
      }
    }
    expect(deadlocks).toBe(0);
  });
});

describe("I-2: re-entering a default stage keeps the default date he gives", () => {
  const defaults = (id: string, on: string | null) =>
    asA((q) =>
      q.query(
        "select * from record_default($1, 'default_workable', $2::date, null, null, $3::jsonb, '')",
        [id, on, timersJson({ kind: "follow_up", due_on: d(3) })],
      ),
    );
  it("a new date replaces the old; no date keeps it", async () => {
    const id = await merchant("Defaulter", "funded");
    const f = await fundIt(id, d(-60));
    await defaults(id, d(-9));
    expect((await fundingRow(f)).defaulted_on).toBe(d(-9));
    await defaults(id, d(-4));
    expect((await fundingRow(f)).defaulted_on).toBe(d(-4));
    await defaults(id, null);
    expect((await fundingRow(f)).defaulted_on).toBe(d(-4));
  });
  it("a first default with no date uses today", async () => {
    const id = await merchant("Defaulter 2", "funded");
    const f = await fundIt(id, d(-60));
    await defaults(id, null);
    expect((await fundingRow(f)).defaulted_on).toBe(t.today);
  });
});

describe("A-12: the Funding dialog sends only what changed", () => {
  const fundingRowFor = (over: Partial<EditableFunding> = {}): EditableFunding => ({
    id: "11111111-1111-4111-8111-111111111111",
    funded_on: "2026-10-01",
    funder_name: "Alpha Capital",
    amount_cents: 5_000_000,
    factor_rate: 1.32,
    payback_cents: 6_600_000,
    payment_cents: 55_000,
    frequency: "daily",
    position_no: 1,
    term_days: null,
    commission_cents: 250_000,
    paid_back_override_cents: null,
    status: "active",
    defaulted_on: null,
    last_payment_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    note: "",
    commission_received_cents: null,
    commission_received_on: null,
    ...over,
  });
  const TODAY = "2026-10-23";

  it("changing one box sends one key", () => {
    const f = fundingRowFor();
    const before = termsForm(f, "UTC");
    const now = { ...before, note: "called the funder" };
    const sent = changedTermsPayload(
      f.id,
      { form: now, commissionCents: checkTerms(now, TODAY).commissionCents },
      { form: before, commissionCents: checkTerms(before, TODAY).commissionCents },
    );
    expect(sent).toEqual({ fundingId: f.id, note: "called the funder" });
  });

  it("nothing changed sends nothing", () => {
    const f = fundingRowFor();
    const before = termsForm(f, "UTC");
    const c = checkTerms(before, TODAY).commissionCents;
    expect(
      changedTermsPayload(
        f.id,
        { form: before, commissionCents: c },
        { form: before, commissionCents: c },
      ),
    ).toBeNull();
  });

  it("clearing a box sends null for it (not 'unchanged')", () => {
    const f = fundingRowFor({ paid_back_override_cents: 1_000_000 });
    const before = termsForm(f, "UTC");
    const now = { ...before, paidBackOverride: "" };
    const sent = changedTermsPayload(
      f.id,
      { form: now, commissionCents: checkTerms(now, TODAY).commissionCents },
      { form: before, commissionCents: checkTerms(before, TODAY).commissionCents },
    );
    expect(sent).toEqual({ fundingId: f.id, paidBackOverride: "" });
    // ...and the schema reads that empty box as "clear it"
    expect(termsUpdateSchema.parse(sent).paidBackOverride).toBeNull();
  });

  it("only the keys sent reach update_funding_terms", async () => {
    const parsed = termsUpdateSchema.parse({
      fundingId: "11111111-1111-4111-8111-111111111111",
      note: "x",
    });
    const json = await termsJson({ query: async () => ({ rows: [] }) } as never, parsed, {
      timezone: "UTC",
      today: TODAY,
    } as never);
    expect(json).toEqual({ note: "x" });
  });

  it("a save from a stale dialog leaves a commission recorded since untouched", async () => {
    const id = await merchant("Stale dialog", "funded");
    const f = await fundIt(id, d(-10));
    // the dialog opens here (commission not yet received) ...
    // ... meanwhile the phone records it:
    await edit(f, { commission_received_cents: 400_000, commission_received_on: d(-1) });
    // ... and the laptop saves a note, sending just the note:
    await edit(f, { note: "from the laptop" });
    const row = await fundingRow(f);
    expect(row.note).toBe("from the laptop");
    expect(Number(row.commission_received_cents)).toBe(400_000);
  });
});

describe("A-15: the duplicate check reads names the same way in TypeScript and in the database", () => {
  const NAMES = [
    "Mike's Pizza, LLC",
    "MIKES PIZZA LLC",
    "Café Núñez",
    "CAFÉ NÚÑEZ",
    "Peña's Taquería",
    "7-Eleven #4412",
    "A&B Auto (Miami)",
    "王记餐厅",
    "  spaced   out  ",
    "O'Brien & Sons",
  ];
  it("nameKey equals the SQL expression for every name", async () => {
    for (const n of NAMES) {
      const { rows } = await t.pool.query<{ k: string }>(
        `select ${NAME_KEY_SQL("$1::text")} as k`,
        [n],
      );
      expect(rows[0]?.k, n).toBe(nameKey(n));
    }
  });
  it("accented spellings of one business find each other; a name with no letters has no key", async () => {
    await insertClient(t.db, a, "Café Núñez");
    const hit = await asA((q) => findDuplicates(q, { businessName: "CAFÉ  NÚÑEZ!" }));
    expect(hit.map((m) => m.business_name)).toEqual(["Café Núñez"]);
    expect(nameKey("王记餐厅")).toBe("");
    expect(await asA((q) => findDuplicates(q, { businessName: "王记餐厅" }))).toEqual([]);
  });
});
