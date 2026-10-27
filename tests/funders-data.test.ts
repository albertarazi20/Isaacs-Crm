import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserError } from "@/lib/data/mutations";
import { toActionError } from "@/lib/data/errors";
import * as m from "@/lib/funders/mutations";
import { funderScoreboard, getClientFundersData, listFunders } from "@/lib/funders/queries";
import * as s from "@/lib/funders/schemas";
import { addBusinessDays, todayIn } from "@/lib/mca/dates";
import { createTestDb, insertClient, insertUser, timersJson, type TestDb } from "./helpers/db";

let t: TestDb;
let a: string;

beforeAll(async () => {
  t = await createTestDb();
  a = await insertUser(t.pool, "isaac@x.com", "America/New_York");
});
afterAll(async () => {
  await t.drop();
});

type Q = Parameters<Parameters<typeof t.db.withUser>[1]>[0];
const asA = <T>(fn: (q: Q) => Promise<T>) => t.db.withUser(a, fn);

const newFunder = (over: Record<string, unknown> = {}) =>
  s.funderSchema.parse({ name: "Pearl Capital", ...over });

async function merchantInStage(name: string, stage: string): Promise<string> {
  const id = await insertClient(t.db, a, name);
  await asA((q) =>
    q.query("select * from move_client($1, $2, $3::jsonb)", [
      id,
      stage,
      timersJson({ kind: "follow_up", due_on: addBusinessDays(t.today, 2) }),
    ]),
  );
  return id;
}

describe("funders: save, archive, delete", () => {
  it("saves a funder with its whole appetite and reads it back", async () => {
    const id = await asA((q) =>
      m.saveFunder(
        q,
        newFunder({
          name: "Pearl Capital",
          submissionEmail: "deals@pearl.example",
          contactName: "Dana",
          phone: "(305) 555-0199",
          notes: "Fast on 1st position",
          minMonthlyRevenue: "50k",
          minTimeInBusinessMonths: "12",
          maxPosition: "2",
          minAmount: "10k",
          maxAmount: "250k",
          excludedStates: "fl, new york",
          excludedIndustries: "restaurants, trucking",
          commissionPoints: "9.5",
          renewalPaydownPct: "60",
        }),
      ),
    );
    const f = (await asA((q) => listFunders(q))).find((x) => x.id === id);
    expect(f).toMatchObject({
      name: "Pearl Capital",
      submission_email: "deals@pearl.example",
      contact_name: "Dana",
      active: true,
      min_monthly_revenue_cents: 5_000_000,
      min_time_in_business_months: 12,
      max_position: 2,
      min_amount_cents: 1_000_000,
      max_amount_cents: 25_000_000,
      excluded_states: ["FL", "NY"],
      excluded_industries: ["restaurants", "trucking"],
      commission_points: 9.5,
      renewal_paydown_pct: 60,
    });
  });

  it("edits in place: clearing a limit really clears it", async () => {
    const id = await asA((q) =>
      m.saveFunder(q, newFunder({ name: "Edit Me", minMonthlyRevenue: "40k", maxPosition: "1" })),
    );
    await asA((q) =>
      m.saveFunder(
        q,
        newFunder({ id, name: "Edit Me Now", minMonthlyRevenue: "", maxPosition: "" }),
      ),
    );
    const row = await t.pool.query(
      "select name, min_monthly_revenue_cents, max_position from funders where id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({
      name: "Edit Me Now",
      min_monthly_revenue_cents: null,
      max_position: null,
    });
  });

  it("refuses a second funder with the same name in plain words, in any capitalisation", async () => {
    await asA((q) => m.saveFunder(q, newFunder({ name: "Libertas" })));
    const err = await asA((q) => m.saveFunder(q, newFunder({ name: "  LIBERTAS " }))).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UserError);
    expect(toActionError(err)).toBe("You already have a funder called LIBERTAS");
  });

  it("editing a funder that is gone says so", async () => {
    const err = await asA((q) =>
      m.saveFunder(q, newFunder({ id: "00000000-0000-4000-8000-000000000000" })),
    ).catch((e) => e);
    expect(toActionError(err)).toBe("That funder no longer exists");
  });

  it("archives and restores, and the Send list can tell them apart", async () => {
    const id = await asA((q) => m.saveFunder(q, newFunder({ name: "Archive Me" })));
    await asA((q) => m.setFunderActive(q, id, false));
    expect(
      (await t.pool.query("select active from funders where id = $1", [id])).rows[0].active,
    ).toBe(false);
    expect((await asA((q) => listFunders(q))).find((f) => f.id === id)?.active).toBe(false);
    await asA((q) => m.setFunderActive(q, id, true));
    expect(
      (await t.pool.query("select active from funders where id = $1", [id])).rows[0].active,
    ).toBe(true);
  });

  it("deletes a funder nothing was sent to, but sends you to Archive when something was", async () => {
    const unused = await asA((q) => m.saveFunder(q, newFunder({ name: "Never Used" })));
    await asA((q) => m.deleteFunder(q, unused));
    expect((await t.pool.query("select 1 from funders where id = $1", [unused])).rowCount).toBe(0);

    const used = await asA((q) => m.saveFunder(q, newFunder({ name: "Used Once" })));
    const client = await merchantInStage("Delete Check", "application_in");
    await asA((q) =>
      m.sendToFunders(q, s.sendSchema.parse({ clientId: client, funderIds: [used] })),
    );
    const err = await asA((q) => m.deleteFunder(q, used)).catch((e) => e);
    expect(toActionError(err)).toBe("Applications were sent to this funder — archive it instead");
    expect((await t.pool.query("select 1 from funders where id = $1", [used])).rowCount).toBe(1);
  });
});

describe("the whole flow through the app's own mutation layer", () => {
  it("send to two funders, one approves with an offer, one declines, accept — and every step is in the database", async () => {
    const pearl = await asA((q) =>
      m.saveFunder(q, newFunder({ name: "Flow Pearl", commissionPoints: "8" })),
    );
    const libertas = await asA((q) => m.saveFunder(q, newFunder({ name: "Flow Libertas" })));
    const everest = await asA((q) => m.saveFunder(q, newFunder({ name: "Flow Everest" })));
    const client = await merchantInStage("Flow Merchant", "stips");

    const sent = await asA((q) =>
      m.sendToFunders(
        q,
        s.sendSchema.parse({
          clientId: client,
          funderIds: [pearl, libertas, everest],
          note: "Full package",
        }),
      ),
    );
    expect(sent).toBe(3);

    let data = await asA((q) => getClientFundersData(q, client));
    expect(data.submissions.map((x) => x.funder_name)).toEqual([
      "Flow Everest",
      "Flow Libertas",
      "Flow Pearl",
    ]);
    expect(
      data.submissions.every(
        (x) =>
          x.status === "sent" && x.chase_due_on === addBusinessDays(todayIn("America/New_York"), 1),
      ),
    ).toBe(true);
    expect(data.funders.map((f) => f.name)).toContain("Flow Pearl");
    const byName = (name: string) =>
      data.submissions.find((x) => x.funder_name === name)?.id as string;

    // Pearl approves with an offer
    await asA((q) =>
      m.recordOffer(
        q,
        s.offerSchema.parse({
          submissionId: byName("Flow Pearl"),
          amount: "45k",
          factorRate: "1.34",
          payment: "450",
          frequency: "daily",
          termDays: "130",
          positionNo: "1",
          fees: "500",
        }),
      ),
    );
    // Libertas declines
    await asA((q) =>
      m.setSubmissionStatus(
        q,
        s.statusSchema.parse({
          submissionId: byName("Flow Libertas"),
          status: "declined",
          declineReason: "nsfs",
          note: "6 NSFs in March",
        }),
      ),
    );

    data = await asA((q) => getClientFundersData(q, client));
    const pearlRow = data.submissions.find((x) => x.funder_name === "Flow Pearl");
    expect(pearlRow).toMatchObject({ status: "approved", chase_due_on: null });
    expect(pearlRow?.offers).toHaveLength(1);
    expect(pearlRow?.offers[0]).toMatchObject({
      amount_cents: 4_500_000,
      factor_rate: 1.34,
      payment_cents: 45_000,
      frequency: "daily",
      term_days: 130,
      position_no: 1,
      fees_cents: 50_000,
      status: "open",
    });
    expect(data.submissions.find((x) => x.funder_name === "Flow Libertas")).toMatchObject({
      status: "declined",
      decline_reason: "nsfs",
      decline_note: "6 NSFs in March",
      chase_due_on: null,
    });
    expect(data.submissions.find((x) => x.funder_name === "Flow Everest")?.chase_due_on).toBe(
      addBusinessDays(todayIn("America/New_York"), 1),
    );
    expect(
      (await t.pool.query("select stage from clients where id = $1", [client])).rows[0].stage,
    ).toBe("offers_in");

    // accept the offer — the merchant is not funded yet
    await asA((q) => m.acceptOffer(q, pearlRow?.offers[0]?.id as string));
    expect(
      (await t.pool.query("select status from offers where id = $1", [pearlRow?.offers[0]?.id]))
        .rows[0].status,
    ).toBe("accepted");
    expect(
      (await t.pool.query("select count(*)::int as n from fundings where client_id = $1", [client]))
        .rows[0].n,
    ).toBe(0);

    // the scoreboard is computed from those rows
    const board = await asA((q) => funderScoreboard(q, [pearl, libertas, everest]));
    expect(board[pearl]).toMatchObject({
      submissions: 1,
      approvals: 1,
      declines: 0,
      approvalRate: 1,
      offerCount: 1,
      avgFactor: 1.34,
    });
    expect(board[libertas]).toMatchObject({
      submissions: 1,
      approvals: 0,
      declines: 1,
      approvalRate: 0,
      declinesByReason: [{ reason: "nsfs", count: 1 }],
    });
    expect(board[everest]).toMatchObject({
      submissions: 1,
      pending: 1,
      approvalRate: null,
      avgDaysToRespond: null,
    });
    expect(board[pearl]?.avgDaysToRespond).toBe(0);
  });

  it("removing an offer typed wrong deletes just that offer", async () => {
    const f = await asA((q) => m.saveFunder(q, newFunder({ name: "Typo Capital" })));
    const client = await merchantInStage("Typo Merchant", "application_in");
    await asA((q) => m.sendToFunders(q, s.sendSchema.parse({ clientId: client, funderIds: [f] })));
    const sub = (await asA((q) => getClientFundersData(q, client))).submissions[0]?.id as string;
    const bad = await asA((q) =>
      m.recordOffer(
        q,
        s.offerSchema.parse({ submissionId: sub, amount: "450k", factorRate: "1.34" }),
      ),
    );
    const good = await asA((q) =>
      m.recordOffer(
        q,
        s.offerSchema.parse({ submissionId: sub, amount: "45k", factorRate: "1.34" }),
      ),
    );
    await asA((q) => m.removeOffer(q, bad));
    const left = await t.pool.query("select id from offers where submission_id = $1", [sub]);
    expect(left.rows.map((r) => r.id)).toEqual([good]);
    const err = await asA((q) => m.removeOffer(q, bad)).catch((e) => e);
    expect(toActionError(err)).toBe("That offer no longer exists");
  });

  it("database messages written for Isaac reach him unchanged", async () => {
    const f = await asA((q) => m.saveFunder(q, newFunder({ name: "Dup Msg Capital" })));
    const client = await merchantInStage("Dup Msg Merchant", "application_in");
    await asA((q) => m.sendToFunders(q, s.sendSchema.parse({ clientId: client, funderIds: [f] })));
    const err = await asA((q) =>
      m.sendToFunders(q, s.sendSchema.parse({ clientId: client, funderIds: [f] })),
    ).catch((e) => e);
    expect(toActionError(err)).toMatch(
      /^Already sent to Dup Msg Capital on [A-Z][a-z]{2} \d{1,2}$/,
    );
    await asA((q) => m.setFunderActive(q, f, false));
    const other = await merchantInStage("Archived Msg Merchant", "application_in");
    const err2 = await asA((q) =>
      m.sendToFunders(q, s.sendSchema.parse({ clientId: other, funderIds: [f] })),
    ).catch((e) => e);
    expect(toActionError(err2)).toBe(
      "Dup Msg Capital is archived — restore it on the Funders page first",
    );
  });
});
