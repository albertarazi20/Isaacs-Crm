import { describe, expect, it } from "vitest";
import {
  agoShort,
  bucketDueDate,
  bucketOf,
  cardPaydown,
  compareCards,
  filterCards,
  groupByBucket,
  groupByStage,
  isDropBucket,
  isOverdue,
  lastContact,
  matchesQuery,
  mergeServerCards,
  optimisticDue,
  optimisticMove,
  parseView,
  positionsText,
  replaceCard,
  revertCard,
  sameCard,
  sameCards,
  summarize,
  timerText,
} from "@/components/board/logic";
import {
  centsToInput,
  checkCompetitor,
  checkDefault,
  checkFunding,
  clampToToday,
  competitorCallback,
  defaultFollowUp,
  fundingPreview,
  callTimeProblem,
  needsInput,
  undoInput,
  type FundingForm,
} from "@/components/stage-move/forms";
import type { ClientCard } from "@/lib/data/types";
import { addBusinessDays, addDays, addMonths, BUCKET_ORDER } from "@/lib/mca/dates";
import { foldStage, STAGE_KEYS, stageDef } from "@/lib/mca/stages";

// 2026-10-23 is a Friday.
const TODAY = "2026-10-23";

let seq = 0;
function card(over: Partial<ClientCard> = {}): ClientCard {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    business_name: `Merchant ${seq}`,
    dba: "",
    contact_name: "",
    phone: "",
    email: "",
    industry: "",
    state: "",
    source: "",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "name_in",
    stage_changed_at: "2026-10-01T12:00:00+00:00",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-10-01T12:00:00+00:00",
    next_due_on: TODAY,
    next_due_kind: "follow_up",
    last_call_at: null,
    last_touch_at: null,
    last_call_note: null,
    wanted_amount_cents: null,
    wanted_terms: null,
    est_approval_cents: null,
    est_approval_note: null,
    position_count: 0,
    position_balance_cents: 0,
    stips_required: 0,
    stips_received: 0,
    funding_id: null,
    funded_on: null,
    funding_amount_cents: null,
    factor_rate: null,
    funding_payback_cents: null,
    funding_payment_cents: null,
    funding_frequency: null,
    paid_back_override_cents: null,
    funding_status: null,
    defaulted_on: null,
    last_payment_on: null,
    promise_to_pay_at: null,
    promise_amount_cents: null,
    ...over,
  };
}

/** One card per stage, with due dates spread from long overdue to far out. */
function everyStage(): ClientCard[] {
  return STAGE_KEYS.map((stage, i) => card({ stage, next_due_on: addDays(TODAY, i * 17 - 20) }));
}

describe("view param", () => {
  it("defaults to the pipeline and only honours followups", () => {
    expect(parseView(undefined)).toBe("pipeline");
    expect(parseView("nonsense")).toBe("pipeline");
    expect(parseView(["followups", "x"])).toBe("pipeline");
    expect(parseView("followups")).toBe("followups");
  });
});

describe("grouping", () => {
  it("puts every card in exactly one stage column, and every stage has a column", () => {
    const cards = [...everyStage(), ...everyStage(), card({ stage: "interested" })];
    const groups = groupByStage(cards);
    expect(Object.keys(groups).sort()).toEqual([...STAGE_KEYS].sort());
    const ids = Object.values(groups).flatMap((g) => g.map((c) => c.id));
    expect(ids).toHaveLength(cards.length);
    expect(new Set(ids).size).toBe(cards.length);
    // A retired stage's merchants sit in the stage it folds into.
    for (const key of STAGE_KEYS) for (const c of groups[key]) expect(foldStage(c.stage)).toBe(key);
  });

  it("puts every card in exactly one follow-up column", () => {
    const cards = [
      ...everyStage(),
      card({ next_due_on: null }),
      card({ next_due_on: addMonths(TODAY, 40) }),
    ];
    const groups = groupByBucket(cards, TODAY);
    expect(Object.keys(groups).sort()).toEqual([...BUCKET_ORDER].sort());
    const ids = Object.values(groups).flatMap((g) => g.map((c) => c.id));
    expect(ids).toHaveLength(cards.length);
    expect(new Set(ids).size).toBe(cards.length);
  });

  it("sorts each column most urgent first, a missing date before everything", () => {
    const late = card({ stage: "interested", next_due_on: "2026-10-20", business_name: "B" });
    const soon = card({ stage: "interested", next_due_on: "2026-10-25", business_name: "A" });
    const none = card({ stage: "interested", next_due_on: null, business_name: "Z" });
    const tieB = card({ stage: "interested", next_due_on: "2026-10-25", business_name: "b" });
    expect(groupByStage([soon, tieB, none, late]).interested.map((c) => c.id)).toEqual([
      none.id,
      late.id,
      soon.id,
      tieB.id,
    ]);
    expect(compareCards(soon, soon)).toBe(0);
  });

  it("places bucket edge cases where Isaac expects them", () => {
    const at = (due: string | null) => bucketOf(card({ next_due_on: due }), TODAY);
    expect(at("2026-10-22")).toBe("overdue");
    expect(at(null)).toBe("overdue");
    expect(at(TODAY)).toBe("today");
    expect(at(addDays(TODAY, 1))).toBe("1w");
    expect(at(addDays(TODAY, 7))).toBe("1w");
    expect(at(addDays(TODAY, 8))).toBe("2w");
    expect(at(addMonths(TODAY, 8))).toBe("9m");
    expect(at(addMonths(TODAY, 9))).toBe("9m");
    expect(at(addMonths(TODAY, 10))).toBe("12m");
    expect(at(addMonths(TODAY, 15))).toBe("18m");
    expect(at(addMonths(TODAY, 36))).toBe("36m");
    expect(at(addDays(addMonths(TODAY, 36), 1))).toBe("later");
  });

  it("only offers real dates as drop targets", () => {
    expect(isDropBucket("overdue")).toBe(false);
    expect(isDropBucket("later")).toBe(false);
    for (const b of BUCKET_ORDER.filter((k) => k !== "overdue" && k !== "later"))
      expect(isDropBucket(b)).toBe(true);
  });

  it("turns a drop bucket into the date the server will set", () => {
    expect(bucketDueDate("today", TODAY)).toBe(TODAY);
    expect(bucketDueDate("1w", TODAY)).toBe("2026-10-30");
    expect(bucketDueDate("1m", TODAY)).toBe("2026-11-23");
    expect(bucketDueDate("3m", TODAY)).toBe("2027-01-23");
    expect(bucketDueDate("36m", TODAY)).toBe("2029-10-23");
    for (const b of BUCKET_ORDER) {
      if (isDropBucket(b))
        expect(bucketOf(card({ next_due_on: bucketDueDate(b, TODAY) }), TODAY)).toBe(b);
    }
  });
});

describe("search", () => {
  const rivera = card({
    business_name: "Rivera Auto Repair",
    dba: "Rivera Motors",
    contact_name: "Tony Rivera",
    phone: "(305) 555-0121",
  });
  const hit = (q: string) => matchesQuery(rivera, q);

  it("matches business, DBA and merchant name, ignoring case", () => {
    expect(hit("rivera")).toBe(true);
    expect(hit("AUTO")).toBe(true);
    expect(hit("motors")).toBe(true);
    expect(hit("tony")).toBe(true);
    expect(hit("kia")).toBe(false);
  });

  it("matches the phone by its digits, however it was typed", () => {
    expect(hit("555-0121")).toBe(true);
    expect(hit("(305) 555")).toBe(true);
    expect(hit("3055550121")).toBe(true);
    expect(hit("5550999")).toBe(false);
  });

  it("needs every word to match, and ignores tiny digit runs", () => {
    expect(hit("rivera 0121")).toBe(true);
    expect(hit("rivera zzz")).toBe(false);
    expect(hit("12")).toBe(false);
  });

  it("shows everything for a blank search", () => {
    expect(hit("")).toBe(true);
    expect(hit("   ")).toBe(true);
  });

  it("copes with a merchant who has no phone", () => {
    expect(matchesQuery(card({ business_name: "No Phone Co" }), "555")).toBe(false);
  });
});

describe("filters", () => {
  const yesterday = card({ next_due_on: "2026-10-22" });
  const today = card({ next_due_on: TODAY });
  const later = card({ next_due_on: "2026-12-01" });
  const nodate = card({ next_due_on: null });

  it("overdue means before today; today is not overdue; no date counts as overdue", () => {
    expect(isOverdue(yesterday, TODAY)).toBe(true);
    expect(isOverdue(today, TODAY)).toBe(false);
    expect(isOverdue(later, TODAY)).toBe(false);
    expect(isOverdue(nodate, TODAY)).toBe(true);
  });

  it("combines search and overdue-only", () => {
    const cards = [yesterday, today, later, nodate];
    expect(filterCards(cards, { query: "", overdueOnly: true }, TODAY)).toEqual([
      yesterday,
      nodate,
    ]);
    expect(filterCards(cards, { query: "", overdueOnly: false }, TODAY)).toEqual(cards);
    expect(
      filterCards(cards, { query: yesterday.business_name, overdueOnly: true }, TODAY),
    ).toEqual([yesterday]);
    expect(filterCards(cards, { query: today.business_name, overdueOnly: true }, TODAY)).toEqual(
      [],
    );
  });
});

describe("optimistic moves", () => {
  const base = card({ stage: "name_in", next_due_on: "2026-10-24", business_name: "Acme" });

  it("moves the card and applies the new stage's default timer", () => {
    const next = optimisticMove(base, "stips", TODAY);
    expect(next.stage).toBe("stips");
    expect(next.next_due_on).toBe(addBusinessDays(TODAY, 2));
    expect(next.next_due_kind).toBe("follow_up");
    expect(base.stage).toBe("name_in");
    expect(optimisticMove(base, "not_interested", TODAY).next_due_on).toBe(addMonths(TODAY, 12));
  });

  it("keeps a booked call that is earlier than the new follow-up", () => {
    const booked = card({ next_due_on: "2026-10-24", next_due_kind: "scheduled_call" });
    expect(optimisticDue(booked, "2027-01-23").next_due_on).toBe("2026-10-24");
    expect(optimisticDue(booked, "2026-10-24").next_due_kind).toBe("scheduled_call");
    const lateCall = card({ next_due_on: "2027-02-01", next_due_kind: "scheduled_call" });
    expect(optimisticDue(lateCall, "2027-01-23").next_due_on).toBe("2027-01-23");
  });

  it("QA I-1: a drag never pushes a due renewal call or check-in out to the far follow-up", () => {
    const renewal = card({ stage: "funded", next_due_on: "2026-10-23", next_due_kind: "renewal" });
    const dragged = optimisticDue(renewal, "2029-10-23");
    expect(dragged.next_due_on).toBe("2026-10-23");
    expect(dragged.next_due_kind).toBe("renewal");
    const checkIn = card({ stage: "funded", next_due_on: "2026-11-26", next_due_kind: "check_in" });
    expect(optimisticDue(checkIn, "2029-10-23").next_due_on).toBe("2026-11-26");
    // a call due LATER than the follow-up is simply overtaken by it
    expect(optimisticDue(checkIn, "2026-10-30").next_due_on).toBe("2026-10-30");
  });

  it("replaces only the card with that id", () => {
    const other = card();
    const next = optimisticMove(base, "interested", TODAY);
    const after = replaceCard([other, base], next);
    expect(after[0]).toBe(other);
    expect(after[1]).toBe(next);
  });

  it("reverts a failed move, but not over a newer change", () => {
    const guess = optimisticMove(base, "interested", TODAY);
    const reverted = revertCard(replaceCard([base], guess), base, guess);
    expect(reverted[0]).toBe(base);
    const newer = { ...guess, stage: "stips" as const };
    const untouched = revertCard([newer], base, guess);
    expect(untouched[0]).toBe(newer);
  });
});

describe("merging fresh server rows", () => {
  it("keeps object identity for unchanged cards so memoised cards do not re-render", () => {
    const a = card();
    const b = card();
    const merged = mergeServerCards([a, b], [{ ...a }, { ...b }], new Set());
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(b);
  });

  it("takes the server's version of a card that changed", () => {
    const a = card();
    const changed = { ...a, stage: "stips" as const };
    expect(mergeServerCards([a], [changed], new Set())[0]).toBe(changed);
  });

  it("leaves a card with a request in flight alone", () => {
    const a = card();
    const guess = optimisticMove(a, "interested", TODAY);
    const merged = mergeServerCards([guess], [{ ...a }], new Set([a.id]));
    expect(merged[0]).toBe(guess);
  });

  it("adds new rows and drops deleted ones", () => {
    const a = card();
    const gone = card();
    const fresh = card();
    const merged = mergeServerCards([a, gone], [{ ...a }, fresh], new Set());
    expect(merged.map((c) => c.id)).toEqual([a.id, fresh.id]);
  });

  it("compares cards field by field", () => {
    const a = card();
    expect(sameCard(a, { ...a })).toBe(true);
    expect(sameCard(a, { ...a, phone: "1" })).toBe(false);
    expect(sameCards([a], [a])).toBe(true);
    expect(sameCards([a], [{ ...a }])).toBe(false);
    expect(sameCards([a], [])).toBe(false);
  });
});

describe("column totals", () => {
  const cards = [
    card({ wanted_amount_cents: 5_000_000, funding_amount_cents: 1_000_000 }),
    card({ wanted_amount_cents: 2_500_000 }),
    card({ funding_amount_cents: 3_000_000 }),
  ];
  it("adds what merchants asked for in the sales stages and what was advanced after funding", () => {
    expect(summarize(cards, "prospecting")).toEqual({ kind: "wanted", cents: 7_500_000 });
    expect(summarize(cards, "underwriting")).toEqual({ kind: "wanted", cents: 7_500_000 });
    expect(summarize(cards, "exit")).toEqual({ kind: "wanted", cents: 7_500_000 });
    expect(summarize(cards, "funded")).toEqual({ kind: "advanced", cents: 4_000_000 });
    expect(summarize(cards, "trouble")).toEqual({ kind: "advanced", cents: 4_000_000 });
    expect(summarize([], "funded").cents).toBe(0);
  });
});

describe("what a card shows", () => {
  const funded = {
    stage: "funded" as const,
    funded_on: "2026-10-01",
    funding_amount_cents: 5_000_000,
    factor_rate: 1.35,
    funding_payment_cents: 55_000,
    funding_frequency: "daily" as const,
  };

  it("shows how far paid down a funded merchant is", () => {
    // 15 business days after Thu Oct 1 is Thu Oct 22 → 15 × $550 of $67,500
    const pct = cardPaydown(card({ ...funded }), "2026-10-22");
    expect(pct).toBe(12.2);
    expect(cardPaydown(card({ ...funded }), "2026-10-01")).toBe(0);
  });

  it("uses the typed-in collected amount when there is one", () => {
    expect(cardPaydown(card({ ...funded, paid_back_override_cents: 3_375_000 }), TODAY)).toBe(50);
  });

  it("is 100 once paid in full, and absent without terms or outside funded stages", () => {
    expect(cardPaydown(card({ stage: "paid_in_full" }), TODAY)).toBe(100);
    expect(cardPaydown(card({ ...funded, funded_on: null }), TODAY)).toBeNull();
    expect(cardPaydown(card({ ...funded, funding_frequency: null }), TODAY)).toBeNull();
    expect(cardPaydown(card({ ...funded, stage: "interested" }), TODAY)).toBeNull();
    expect(cardPaydown(card({ ...funded, stage: "default_bad" }), TODAY)).toBeNull();
  });

  it("counts days in Isaac's calendar, not the server's", () => {
    // 03:00 UTC on the 23rd is still the evening of the 22nd in New York.
    expect(agoShort("2026-10-23T03:00:00Z", TODAY, "America/New_York")).toBe("yesterday");
    expect(agoShort("2026-10-23T03:00:00Z", TODAY, "UTC")).toBe("today");
    expect(agoShort("2026-10-20T15:00:00Z", TODAY, "America/New_York")).toBe("3d ago");
    expect(agoShort("2026-10-09T15:00:00Z", TODAY, "UTC")).toBe("2w ago");
    expect(agoShort("2026-04-05T15:00:00Z", TODAY, "UTC")).toBe("7mo ago");
    expect(agoShort("2024-07-01T15:00:00Z", TODAY, "UTC")).toBe("2y ago");
    expect(agoShort("2026-10-25T15:00:00Z", TODAY, "UTC")).toBe("today");
  });

  it("says when the last call and the last touch were", () => {
    expect(lastContact(card(), TODAY, "UTC")).toEqual({ call: "No calls yet", touch: null });
    expect(
      lastContact(
        card({ last_call_at: "2026-10-20T15:00:00Z", last_touch_at: "2026-10-20T15:00:00Z" }),
        TODAY,
        "UTC",
      ),
    ).toEqual({ call: "Last call 3d ago", touch: null });
    expect(
      lastContact(
        card({ last_call_at: "2026-10-20T15:00:00Z", last_touch_at: "2026-10-22T15:00:00Z" }),
        TODAY,
        "UTC",
      ),
    ).toEqual({ call: "Last call 3d ago", touch: "last touch yesterday" });
    expect(lastContact(card({ last_touch_at: "2026-10-22T15:00:00Z" }), TODAY, "UTC")).toEqual({
      call: "No calls yet",
      touch: "last touch yesterday",
    });
  });

  it("words other advances the way Isaac does", () => {
    expect(positionsText(card())).toBeNull();
    expect(positionsText(card({ position_count: 1 }))).toBe("1 position");
    expect(positionsText(card({ position_count: 2, position_balance_cents: 5_100_000 }))).toBe(
      "2 positions · $51k balance",
    );
  });

  it("explains every stage's timer", () => {
    for (const key of STAGE_KEYS) expect(timerText(stageDef(key).followUp)).not.toBe("");
    expect(timerText({ kind: "days", days: 1 })).toBe("tomorrow");
    expect(timerText({ kind: "days", days: 3 })).toBe("in 3 days");
    expect(timerText({ kind: "months", months: 12 })).toBe("in 12 months");
  });
});

// ---- the stage-move dialogs -------------------------------------------------------------------

const fundingForm = (over: Partial<FundingForm> = {}): FundingForm => ({
  fundedOn: TODAY,
  amount: "50k",
  factorRate: "1.35",
  payment: "550",
  frequency: "daily",
  funderName: "",
  positionNo: "1",
  termDays: "",
  commission: "",
  ...over,
});

describe("which moves need a dialog", () => {
  it("always asks for funded and lost", () => {
    expect(needsInput(card(), "funded")).toBe(true);
    expect(needsInput(card(), "lost")).toBe(true);
  });
  it("asks for a default stage only when there is an advance to default on", () => {
    expect(needsInput(card({ funding_id: "f1" }), "default_bad")).toBe(true);
    expect(needsInput(card({ funding_id: "f1" }), "written_off")).toBe(true);
    expect(needsInput(card(), "default_bad")).toBe(false);
  });
  it("moves everything else instantly", () => {
    for (const s of STAGE_KEYS.filter(
      (k) =>
        ![
          "funded",
          "lost",
          "default_workable",
          "default_bad",
          "legal_collections",
          "written_off",
          "call_scheduled",
        ].includes(k),
    ))
      expect(needsInput(card({ funding_id: "f1" }), s)).toBe(false);
  });
  it("QA I-8: 'Phone call scheduled' asks when the call is — unless one is booked or he is already there", () => {
    expect(needsInput(card({ stage: "interested" }), "call_scheduled")).toBe(true);
    expect(
      needsInput(
        card({ stage: "stips", scheduled_call_at: "2026-10-24T14:00:00Z" }),
        "call_scheduled",
      ),
    ).toBe(false);
    expect(needsInput(card({ stage: "call_scheduled" }), "call_scheduled")).toBe(false);
  });
  it("a call time must be filled in and not on a day that has gone", () => {
    expect(callTimeProblem("", TODAY)).toMatch(/day and time/);
    expect(callTimeProblem("2026-10-22T09:00", TODAY)).toMatch(/already passed/);
    expect(callTimeProblem("2026-10-23T09:00", TODAY)).toBeUndefined();
    expect(callTimeProblem("2026-10-24T10:00", TODAY)).toBeUndefined();
  });
});

describe("funding form", () => {
  it("explains what is missing in plain words", () => {
    const { errors, terms } = checkFunding(
      fundingForm({ amount: "", factorRate: "", payment: "" }),
      TODAY,
    );
    expect(terms).toBeNull();
    expect(errors.amount).toMatch(/advance amount/);
    expect(errors.factorRate).toMatch(/between 1.00 and 3.00/);
    expect(errors.payment).toMatch(/remittance/);
  });

  it("accepts the way Isaac types", () => {
    const { errors, terms } = checkFunding(
      fundingForm({ amount: "$75,000", payment: "1.2k" }),
      TODAY,
    );
    expect(errors).toEqual({});
    expect(terms).toMatchObject({
      amountCents: 7_500_000,
      paymentCents: 120_000,
      factorRate: 1.35,
    });
  });

  it("rejects a factor outside 1–3, a future funded date and a bad position", () => {
    expect(checkFunding(fundingForm({ factorRate: "0.9" }), TODAY).errors.factorRate).toBeDefined();
    // QA I-3: a bare "6" in the commission box is a question, "6%" and "$3k" are answers
    expect(checkFunding(fundingForm({ commission: "6" }), TODAY).errors.commission).toMatch(
      /points or dollars/,
    );
    expect(
      checkFunding(fundingForm({ commission: "6%" }), TODAY).errors.commission,
    ).toBeUndefined();
    expect(
      checkFunding(fundingForm({ commission: "$3k" }), TODAY).errors.commission,
    ).toBeUndefined();
    expect(
      checkFunding(fundingForm({ factorRate: "13.5" }), TODAY).errors.factorRate,
    ).toBeDefined();
    expect(checkFunding(fundingForm({ fundedOn: "2026-10-24" }), TODAY).errors.fundedOn).toMatch(
      /future/,
    );
    expect(checkFunding(fundingForm({ positionNo: "0" }), TODAY).errors.positionNo).toBeDefined();
    expect(checkFunding(fundingForm({ termDays: "ten" }), TODAY).errors.termDays).toBeDefined();
  });

  it("refuses a remittance bigger than the whole payback, but still previews", () => {
    const { errors, terms } = checkFunding(fundingForm({ amount: "1k", payment: "5k" }), TODAY);
    expect(errors.payment).toMatch(/whole payback/);
    expect(terms).not.toBeNull();
  });

  it("previews payback, remittance count, payoff and the renewal call", () => {
    const { terms } = checkFunding(fundingForm(), TODAY);
    if (!terms) throw new Error("expected terms");
    const p = fundingPreview(terms, TODAY);
    expect(p.paybackCents).toBe(6_750_000);
    expect(p.paymentCount).toBe(123);
    // 50% of $67,500 = $33,750 = 62 remittances (61.4 rounded up), one per business day.
    expect(p.renewalOn).toBe(addBusinessDays(TODAY, 62));
    expect(p.payoffOn).toBe(addBusinessDays(TODAY, 123));
    expect(p.checkInOn).toBe("2026-11-22");
  });

  it("turns cents back into what Isaac would type", () => {
    expect(centsToInput(5_000_000)).toBe("50000");
    expect(centsToInput(123_450)).toBe("1234.50");
    expect(centsToInput(null)).toBe("");
  });
});

describe("lost-deal form", () => {
  const form = {
    funderName: "Everest",
    amount: "",
    factorRate: "",
    payment: "",
    frequency: "" as const,
    positionNo: "",
    termDays: "",
    note: "",
  };
  it("only needs a funder name", () => {
    expect(checkCompetitor(form)).toEqual({});
    expect(checkCompetitor({ ...form, funderName: "  " }).funderName).toMatch(/go with/);
  });
  it("checks the optional numbers when they are filled in", () => {
    expect(checkCompetitor({ ...form, factorRate: "5" }).factorRate).toBeDefined();
    expect(checkCompetitor({ ...form, amount: "lots" }).amount).toBeDefined();
    expect(checkCompetitor({ ...form, termDays: "0" }).termDays).toBeDefined();
  });
  it("calls back at half the competitor's term, else in six months", () => {
    expect(competitorCallback("180", TODAY)).toEqual({ dueOn: "2027-01-21", basis: "term" });
    expect(competitorCallback("", TODAY)).toEqual({ dueOn: "2027-04-23", basis: "fallback" });
    expect(competitorCallback("0", TODAY).basis).toBe("fallback");
    expect(competitorCallback("soon", TODAY).basis).toBe("fallback");
  });
});

describe("default form", () => {
  const form = { defaultedOn: TODAY, promiseAt: "", promiseAmount: "", note: "" };
  it("needs a default date that is not in the future", () => {
    expect(checkDefault(form, TODAY)).toEqual({});
    expect(checkDefault({ ...form, defaultedOn: "2026-10-24" }, TODAY).defaultedOn).toBeDefined();
    expect(checkDefault({ ...form, defaultedOn: "" }, TODAY).defaultedOn).toBeDefined();
  });
  it("checks the promise when given", () => {
    expect(checkDefault({ ...form, promiseAt: "2026-10-28T14:30" }, TODAY)).toEqual({});
    expect(checkDefault({ ...form, promiseAt: "2026-10-28" }, TODAY).promiseAt).toBeDefined();
    expect(checkDefault({ ...form, promiseAmount: "x" }, TODAY).promiseAmount).toBeDefined();
  });
  it("follows up on the promise day when that is sooner than the usual timer", () => {
    // Bad default is normally 7 days out (Oct 30)
    expect(defaultFollowUp("default_bad", "2026-10-26T14:00", TODAY)).toEqual({
      dueOn: "2026-10-26",
      basis: "promise",
    });
    expect(defaultFollowUp("default_bad", "2026-11-15T14:00", TODAY).basis).toBe("stage");
    expect(defaultFollowUp("default_bad", "2026-10-20T14:00", TODAY).basis).toBe("stage");
    expect(defaultFollowUp("default_bad", "", TODAY)).toEqual({
      dueOn: "2026-10-30",
      basis: "stage",
    });
    // Workable default is 3 business days (Oct 28), the same day: the usual timer wins.
    expect(defaultFollowUp("default_workable", "2026-10-28T09:00", TODAY).basis).toBe("stage");
    expect(defaultFollowUp("default_workable", "2026-10-26T09:00", TODAY).basis).toBe("promise");
  });
});

describe("undo", () => {
  const ctx = { today: TODAY, timezone: "America/New_York" };

  it("puts the client back with the date they had", () => {
    const prev = card({ stage: "interested", next_due_on: "2026-10-25" });
    expect(undoInput(prev, "stips", false, ctx)).toEqual({
      clientId: prev.id,
      stage: "interested",
      followUpOn: "2026-10-25",
    });
  });

  it("never asks for a date in the past", () => {
    const prev = card({ stage: "interested", next_due_on: "2026-10-20" });
    expect(undoInput(prev, "stips", false, ctx)?.followUpOn).toBe(TODAY);
    expect(clampToToday("2026-10-25", TODAY)).toBe("2026-10-25");
  });

  it("leaves the date off when there was none", () => {
    const prev = card({ stage: "interested", next_due_on: null });
    expect(undoInput(prev, "stips", false, ctx)).not.toHaveProperty("followUpOn");
  });

  it("cannot undo into or out of Funded, or a move that wrote a funding or competitor record", () => {
    expect(undoInput(card({ stage: "funded" }), "paying_off_soon", false, ctx)).toBeNull();
    expect(undoInput(card({ stage: "interested" }), "funded", true, ctx)).toBeNull();
    expect(undoInput(card({ stage: "interested" }), "lost", true, ctx)).toBeNull();
    expect(undoInput(card({ stage: "interested" }), "lost", false, ctx)).not.toBeNull();
  });

  it("hands a default stage's promise back so undo does not wipe it", () => {
    const prev = card({
      stage: "default_workable",
      funding_id: "f1",
      defaulted_on: "2026-10-11",
      promise_to_pay_at: "2026-10-28T18:30:00+00:00",
      promise_amount_cents: 250_000,
      next_due_on: "2026-10-26",
    });
    expect(undoInput(prev, "default_bad", false, ctx)).toEqual({
      clientId: prev.id,
      stage: "default_workable",
      followUpOn: "2026-10-26",
      default: {
        defaultedOn: "2026-10-11",
        promiseToPayAt: "2026-10-28T14:30",
        promiseAmount: "2500",
      },
    });
  });
});
