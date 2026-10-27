import { describe, expect, it } from "vitest";
import {
  activeCount,
  applyFilters,
  facetsOf,
  NO_FILTERS,
  type ClientFilters,
} from "@/lib/data/clientFilters";
import type { ClientCard } from "@/lib/data/types";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
let n = 0;
const card = (over: Partial<ClientCard> = {}): ClientCard =>
  ({
    id: `c${(n += 1)}`,
    business_name: `Biz ${n}`,
    dba: "",
    contact_name: "",
    phone: "",
    email: "",
    industry: "",
    state: "",
    source: "",
    stage: "interested",
    last_touch_at: null,
    wanted_amount_cents: null,
    ...over,
  }) as ClientCard;
const run = (cards: ClientCard[], f: Partial<ClientFilters>) =>
  applyFilters(cards, { ...NO_FILTERS, ...f }, NOW).map((c) => c.business_name);

describe("applyFilters", () => {
  it("no filters keeps everyone", () => {
    const cards = [card(), card(), card()];
    expect(applyFilters(cards, NO_FILTERS, NOW)).toHaveLength(3);
  });
  it("matches source, state and industry regardless of case and spacing", () => {
    const a = card({
      business_name: "A",
      source: "Lead  Vendor",
      state: "tx",
      industry: "Restaurant",
    });
    const b = card({ business_name: "B", source: "Referral", state: "FL", industry: "Trucking" });
    expect(run([a, b], { source: "lead vendor" })).toEqual(["A"]);
    expect(run([a, b], { state: "TX" })).toEqual(["A"]);
    expect(run([a, b], { industry: "RESTAURANT" })).toEqual(["A"]);
    expect(run([a, b], { state: "FL", industry: "trucking" })).toEqual(["B"]);
  });
  it("filters by an exact stage and by stage group", () => {
    const a = card({ business_name: "A", stage: "offers_in" });
    const b = card({ business_name: "B", stage: "dead" });
    expect(run([a, b], { stage: "lost" })).toEqual(["B"]); // dead folds into lost
    expect(run([a, b], { group: "exit" })).toEqual(["B"]);
    expect(run([a, b], { group: "underwriting" })).toEqual(["A"]);
  });
  it("'wants at least' drops merchants who want less or haven't said", () => {
    const a = card({ business_name: "A", wanted_amount_cents: 5_000_000 });
    const b = card({ business_name: "B", wanted_amount_cents: 1_000_000 });
    const c = card({ business_name: "C", wanted_amount_cents: null });
    expect(run([a, b, c], { minWanted: 2_500_000 })).toEqual(["A"]);
    expect(run([a, b, c], { minWanted: 1_000_000 })).toEqual(["A", "B"]);
  });
  it("'not contacted in N days' includes people never contacted", () => {
    const recent = card({ business_name: "Recent", last_touch_at: daysAgo(10) });
    const old = card({ business_name: "Old", last_touch_at: daysAgo(100) });
    const never = card({ business_name: "Never", last_touch_at: null });
    expect(run([recent, old, never], { quiet: "30" })).toEqual(["Old", "Never"]);
    expect(run([recent, old, never], { quiet: "90" })).toEqual(["Old", "Never"]);
    expect(run([recent, old, never], { quiet: "180" })).toEqual(["Never"]);
    expect(run([recent, old, never], { quiet: "never" })).toEqual(["Never"]);
  });
  it("a day exactly at the limit counts as quiet for that long", () => {
    const edge = card({ business_name: "Edge", last_touch_at: daysAgo(30) });
    expect(run([edge], { quiet: "30" })).toEqual(["Edge"]);
  });
  it("search matches name, business, phone digits and email, and combines with the other filters", () => {
    const a = card({ business_name: "Mike's Pizza", phone: "+13055550100", state: "FL" });
    const b = card({ business_name: "Mike's Auto", phone: "+17135550111", state: "TX" });
    expect(run([a, b], { term: "305555" })).toEqual(["Mike's Pizza"]);
    expect(run([a, b], { term: "mike", state: "TX" })).toEqual(["Mike's Auto"]);
  });
});

describe("facetsOf", () => {
  it("lists each value once in its most common spelling, sorted, without blanks", () => {
    const f = facetsOf([
      card({ source: "Referral", state: "TX", industry: "Restaurant" }),
      card({ source: "referral", state: "tx", industry: "restaurant" }),
      card({ source: "Referral", state: "FL", industry: "" }),
      card({ source: "", state: "", industry: "Trucking" }),
    ]);
    expect(f).toEqual({
      sources: ["Referral"],
      states: ["FL", "TX"],
      industries: ["Restaurant", "Trucking"],
    });
  });
});

describe("activeCount", () => {
  it("counts narrowing filters but not search", () => {
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(activeCount({ ...NO_FILTERS, term: "mike" })).toBe(0);
    expect(activeCount({ ...NO_FILTERS, source: "Referral", minWanted: 1, quiet: "30" })).toBe(3);
  });
});
