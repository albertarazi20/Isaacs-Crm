import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offerToFundingPrefill } from "@/components/funders/prefill";
import { curableText, groupDeclineReasons } from "@/lib/funders/declines";
import {
  checkFit,
  excludedIndustry,
  merchantFacts,
  selectedByDefault,
  type FunderAppetite,
  type MerchantFacts,
} from "@/lib/funders/fit";
import {
  bestOffer,
  isLiveSubmission,
  latestByFunder,
  offerChips,
  offerExtras,
  offerTerms,
  PLAIN_STATUS_ACTIONS,
  SUBMISSION_ACTIONS,
  waitText,
} from "@/lib/funders/offers";
import { groupDue, type DueTimer } from "@/lib/mca/digest";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";
import {
  funderSchema,
  offerSchema,
  sendSchema,
  statusSchema,
  offerStatusSchema,
} from "@/lib/funders/schemas";
import { buildScoreboard, type SubmissionStat } from "@/lib/funders/scoreboard";
import { normalizeState, parseStateList, splitList } from "@/lib/funders/states";
import {
  DECLINE_REASON_LABELS,
  DECLINE_REASONS,
  SUBMISSION_STATUS_LABELS,
  SUBMISSION_STATUSES,
  type DeclineReason,
  type DeclineReasonRow,
  type FunderOfferRow,
  type SubmissionRow,
  type SubmissionStatus,
} from "@/lib/funders/types";

const ID = "00000000-0000-4000-8000-000000000001";

const anyFunder = (over: Partial<FunderAppetite> = {}): FunderAppetite => ({
  name: "Pearl",
  min_monthly_revenue_cents: null,
  min_time_in_business_months: null,
  max_position: null,
  min_amount_cents: null,
  max_amount_cents: null,
  excluded_states: [],
  excluded_industries: [],
  ...over,
});
const merchant = (over: Partial<MerchantFacts> = {}): MerchantFacts => ({
  industry: "Salon",
  state: "NJ",
  monthlyRevenueCents: 8_000_000,
  timeInBusinessMonths: 36,
  nextPosition: 1,
  wantedAmountCents: 5_000_000,
  ...over,
});

describe("fit check", () => {
  it("a funder with no rules fits everyone, even a merchant with nothing filled in", () => {
    expect(checkFit(anyFunder(), merchant())).toEqual({ level: "fits", reasons: [], unknown: [] });
    const blank = merchant({
      industry: "",
      state: "",
      monthlyRevenueCents: null,
      timeInBusinessMonths: null,
      wantedAmountCents: null,
    });
    expect(checkFit(anyFunder(), blank)).toEqual({ level: "fits", reasons: [], unknown: [] });
  });

  describe("position", () => {
    const pearl = anyFunder({ max_position: 2 });
    it("warns when the next position is past what the funder takes", () => {
      const r = checkFit(pearl, merchant({ nextPosition: 3 }));
      expect(r.level).toBe("warn");
      expect(r.reasons).toEqual(["Pearl won't take 3rd position (up to 2nd)"]);
    });
    it("fits at exactly the highest position they take, and below it", () => {
      expect(checkFit(pearl, merchant({ nextPosition: 2 })).level).toBe("fits");
      expect(checkFit(pearl, merchant({ nextPosition: 1 })).level).toBe("fits");
    });
    it("a first-position-only funder refuses a 2nd", () => {
      const r = checkFit(anyFunder({ max_position: 1 }), merchant({ nextPosition: 2 }));
      expect(r.reasons).toEqual(["Pearl won't take 2nd position (up to 1st)"]);
    });
    it("no limit means any position", () => {
      expect(checkFit(anyFunder(), merchant({ nextPosition: 7 })).level).toBe("fits");
    });
  });

  describe("monthly revenue", () => {
    const f = anyFunder({ min_monthly_revenue_cents: 5_000_000 });
    it("says the numbers in the warning", () => {
      const r = checkFit(f, merchant({ monthlyRevenueCents: 3_800_000 }));
      expect(r.reasons).toEqual(["min revenue $50k, merchant has $38k"]);
    });
    it("is inclusive at the minimum and fails one cent under", () => {
      expect(checkFit(f, merchant({ monthlyRevenueCents: 5_000_000 })).level).toBe("fits");
      expect(checkFit(f, merchant({ monthlyRevenueCents: 4_999_999 })).level).toBe("warn");
    });
    it("a merchant with no revenue entered is unknown, not failing", () => {
      const r = checkFit(f, merchant({ monthlyRevenueCents: null }));
      expect(r).toEqual({ level: "check", reasons: [], unknown: ["monthly revenue"] });
      expect(selectedByDefault(r)).toBe(true);
    });
    it("zero revenue is a number, not unknown", () => {
      expect(checkFit(f, merchant({ monthlyRevenueCents: 0 })).level).toBe("warn");
    });
    it("blank revenue does not matter to a funder with no minimum", () => {
      expect(checkFit(anyFunder(), merchant({ monthlyRevenueCents: null })).unknown).toEqual([]);
    });
  });

  describe("time in business", () => {
    const f = anyFunder({ min_time_in_business_months: 24 });
    it("warns under, fits at and over the minimum", () => {
      expect(checkFit(f, merchant({ timeInBusinessMonths: 23 })).reasons).toEqual([
        "min 24 months in business, merchant has 23",
      ]);
      expect(checkFit(f, merchant({ timeInBusinessMonths: 24 })).level).toBe("fits");
      expect(checkFit(f, merchant({ timeInBusinessMonths: 25 })).level).toBe("fits");
    });
    it("is unknown when blank, and a brand-new business (0 months) is a number", () => {
      expect(checkFit(f, merchant({ timeInBusinessMonths: null })).unknown).toEqual([
        "time in business",
      ]);
      expect(checkFit(f, merchant({ timeInBusinessMonths: 0 })).level).toBe("warn");
    });
  });

  describe("states", () => {
    const f = anyFunder({ excluded_states: ["FL", "NY"] });
    it("matches the code in any case and the full name", () => {
      for (const state of ["FL", "fl", " Fl ", "Florida", "florida", "NEW YORK", "N.Y."]) {
        const r = checkFit(f, merchant({ state }));
        expect(r.level, state).toBe("warn");
      }
      expect(checkFit(f, merchant({ state: "Florida" })).reasons).toEqual(["excludes FL"]);
    });
    it("fits a state that is not excluded", () => {
      expect(checkFit(f, merchant({ state: "NJ" })).level).toBe("fits");
      expect(checkFit(f, merchant({ state: "New Jersey" })).level).toBe("fits");
    });
    it("blank or unreadable states are unknown, never a failure", () => {
      expect(checkFit(f, merchant({ state: "" })).unknown).toEqual(["state"]);
      expect(checkFit(f, merchant({ state: "   " })).unknown).toEqual(["state"]);
      expect(checkFit(f, merchant({ state: "Fla" })).unknown).toEqual(["state"]);
      expect(checkFit(f, merchant({ state: "Fla" })).reasons).toEqual([]);
    });
    it("a funder with no state rules does not care about a blank state", () => {
      expect(checkFit(anyFunder(), merchant({ state: "" })).unknown).toEqual([]);
    });
  });

  describe("industries", () => {
    const f = anyFunder({ excluded_industries: ["restaurants", "Trucking", "fast food"] });
    it("matches regardless of case, plural and punctuation", () => {
      for (const industry of [
        "Restaurant",
        "restaurants",
        "RESTAURANT",
        "Restaurant / Pizzeria",
        "Bar & Restaurant",
        "trucking",
        "Long-haul Trucking Co.",
        "Fast Food Franchise",
      ]) {
        expect(checkFit(f, merchant({ industry })).level, industry).toBe("warn");
      }
      expect(checkFit(f, merchant({ industry: "Restaurant" })).reasons).toEqual([
        "excludes restaurants",
      ]);
    });
    it("matches whole words only", () => {
      expect(excludedIndustry("Automotive", ["auto"])).toBeNull();
      expect(excludedIndustry("Auto repair", ["auto"])).toBe("auto");
      expect(excludedIndustry("Carpet cleaning", ["car"])).toBeNull();
      expect(excludedIndustry("Food truck", ["fast food"])).toBeNull();
      expect(excludedIndustry("Business services", ["bus"])).toBeNull();
    });
    it("fits an industry that is not excluded and is unknown when blank", () => {
      expect(checkFit(f, merchant({ industry: "Hair salon" })).level).toBe("fits");
      expect(checkFit(f, merchant({ industry: "" })).unknown).toEqual(["industry"]);
      expect(checkFit(f, merchant({ industry: "  " })).level).toBe("check");
    });
  });

  describe("advance size", () => {
    const f = anyFunder({ min_amount_cents: 2_000_000, max_amount_cents: 10_000_000 });
    it("is inclusive at both ends", () => {
      expect(checkFit(f, merchant({ wantedAmountCents: 2_000_000 })).level).toBe("fits");
      expect(checkFit(f, merchant({ wantedAmountCents: 10_000_000 })).level).toBe("fits");
    });
    it("warns under the minimum and over the maximum", () => {
      expect(checkFit(f, merchant({ wantedAmountCents: 1_000_000 })).reasons).toEqual([
        "min advance $20k, merchant wants $10k",
      ]);
      expect(checkFit(f, merchant({ wantedAmountCents: 15_000_000 })).reasons).toEqual([
        "tops out at $100k, merchant wants $150k",
      ]);
    });
    it("unknown when no amount is wanted yet", () => {
      expect(checkFit(f, merchant({ wantedAmountCents: null })).unknown).toEqual(["amount wanted"]);
    });
    it("a funder with only a maximum ignores a small ask", () => {
      expect(
        checkFit(anyFunder({ max_amount_cents: 10_000_000 }), merchant({ wantedAmountCents: 1 }))
          .level,
      ).toBe("fits");
    });
  });

  it("collects every reason, and a known failure outranks an unknown field", () => {
    const f = anyFunder({
      max_position: 1,
      min_monthly_revenue_cents: 5_000_000,
      min_time_in_business_months: 12,
      excluded_states: ["CA"],
    });
    const r = checkFit(
      f,
      merchant({
        nextPosition: 2,
        monthlyRevenueCents: 3_000_000,
        timeInBusinessMonths: null,
        state: "CA",
      }),
    );
    expect(r.level).toBe("warn");
    expect(r.reasons).toHaveLength(3);
    expect(r.unknown).toEqual(["time in business"]);
    expect(selectedByDefault(r)).toBe(false);
  });

  it("reads the merchant's facts off the client card: next position is advances already on the business + 1", () => {
    expect(
      merchantFacts({
        industry: "Salon",
        state: "NJ",
        monthly_revenue_cents: 1,
        time_in_business_months: 2,
        position_count: 2,
        wanted_amount_cents: null,
      }),
    ).toEqual({
      industry: "Salon",
      state: "NJ",
      monthlyRevenueCents: 1,
      timeInBusinessMonths: 2,
      nextPosition: 3,
      wantedAmountCents: null,
    });
  });
});

describe("states", () => {
  it("normalises codes and names, and refuses what it cannot read", () => {
    expect(normalizeState("fl")).toBe("FL");
    expect(normalizeState(" new york ")).toBe("NY");
    expect(normalizeState("N.Y.")).toBe("NY");
    expect(normalizeState("Washington DC")).toBe("DC");
    expect(normalizeState("District of Columbia")).toBe("DC");
    expect(normalizeState("")).toBeNull();
    expect(normalizeState("Fla")).toBeNull();
    expect(normalizeState("XX")).toBeNull();
  });
  it("parses a typed list, drops repeats and reports what it could not read", () => {
    expect(parseStateList("FL, ny\nTexas; fl")).toEqual({
      states: ["FL", "NY", "TX"],
      unknown: [],
    });
    expect(parseStateList("FL, Narnia")).toEqual({ states: ["FL"], unknown: ["Narnia"] });
    expect(parseStateList("")).toEqual({ states: [], unknown: [] });
    expect(splitList(" a, A ,b,, ")).toEqual(["a", "b"]);
  });
});

describe("scoreboard", () => {
  const sub = (over: Partial<SubmissionStat> & Pick<SubmissionStat, "status">): SubmissionStat => ({
    funder_id: "p",
    decline_reason: null,
    sent_on: "2026-10-01",
    responded_on: null,
    ...over,
  });

  it("counts submissions, approvals and declines, and the approval rate is of decisions only", () => {
    const rows = buildScoreboard(
      ["p"],
      [
        sub({ status: "approved", responded_on: "2026-10-02" }),
        sub({ status: "approved", responded_on: "2026-10-03" }),
        sub({ status: "declined", decline_reason: "credit", responded_on: "2026-10-02" }),
        sub({ status: "sent" }),
        sub({ status: "stips_requested", responded_on: "2026-10-02" }),
        sub({ status: "no_response" }),
        sub({ status: "withdrawn" }),
      ],
      [],
    );
    expect(rows.p).toMatchObject({
      submissions: 7,
      approvals: 2,
      declines: 1,
      pending: 2,
      noResponse: 1,
      withdrawn: 1,
    });
    expect(rows.p?.approvalRate).toBeCloseTo(2 / 3, 10);
  });

  it("no decision yet means no rate, not 0%", () => {
    const rows = buildScoreboard(
      ["p"],
      [sub({ status: "sent" }), sub({ status: "no_response" })],
      [],
    );
    expect(rows.p?.approvalRate).toBeNull();
    expect(rows.p?.avgDaysToRespond).toBeNull();
  });

  it("a funder with all declines has a 0% rate", () => {
    const rows = buildScoreboard(["p"], [sub({ status: "declined", decline_reason: "nsfs" })], []);
    expect(rows.p?.approvalRate).toBe(0);
  });

  it("counts declines by reason, most common first, with unspecified last-resort", () => {
    const rows = buildScoreboard(
      ["p"],
      [
        sub({ status: "declined", decline_reason: "credit" }),
        sub({ status: "declined", decline_reason: "revenue" }),
        sub({ status: "declined", decline_reason: "revenue" }),
        sub({ status: "declined", decline_reason: "nsfs" }),
        sub({ status: "declined", decline_reason: null }),
      ],
      [],
    );
    expect(rows.p?.declinesByReason).toEqual([
      { reason: "revenue", count: 2 },
      { reason: "nsfs", count: 1 },
      { reason: "credit", count: 1 },
      { reason: "unspecified", count: 1 },
    ]);
  });

  it("averages the factor of every offer they made, to three decimals", () => {
    const rows = buildScoreboard(
      ["p", "l"],
      [],
      [
        { funder_id: "p", factor_rate: 1.34 },
        { funder_id: "p", factor_rate: 1.31 },
        { funder_id: "p", factor_rate: 1.4 },
        { funder_id: "l", factor_rate: 1.29 },
      ],
    );
    expect(rows.p).toMatchObject({ offerCount: 3, avgFactor: 1.35 });
    expect(rows.l).toMatchObject({ offerCount: 1, avgFactor: 1.29 });
  });

  it("averages days to respond over the submissions they answered", () => {
    const rows = buildScoreboard(
      ["p"],
      [
        sub({ status: "approved", sent_on: "2026-10-01", responded_on: "2026-10-02" }),
        sub({ status: "declined", sent_on: "2026-10-01", responded_on: "2026-10-04" }),
        sub({ status: "approved", sent_on: "2026-10-05", responded_on: "2026-10-05" }),
        sub({ status: "sent", sent_on: "2026-10-01" }),
      ],
      [],
    );
    expect(rows.p?.avgDaysToRespond).toBe(1.3);
  });

  it("an answer dated before the send (clock slack) counts as same-day, not negative", () => {
    const rows = buildScoreboard(
      ["p"],
      [sub({ status: "approved", sent_on: "2026-10-05", responded_on: "2026-10-04" })],
      [],
    );
    expect(rows.p?.avgDaysToRespond).toBe(0);
  });

  it("gives a funder with no history a zeroed row, and ignores rows for funders it wasn't asked about", () => {
    const rows = buildScoreboard(
      ["p", "new"],
      [sub({ funder_id: "someone-else", status: "approved" })],
      [{ funder_id: "someone-else", factor_rate: 1.2 }],
    );
    expect(Object.keys(rows).sort()).toEqual(["new", "p"]);
    expect(rows.new).toMatchObject({ submissions: 0, approvals: 0, avgFactor: null });
    expect(rows.p?.submissions).toBe(0);
  });
});

describe("offers", () => {
  const offer = (over: Partial<FunderOfferRow> & Pick<FunderOfferRow, "id">): FunderOfferRow => ({
    submission_id: "s",
    client_id: "c",
    amount_cents: 4_500_000,
    factor_rate: 1.34,
    payment_cents: 45_000,
    frequency: "daily",
    term_days: null,
    position_no: null,
    fees_cents: null,
    note: "",
    received_on: "2026-10-23",
    status: "open",
    ...over,
  });
  const submission = (name: string, offers: FunderOfferRow[]): SubmissionRow => ({
    id: `s-${name}`,
    client_id: "c",
    funder_id: name,
    funder_name: name,
    sent_on: "2026-10-22",
    status: "approved",
    decline_reason: null,
    decline_note: "",
    note: "",
    status_changed_at: "2026-10-23T10:00:00Z",
    responded_on: "2026-10-23",
    chase_due_on: null,
    offers,
  });

  it("the best offer has the lowest factor; a tie goes to the bigger advance", () => {
    const a = offer({ id: "a", factor_rate: 1.34 });
    const b = offer({ id: "b", factor_rate: 1.31, amount_cents: 4_000_000 });
    const c = offer({ id: "c", factor_rate: 1.31, amount_cents: 4_200_000 });
    expect(bestOffer([a, b, c])?.id).toBe("c");
    expect(bestOffer([])).toBeNull();
  });

  it("builds the 'offers in' line best first, with the best one flagged", () => {
    const chips = offerChips([
      submission("Pearl", [offer({ id: "p" })]),
      submission("Libertas", [offer({ id: "l", factor_rate: 1.31, amount_cents: 4_000_000 })]),
    ]);
    expect(chips).toEqual([
      { offerId: "l", funderName: "Libertas", text: "1.31 / $40k daily", best: true },
      { offerId: "p", funderName: "Pearl", text: "1.34 / $45k daily", best: false },
    ]);
  });

  it("leaves out turned-down and expired offers, keeps accepted, and flags nothing when there's nothing to compare", () => {
    const chips = offerChips([
      submission("Pearl", [offer({ id: "p" })]),
      submission("Libertas", [offer({ id: "l", status: "declined" })]),
      submission("Everest", [offer({ id: "e", status: "expired" })]),
    ]);
    expect(chips).toEqual([
      { offerId: "p", funderName: "Pearl", text: "1.34 / $45k daily", best: false },
    ]);
    const accepted = offerChips([
      submission("Pearl", [offer({ id: "p", status: "accepted", frequency: null })]),
    ]);
    expect(accepted[0]?.text).toBe("1.34 / $45k");
    expect(offerChips([])).toEqual([]);
  });

  it("every submission status has actions (funded is the end: a chip only), and none lists an action that makes no sense there", () => {
    for (const s of SUBMISSION_STATUSES)
      if (s === "funded") expect(SUBMISSION_ACTIONS[s]).toEqual([]);
      else expect(SUBMISSION_ACTIONS[s].length).toBeGreaterThan(0);
    const has = (s: SubmissionStatus, a: string) =>
      (SUBMISSION_ACTIONS[s] as readonly string[]).includes(a);
    expect(has("sent", "approved")).toBe(true);
    expect(has("sent", "reopen")).toBe(false);
    expect(has("approved", "add_offer")).toBe(true);
    expect(has("stips_requested", "stips_sent")).toBe(true);
    expect(has("withdrawn", "reopen")).toBe(true);
  });

  it("an accepted offer pre-fills the Funded dialog: amount, factor, remittance, frequency, term, funder, position", () => {
    const p = offerToFundingPrefill(
      offer({
        id: "x",
        frequency: "weekly",
        term_days: 120,
        position_no: 2,
        payment_cents: 125_050,
      }),
      "Pearl",
      { commission_points: 8 },
      3,
    );
    expect(p).toEqual({
      amount: "45000",
      factorRate: "1.34",
      payment: "1250.50",
      frequency: "weekly",
      funderName: "Pearl",
      positionNo: "2",
      termDays: "120",
      commission: "3600",
    });
  });

  it("without term, position, frequency or commission points the pre-fill stays modest", () => {
    const p = offerToFundingPrefill(
      offer({ id: "x", frequency: null, payment_cents: null }),
      "Libertas",
      { commission_points: null },
      3,
    );
    expect(p).toEqual({
      amount: "45000",
      factorRate: "1.34",
      payment: "",
      funderName: "Libertas",
      positionNo: "3",
      termDays: "",
    });
  });
});

describe("input schemas", () => {
  const base = { name: "Pearl Capital" };

  it("reads money the way Isaac types it and lists the way he types them", () => {
    const f = funderSchema.parse({
      ...base,
      minMonthlyRevenue: "50k",
      minAmount: "$10,000",
      maxAmount: "1.5m",
      minTimeInBusinessMonths: "24",
      maxPosition: "2",
      excludedStates: "fl, New York",
      excludedIndustries: "Restaurants,\nTrucking, restaurants",
      commissionPoints: "10%",
      renewalPaydownPct: "60",
      submissionEmail: "subs@pearl.example",
    });
    expect(f).toMatchObject({
      name: "Pearl Capital",
      minMonthlyRevenue: 5_000_000,
      minAmount: 1_000_000,
      maxAmount: 150_000_000,
      minTimeInBusinessMonths: 24,
      maxPosition: 2,
      excludedStates: ["FL", "NY"],
      excludedIndustries: ["Restaurants", "Trucking"],
      commissionPoints: 10,
      renewalPaydownPct: 60,
    });
  });

  it("blank appetite fields mean 'no limit'", () => {
    const f = funderSchema.parse({
      ...base,
      minMonthlyRevenue: "",
      maxPosition: "  ",
      commissionPoints: "",
    });
    expect(f).toMatchObject({
      minMonthlyRevenue: null,
      maxPosition: null,
      commissionPoints: null,
      excludedStates: [],
      excludedIndustries: [],
    });
  });

  it("says what is wrong in plain words", () => {
    const msg = (v: unknown) => {
      const r = funderSchema.safeParse(v);
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(msg({ name: " " })).toBe("Give the funder a name");
    expect(msg({ ...base, minMonthlyRevenue: "lots" })).toBe("Enter an amount like 50k or $75,000");
    expect(msg({ ...base, excludedStates: "FL, Narnia" })).toBe(
      `"Narnia" isn't a state — use two-letter codes like FL, NY`,
    );
    expect(msg({ ...base, maxPosition: "0" })).toBe("Position must be a whole number from 1 to 20");
    expect(msg({ ...base, commissionPoints: "150" })).toBe(
      "Commission points must be a number from 0 to 100, like 10",
    );
    expect(msg({ ...base, minAmount: "100k", maxAmount: "50k" })).toBe(
      "The smallest advance can't be bigger than the largest",
    );
    expect(msg({ ...base, submissionEmail: "a@b.com, c@d.com" })).toBe(
      "Enter one valid email address",
    );
  });

  it("refuses an SSN, a card number or a bank account in the free-text fields", () => {
    expect(funderSchema.safeParse({ ...base, notes: "owner SSN 123-45-6789" }).success).toBe(false);
    expect(funderSchema.safeParse({ ...base, notes: "card 4242 4242 4242 4242" }).success).toBe(
      false,
    );
    expect(funderSchema.safeParse({ ...base, notes: "acct 123456789" }).success).toBe(false);
    expect(
      funderSchema.safeParse({ ...base, notes: "Fast, pays well. Ask for Dana." }).success,
    ).toBe(true);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      statusSchema.safeParse({
        submissionId: id,
        status: "stips_requested",
        note: "SSN 123-45-6789",
      }).success,
    ).toBe(false);
    expect(
      offerSchema.safeParse({
        submissionId: id,
        amount: "45k",
        factorRate: "1.34",
        note: "routing number 021000021",
      }).success,
    ).toBe(false);
    expect(
      sendSchema.safeParse({ clientId: id, funderIds: [id], note: "ssn 123 45 6789" }).success,
    ).toBe(false);
  });

  describe("offers", () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    it("needs an amount and a factor between 1 and 3; the rest is optional", () => {
      const ok = offerSchema.parse({ submissionId: sid, amount: "45k", factorRate: "1.34" });
      expect(ok).toMatchObject({ amount: 4_500_000, factorRate: 1.34, payment: null, fees: null });
      expect(
        offerSchema.safeParse({ submissionId: sid, amount: "", factorRate: "1.34" }).success,
      ).toBe(false);
      expect(
        offerSchema.safeParse({ submissionId: sid, amount: "45k", factorRate: "0.9" }).success,
      ).toBe(false);
      expect(
        offerSchema.safeParse({ submissionId: sid, amount: "45k", factorRate: "3.5" }).success,
      ).toBe(false);
      expect(
        offerSchema.safeParse({ submissionId: sid, amount: "0", factorRate: "1.3" }).success,
      ).toBe(false);
    });
    it("a remittance needs a frequency and can't exceed the whole payback", () => {
      const r1 = offerSchema.safeParse({
        submissionId: sid,
        amount: "45k",
        factorRate: "1.34",
        payment: "450",
      });
      expect(r1.success ? null : r1.error.issues[0]?.message).toBe(
        "Say how often the remittance is debited",
      );
      const r2 = offerSchema.safeParse({
        submissionId: sid,
        amount: "10k",
        factorRate: "1.3",
        payment: "20k",
        frequency: "daily",
      });
      expect(r2.success ? null : r2.error.issues[0]?.message).toBe(
        "One remittance can't be more than the whole payback",
      );
      expect(
        offerSchema.safeParse({
          submissionId: sid,
          amount: "45k",
          factorRate: "1.34",
          payment: "450",
          frequency: "daily",
          termDays: "130",
          positionNo: "2",
          fees: "500",
        }).success,
      ).toBe(true);
    });
  });

  it("a decline needs a reason and a reason needs a decline", () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    const r = statusSchema.safeParse({ submissionId: sid, status: "declined" });
    expect(r.success ? null : r.error.issues[0]?.message).toBe("Pick why they declined");
    expect(
      statusSchema.safeParse({ submissionId: sid, status: "declined", declineReason: "credit" })
        .success,
    ).toBe(true);
    expect(
      statusSchema.safeParse({ submissionId: sid, status: "approved", declineReason: "credit" })
        .success,
    ).toBe(false);
    expect(statusSchema.safeParse({ submissionId: sid, status: "sent" }).success).toBe(true);
    expect(statusSchema.safeParse({ submissionId: sid, status: "maybe" }).success).toBe(false);
  });

  it("send needs at least one funder; offers are accepted only through Accept", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(sendSchema.safeParse({ clientId: id, funderIds: [] }).success).toBe(false);
    expect(sendSchema.safeParse({ clientId: id, funderIds: ["nope"] }).success).toBe(false);
    expect(sendSchema.safeParse({ clientId: id, funderIds: [id] }).success).toBe(true);
    expect(offerStatusSchema.safeParse({ offerId: id, status: "accepted" }).success).toBe(false);
    expect(offerStatusSchema.safeParse({ offerId: id, status: "presented" }).success).toBe(true);
  });
});

describe("submission row text", () => {
  const sub = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
    id: "s",
    client_id: "c",
    funder_id: "f",
    funder_name: "Pearl",
    sent_on: "2026-10-20",
    status: "sent",
    decline_reason: null,
    decline_note: "",
    note: "",
    status_changed_at: "2026-10-20T10:00:00Z",
    responded_on: null,
    chase_due_on: null,
    offers: [],
    ...over,
  });

  it("says how long a funder has had it, or how fast they answered", () => {
    expect(waitText(sub(), "2026-10-23")).toBe("Waiting 3 days");
    expect(waitText(sub({ sent_on: "2026-10-22" }), "2026-10-23")).toBe("Waiting 1 day");
    expect(waitText(sub({ sent_on: "2026-10-23" }), "2026-10-23")).toBe("Sent today");
    expect(
      waitText(sub({ status: "stips_requested", responded_on: "2026-10-22" }), "2026-10-23"),
    ).toBe("Answered in 2 days");
    expect(waitText(sub({ status: "approved", responded_on: "2026-10-21" }), "2026-10-23")).toBe(
      "Answered in 1 day",
    );
    expect(waitText(sub({ status: "declined", responded_on: "2026-10-20" }), "2026-10-23")).toBe(
      "Answered the same day",
    );
    expect(waitText(sub({ status: "no_response" }), "2026-10-23")).toBe("");
    expect(waitText(sub({ status: "withdrawn" }), "2026-10-23")).toBe("");
  });

  it("writes offer terms in MCA words: factor, payback, remittance and frequency", () => {
    const o = {
      amount_cents: 4_500_000,
      factor_rate: 1.34,
      payment_cents: 45_000,
      frequency: "daily" as const,
    };
    expect(offerTerms(o, formatMoney)).toBe(
      "$45,000 at 1.34 factor · payback $60,300 · $450 daily",
    );
    expect(offerTerms({ ...o, payment_cents: null, frequency: null }, formatMoney)).toBe(
      "$45,000 at 1.34 factor · payback $60,300",
    );
    expect(offerTerms({ ...o, frequency: "biweekly" }, formatMoney)).toContain(
      "$450 every 2 weeks",
    );
    expect(offerExtras({ position_no: 2, term_days: 130, fees_cents: 50_000 }, formatMoney)).toBe(
      "2nd position · 130-day term · $500 fees",
    );
    expect(offerExtras({ position_no: null, term_days: null, fees_cents: null }, formatMoney)).toBe(
      "",
    );
  });

  it("finds the newest submission per funder and which are still in play", () => {
    const rows = [
      sub({ id: "old", funder_id: "a", sent_on: "2026-10-01", status: "declined" }),
      sub({ id: "new", funder_id: "a", sent_on: "2026-10-15", status: "sent" }),
      sub({ id: "b1", funder_id: "b", sent_on: "2026-10-10", status: "withdrawn" }),
    ];
    const latest = latestByFunder(rows);
    expect(latest.get("a")?.id).toBe("new");
    expect(latest.get("b")?.id).toBe("b1");
    expect(isLiveSubmission(sub({ status: "sent" }))).toBe(true);
    expect(isLiveSubmission(sub({ status: "stips_requested" }))).toBe(true);
    expect(isLiveSubmission(sub({ status: "approved" }))).toBe(true);
    for (const status of ["declined", "no_response", "withdrawn"] as const)
      expect(isLiveSubmission(sub({ status })), status).toBe(false);
  });
});

describe("the chase timer in the morning digest", () => {
  const timer = (over: Partial<DueTimer>): DueTimer => ({
    timerId: "t",
    clientId: "c1",
    businessName: "Mike's Pizza",
    contactName: "Mike",
    phone: "5551234567",
    stage: "submitted",
    kind: "follow_up",
    dueOn: "2026-10-23",
    note: "",
    ...over,
  });
  it("is labelled 'Chase funder' and wins over a plain follow-up on the same day, one line per merchant", () => {
    expect(TIMER_LABELS.chase).toBe("Chase funder");
    const { dueToday } = groupDue(
      [
        timer({ timerId: "a", kind: "follow_up" }),
        timer({ timerId: "b", kind: "chase", note: "Ask Pearl for a decision" }),
      ],
      "2026-10-23",
    );
    expect(dueToday).toHaveLength(1);
    expect(dueToday[0]?.kind).toBe("chase");
  });
  it("never outranks a booked call or a renewal call", () => {
    const { dueToday } = groupDue(
      [timer({ timerId: "a", kind: "chase" }), timer({ timerId: "b", kind: "scheduled_call" })],
      "2026-10-23",
    );
    expect(dueToday[0]?.kind).toBe("scheduled_call");
    const renewal = groupDue(
      [timer({ timerId: "a", kind: "chase" }), timer({ timerId: "b", kind: "renewal" })],
      "2026-10-23",
    );
    expect(renewal.dueToday[0]?.kind).toBe("renewal");
  });
});

describe("the lender statuses and decline reasons match db/migrations/0300_deals.sql (P2-47, P2-43)", () => {
  const sql = readFileSync(join(process.cwd(), "db", "migrations", "0300_deals.sql"), "utf8");
  const quoted = (block: string) => [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  it("every status the check constraint allows has a chip label and an action list", () => {
    const m = sql.match(
      /add constraint submissions_status_check check \(status in \(([\s\S]*?)\)\);/,
    );
    expect(m).not.toBeNull();
    const dbStatuses = quoted(m![1]!);
    expect(dbStatuses.length).toBe(12);
    expect([...SUBMISSION_STATUSES].sort()).toEqual([...dbStatuses].sort());
    for (const s of dbStatuses) {
      expect(SUBMISSION_STATUS_LABELS[s as SubmissionStatus]).toBeTruthy();
      expect(Array.isArray(SUBMISSION_ACTIONS[s as SubmissionStatus])).toBe(true);
    }
    // funded is the end of the line; expired can go back to waiting
    expect(SUBMISSION_ACTIONS.funded).toEqual([]);
    expect(SUBMISSION_ACTIONS.expired).toEqual(["reopen"]);
    // the plain status changes write a status the database accepts
    for (const status of Object.values(PLAIN_STATUS_ACTIONS)) expect(dbStatuses).toContain(status);
    expect(statusSchema.safeParse({ submissionId: ID, status: "contracts_out" }).success).toBe(
      true,
    );
    expect(statusSchema.safeParse({ submissionId: ID, status: "funded" }).success).toBe(true);
  });

  it("the typed decline list is exactly the table's seed, and the pick-list groups it by category", () => {
    const m = sql.match(
      /insert into decline_reasons \(key, label, category, curable_after_days, sort\) values([\s\S]*?);/,
    );
    expect(m).not.toBeNull();
    const rows: DeclineReasonRow[] = [
      ...m![1]!.matchAll(/\('([a-z_]+)', '([^']+)', '([a-z_]+)', (\d+|null), (\d+)\)/g),
    ].map((r) => ({
      key: r[1]!,
      label: r[2]!,
      category: r[3] as DeclineReasonRow["category"],
      curable_after_days: r[4] === "null" ? null : Number(r[4]),
      sort: Number(r[5]),
    }));
    expect(rows.length).toBe(19);
    expect([...DECLINE_REASONS].sort()).toEqual(rows.map((r) => r.key).sort());
    for (const r of rows) expect(DECLINE_REASON_LABELS[r.key as DeclineReason]).toBe(r.label);
    // the constraint on submissions.decline_reason allows the same keys
    const c = sql.match(
      /add constraint submissions_decline_reason_check check \(decline_reason is null or decline_reason in \(([\s\S]*?)\)\);/,
    );
    expect(quoted(c![1]!).sort()).toEqual(rows.map((r) => r.key).sort());
    // a new-taxonomy reason passes the action's schema
    expect(
      statusSchema.safeParse({ submissionId: ID, status: "declined", declineReason: "failed_bv" })
        .success,
    ).toBe(true);

    const groups = groupDeclineReasons(rows);
    expect(groups.map((g) => g.category)).toEqual([
      "bank_health",
      "debt_load",
      "profile",
      "credit",
      "file",
      "history",
      "other",
    ]);
    expect(groups[0]?.label).toBe("Bank health");
    expect(groups[0]?.reasons.map((r) => r.key)).toEqual([
      "revenue",
      "falling_revenue",
      "low_balances",
      "negative_days",
      "nsfs",
    ]);
    expect(groups.flatMap((g) => g.reasons)).toHaveLength(19);
    expect(curableText(rows.find((r) => r.key === "nsfs"))).toBe(
      "Winback can try this merchant again after 60 days",
    );
    expect(curableText(rows.find((r) => r.key === "industry"))).toMatch(
      /^Not something time fixes/,
    );
    expect(curableText(undefined)).toBe("");
  });
});
