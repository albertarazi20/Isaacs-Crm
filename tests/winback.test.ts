import { describe, expect, it } from "vitest";
import type { ClientCard } from "@/lib/data/types";
import { STAGE_KEYS } from "@/lib/mca/stages";
import { offerProgress, winbackText, type WinbackArgs } from "@/lib/mca/templates";
import {
  buildWinback,
  compact,
  moneyLine,
  parseWinbackDays,
  splitBatch,
  WINBACK_STAGES,
  winbackSuggestion,
  type OfferRecord,
} from "@/lib/messaging/winback";

const TODAY = "2026-10-23";
const TZ = "America/New_York";

let n = 0;
function card(over: Partial<ClientCard> = {}): ClientCard {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    business_name: `Biz ${n}`,
    dba: "",
    contact_name: "Mike Ross",
    phone: "3055550101",
    email: "",
    industry: "",
    state: "FL",
    source: "",
    monthly_revenue_cents: null,
    time_in_business_months: null,
    stage: "dead",
    stage_changed_at: "2026-06-01T12:00:00Z",
    application_received_on: null,
    scheduled_call_at: null,
    last_contact_at: null,
    contact_status: "ok",
    contact_status_note: "",
    contact_status_at: null,
    created_at: "2026-01-01T00:00:00Z",
    next_due_on: "2026-11-01",
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
  } as ClientCard;
}

const offer = (clientId: string, over: Partial<OfferRecord> = {}): OfferRecord => ({
  client_id: clientId,
  funder_name: "Rival Capital",
  amount_cents: 5_000_000,
  factor_rate: 1.42,
  term_days: 180,
  offered_on: "2026-05-01",
  won: true,
  ...over,
});

const build = (cards: ClientCard[], offers: OfferRecord[] = [], days = 30) =>
  buildWinback(cards, offers, { today: TODAY, days, timezone: TZ });

describe("who is a win-back candidate", () => {
  it("is dead, declined, lost, killed, not interested or written off — and no other stage", () => {
    expect([...WINBACK_STAGES].sort()).toEqual(
      ["dead", "declined", "killed", "lost", "not_interested", "written_off"].sort(),
    );
    for (const stage of STAGE_KEYS) {
      const rows = build([card({ stage })]);
      expect(rows.length, stage).toBe(WINBACK_STAGES.includes(stage) ? 1 : 0);
    }
  });

  it("leaves out anyone whose contact status is not 'ok' — whatever channel they refused", () => {
    for (const status of ["no_text", "no_call", "no_email", "dnc"] as const) {
      expect(build([card({ contact_status: status })]), status).toEqual([]);
    }
    expect(build([card({ contact_status: "ok" })])).toHaveLength(1);
  });

  it("takes everyone due within the window, overdue included, and nobody later", () => {
    const due = (d: string | null) => build([card({ next_due_on: d })]).length;
    expect(due("2026-09-01")).toBe(1); // a lead from long ago is still a call
    expect(due("2026-10-01")).toBe(1);
    expect(due(TODAY)).toBe(1);
    expect(due("2026-11-22")).toBe(1); // exactly 30 days out
    expect(due("2026-11-23")).toBe(0); // 31
    expect(due(null)).toBe(0);
  });

  it("honours a longer or shorter window", () => {
    const c = card({ next_due_on: "2026-12-15" }); // 53 days out
    expect(build([c], [], 30)).toHaveLength(0);
    expect(build([c], [], 60)).toHaveLength(1);
    expect(build([c], [], 7)).toHaveLength(0);
  });
});

describe("the order: money first, then recency", () => {
  it("sorts by the last ask, biggest first", () => {
    const a = card({ business_name: "A", wanted_amount_cents: 2_000_000 });
    const b = card({ business_name: "B", wanted_amount_cents: 9_000_000 });
    const c = card({ business_name: "C", wanted_amount_cents: null });
    expect(build([a, c, b]).map((r) => r.card.business_name)).toEqual(["B", "A", "C"]);
  });
  it("counts a lost deal's competing offer as its money", () => {
    const lost = card({ business_name: "Lost", stage: "lost", wanted_amount_cents: 1_000_000 });
    const asked = card({ business_name: "Asked", wanted_amount_cents: 4_000_000 });
    const rows = build([asked, lost], [offer(lost.id, { amount_cents: 7_000_000 })]);
    expect(rows.map((r) => r.card.business_name)).toEqual(["Lost", "Asked"]);
    expect(rows[0]?.moneyCents).toBe(7_000_000);
  });
  it("breaks a tie with the most recently lost first, then by name", () => {
    const old = card({
      business_name: "Old",
      stage_changed_at: "2025-01-01T00:00:00Z",
      wanted_amount_cents: 100,
    });
    const recent = card({
      business_name: "Recent",
      stage_changed_at: "2026-09-01T00:00:00Z",
      wanted_amount_cents: 100,
    });
    const same1 = card({
      business_name: "Zed",
      stage_changed_at: "2026-01-01T00:00:00Z",
      wanted_amount_cents: 100,
    });
    const same2 = card({
      business_name: "Abe",
      stage_changed_at: "2026-01-01T00:00:00Z",
      wanted_amount_cents: 100,
    });
    expect(build([old, same1, recent, same2]).map((r) => r.card.business_name)).toEqual([
      "Recent",
      "Abe",
      "Zed",
      "Old",
    ]);
  });
  it("uses an offer only for a lost deal, preferring the one the merchant took", () => {
    const lost = card({ stage: "lost" });
    const dead = card({ stage: "dead" });
    const offers = [
      offer(lost.id, { funder_name: "Quote Only", amount_cents: 9_000_000, won: false }),
      offer(lost.id, { funder_name: "Took It", amount_cents: 3_000_000, won: true }),
      offer(dead.id, { funder_name: "Ignored", amount_cents: 8_000_000 }),
    ];
    const rows = build([lost, dead], offers);
    const byStage = Object.fromEntries(rows.map((r) => [r.card.stage, r]));
    expect(byStage.lost?.offer?.funder_name).toBe("Took It");
    expect(byStage.dead?.offer).toBeNull();
    expect(byStage.dead?.moneyCents).toBe(0);
  });
  it("among offers he didn't take, the biggest wins", () => {
    const lost = card({ stage: "lost" });
    const rows = build(
      [lost],
      [
        offer(lost.id, { funder_name: "Small", amount_cents: 1_000_000, won: false }),
        offer(lost.id, { funder_name: "Big", amount_cents: 6_000_000, won: false }),
      ],
    );
    expect(rows[0]?.offer?.funder_name).toBe("Big");
  });
});

describe("the batch of ten", () => {
  const many = Array.from({ length: 27 }, (_, i) =>
    card({
      business_name: `M${String(i).padStart(2, "0")}`,
      wanted_amount_cents: (100 - i) * 100_000,
    }),
  );
  it("takes ten, leaves the rest waiting", () => {
    const { batch, later, done } = splitBatch(build(many));
    expect(batch).toHaveLength(10);
    expect(later).toHaveLength(17);
    expect(done).toEqual([]);
    expect(batch[0]?.card.business_name).toBe("M00");
    expect(later[0]?.card.business_name).toBe("M10");
  });
  it("moves on past anyone already texted or called today (in his time zone)", () => {
    const touched = card({
      business_name: "Touched",
      wanted_amount_cents: 999_999_999,
      // 02:00 UTC on the 24th is still the 23rd in New York
      last_touch_at: "2026-10-24T02:00:00Z",
    });
    const yesterday = card({
      business_name: "Yesterday",
      wanted_amount_cents: 1,
      last_touch_at: "2026-10-23T03:00:00Z", // the 22nd 11 PM in New York
    });
    const rows = build([touched, yesterday, ...many.slice(0, 12)]);
    const { batch, later, done } = splitBatch(rows);
    expect(done.map((r) => r.card.business_name)).toEqual(["Touched"]);
    expect(batch.some((r) => r.card.business_name === "Touched")).toBe(false);
    expect(batch).toHaveLength(10);
    expect(later.map((r) => r.card.business_name)).toContain("Yesterday");
    expect(compact(done[0]!)).toMatchObject({ businessName: "Touched", stage: "dead" });
  });
  it("shrinks the whole thing to a one-line row for the long tail", () => {
    const row = build([card({ business_name: "Tail", wanted_amount_cents: 500_000 })])[0]!;
    expect(compact(row)).toEqual({
      id: row.card.id,
      businessName: "Tail",
      stage: "dead",
      dueOn: "2026-11-01",
      moneyCents: 500_000,
    });
  });
});

describe("?days=", () => {
  it.each([
    [undefined, 30],
    ["", 30],
    ["14", 14],
    ["90", 90],
    ["1", 1],
    ["0", 30],
    ["-5", 30],
    ["abc", 30],
    ["2.5", 30],
    ["999", 365],
    ["365", 365],
  ])("%j → %j", (raw, expected) => {
    expect(parseWinbackDays(raw)).toBe(expected);
  });
});

describe("reason-aware texts", () => {
  const base: WinbackArgs = {
    contactName: "Mike Ross",
    businessName: "Mike's Pizza",
    stage: "dead",
    senderName: "Isaac Cohen",
    today: TODAY,
  };
  const lostOffer = (over: Partial<NonNullable<WinbackArgs["offer"]>> = {}) => ({
    funderName: "Rival Capital",
    factorRate: 1.42,
    termDays: 180,
    offeredOn: "2026-07-25", // 90 days before TODAY: halfway through a 180-day term
    won: true,
    ...over,
  });

  it("lost deal with a logged competing offer names the rival and the factor rate", () => {
    const t = winbackText({ ...base, stage: "lost", offer: lostOffer() });
    expect(t).toBe(
      "Hey Mike, it's Isaac. Rival Capital's 1.42 advance should be about half paid by now — want me to look at a renewal elsewhere?",
    );
  });
  it("says 'should be about half paid' only when the term really is about half over", () => {
    const at = (offeredOn: string) =>
      winbackText({ ...base, stage: "lost", offer: lostOffer({ offeredOn }) });
    expect(at("2026-07-25")).toContain("should be about half paid"); // 90 of 180 days
    expect(at("2026-08-12")).toContain("should be about half paid"); // 72 days: 40%, the lower edge
    expect(at("2026-08-13")).toContain("may still have a way to go"); // 71 days: under 40%
    expect(at("2026-05-15")).toContain("should be about half paid"); // 161 days: under 90%
    expect(at("2026-05-14")).toContain("should be close to paid off"); // 162 days: 90%
  });
  it("hedges when the term isn't known, and when the advance is nowhere near half way", () => {
    expect(winbackText({ ...base, stage: "lost", offer: lostOffer({ termDays: null }) })).toContain(
      "may be about half paid",
    );
    expect(
      winbackText({ ...base, stage: "lost", offer: lostOffer({ offeredOn: null }) }),
    ).toContain("may be about half paid");
    const early = winbackText({
      ...base,
      stage: "lost",
      offer: lostOffer({ offeredOn: "2026-10-01" }),
    });
    expect(early).toContain("may still have a way to go");
    expect(early).not.toContain("half paid");
    const late = winbackText({
      ...base,
      stage: "lost",
      offer: lostOffer({ offeredOn: "2026-01-01" }),
    });
    expect(late).toContain("should be close to paid off");
  });
  it("doesn't claim they took a quote that was only logged as a quote", () => {
    const t = winbackText({ ...base, stage: "lost", offer: lostOffer({ won: false }) });
    expect(t).toContain("If you went with Rival Capital's 1.42 advance, it may be about half paid");
  });
  it("leaves the rate out when it wasn't logged, and copes with no offer at all", () => {
    expect(
      winbackText({ ...base, stage: "lost", offer: lostOffer({ factorRate: null }) }),
    ).toContain("Rival Capital's advance");
    expect(winbackText({ ...base, stage: "lost", offer: null })).toBe(
      "Hey Mike, it's Isaac. Your advance with the other funder may be about half paid by now — want me to look at a renewal elsewhere?",
    );
  });
  it("formats the factor rate the way the shop writes it", () => {
    expect(
      winbackText({ ...base, stage: "lost", offer: lostOffer({ factorRate: 1.4 }) }),
    ).toContain("1.40 advance");
    expect(
      winbackText({ ...base, stage: "lost", offer: lostOffer({ factorRate: 1.345 }) }),
    ).toContain("1.345 advance");
  });
  it("declined says 'may' — it doesn't claim revenue grew", () => {
    const t = winbackText({ ...base, stage: "declined" });
    expect(t).toBe(
      "Hey Mike, it's Isaac. Your revenue may have grown since we last looked at Mike's Pizza — want me to resubmit?",
    );
    expect(winbackText({ ...base, stage: "declined", wantedAmountCents: 6_000_000 })).toContain(
      "want me to resubmit your $60,000 request?",
    );
  });
  it("dead asks if they still want funding", () => {
    expect(winbackText({ ...base, stage: "dead" })).toBe(
      "Hey Mike, it's Isaac. Been a while — still looking for funding? Glad to run fresh numbers for Mike's Pizza.",
    );
  });
  it("not interested is gentle", () => {
    const t = winbackText({ ...base, stage: "not_interested" });
    expect(t).toContain("No pressure at all");
    expect(t).not.toMatch(/resubmit|renewal|\?/);
  });
  it("killed and written off each get their own wording", () => {
    expect(winbackText({ ...base, stage: "killed" })).toContain("on hold a while back");
    const w = winbackText({ ...base, stage: "written_off" });
    expect(w).toContain("I hope business is treating you better");
    expect(w).not.toMatch(/owe|balance|collect|default/i);
  });
  it("greets by name, with an honorific, or without a name; signs with his first name", () => {
    expect(winbackText({ ...base, contactName: "Dr. Alan Weiss" })).toMatch(
      /^Hey Dr\. Weiss, it's Isaac\./,
    );
    expect(winbackText({ ...base, contactName: "" })).toMatch(/^Hey, it's Isaac\./);
    expect(winbackText({ ...base, senderName: "isaac" })).toContain("it's Isaac.");
    expect(winbackText({ ...base, senderName: "" })).toContain("it's Isaac.");
  });
  it("never uses words a funding shop would be dismissed for, and stays text-sized", () => {
    for (const stage of STAGE_KEYS) {
      for (const offer of [null, lostOffer(), lostOffer({ won: false, factorRate: null })]) {
        const t = winbackText({ ...base, stage, offer, wantedAmountCents: 4_500_000 });
        expect(t.toLowerCase(), stage).not.toMatch(
          /\bloans?\b|lender|borrower|interest rate|\bapr\b|customer|\bpayment|principal/,
        );
        expect(t.length, stage).toBeLessThan(330);
        expect(t.startsWith("Hey Mike, it's Isaac. "), stage).toBe(true);
      }
    }
  });
  it("works out how far through its term an advance should be", () => {
    expect(offerProgress(lostOffer(), TODAY)).toBeCloseTo(0.5, 5);
    expect(offerProgress(lostOffer({ termDays: null }), TODAY)).toBeNull();
    expect(offerProgress(lostOffer({ offeredOn: null }), TODAY)).toBeNull();
    expect(offerProgress(lostOffer({ termDays: 0 }), TODAY)).toBeNull();
    expect(offerProgress(lostOffer({ offeredOn: "garbage" }), TODAY)).toBeNull();
  });

  it("builds the text for a row from the card and its offer", () => {
    const lost = card({
      stage: "lost",
      contact_name: "Ron Ellis",
      business_name: "Park Place Parking",
    });
    const [row] = build(
      [lost],
      [offer(lost.id, { offered_on: "2026-07-25", term_days: 180, factor_rate: 1.42 })],
    );
    expect(winbackSuggestion(row!, "Isaac Cohen", TODAY)).toBe(
      "Hey Ron, it's Isaac. Rival Capital's 1.42 advance should be about half paid by now — want me to look at a renewal elsewhere?",
    );
  });
});

describe("money line", () => {
  it("says what the competitor offered or what was asked", () => {
    const lost = card({ stage: "lost" });
    const [a] = build([lost], [offer(lost.id)]);
    expect(moneyLine(a!)).toBe("Rival Capital funded $50k at 1.42");
    const [b] = build([lost], [offer(lost.id, { won: false, factor_rate: null })]);
    expect(moneyLine(b!)).toBe("Rival Capital offered $50k");
    const [c] = build([card({ wanted_amount_cents: 6_000_000 })]);
    expect(moneyLine(c!)).toBe("Asked for $60k");
    const [d] = build([card()]);
    expect(moneyLine(d!)).toBeNull();
  });
});
