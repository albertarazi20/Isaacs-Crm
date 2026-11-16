import { describe, expect, it } from "vitest";
import { aiBlockedWords, aiFailureWords, NO_KEY_WORDS } from "@/lib/deals/aiWords";
import { dealOfferMath } from "@/lib/deals/compare";
import { stipDisplayLabel } from "@/lib/deals/stipLabels";
import { eventDomId, eventDomIds } from "@/lib/deals/timelineIds";
import { parseChaseDraft, submissionOfChaseKey } from "@/lib/inbox/chaseDrafts";
import type { FunderOfferRow, SubmissionRow } from "@/lib/funders/types";

/** The pure parts of the board and deal-page controls: wording, ids, parsing and the compare table's inputs. */

describe("stipDisplayLabel", () => {
  it("shows the lender's own words for a stip of kind other", () => {
    expect(stipDisplayLabel("other", null, "Landlord letter on letterhead")).toBe(
      "Landlord letter on letterhead",
    );
    expect(stipDisplayLabel("other", null, "  Proof of payroll  ")).toBe("Proof of payroll");
  });
  it("falls back to the kind's name when there are no words, and ignores a label on other kinds", () => {
    expect(stipDisplayLabel("other", null, "")).toBe("Other document");
    expect(stipDisplayLabel("other", null, "   ")).toBe("Other document");
    expect(stipDisplayLabel("tax_return", null, "something typed")).toBe("Tax return");
    expect(stipDisplayLabel("bank_statement", "2026-10-01", "")).toBe("October 2026 bank statement");
  });
});

describe("timeline DOM ids", () => {
  const at = "2026-11-16T14:03:11.123456+00:00";
  it("is built from what the event came from and when, with characters safe in an id", () => {
    const id = eventDomId({ ref_type: "submission", ref_id: "abc-123", at });
    expect(id).toBe(`tl-submission-abc-123-${Date.parse(at)}`);
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });
  it("gives a citation and the feed row the same id, and numbers a collision in feed order", () => {
    const a = { ref_type: "submission", ref_id: "s1", at };
    const b = { ref_type: "submission", ref_id: "s1", at: "2026-11-15T10:00:00Z" };
    const ids = eventDomIds([a, b, a]);
    expect(ids[0]).toBe(eventDomId(a));
    expect(ids[1]).toBe(eventDomId(b));
    expect(ids[2]).toBe(`${eventDomId(a)}-2`);
    expect(new Set(ids).size).toBe(3);
  });
  it("copes with a timestamp it cannot parse", () => {
    expect(eventDomId({ ref_type: "deal", ref_id: "d", at: "soon!" })).toBe("tl-deal-d-soon");
  });
});

describe("AI wording", () => {
  const ok = { keyPresent: true, enabled: true, spentCents: 10, capCents: 2000 };
  it("says why the controls cannot run, in the order a person can fix it", () => {
    expect(aiBlockedWords(ok)).toBeNull();
    expect(aiBlockedWords({ ...ok, keyPresent: false })).toBe(NO_KEY_WORDS);
    expect(aiBlockedWords({ ...ok, keyPresent: false, enabled: false })).toBe(NO_KEY_WORDS);
    expect(aiBlockedWords({ ...ok, enabled: false })).toBe("The AI is switched off in Settings.");
    expect(aiBlockedWords({ ...ok, spentCents: 2000 })).toMatch(/spend cap is used up/);
    expect(aiBlockedWords({ ...ok, spentCents: 5000 })).toMatch(/spend cap is used up/);
  });
  it("turns the model's failures into plain words", () => {
    expect(
      aiFailureWords(
        new Error(
          "Could not resolve authentication method. Expected either apiKey or authToken to be set.",
        ),
      ),
    ).toBe(NO_KEY_WORDS);
    expect(
      aiFailureWords(Object.assign(new Error("401 invalid x-api-key"), { status: 401 })),
    ).toMatch(/refused this server's key/);
    expect(
      aiFailureWords(
        Object.assign(new Error("Your credit balance is too low to access the API"), {
          status: 400,
        }),
      ),
    ).toMatch(/out of credit/);
    expect(aiFailureWords(Object.assign(new Error("slow down"), { status: 429 }))).toMatch(/busy/);
    expect(aiFailureWords(Object.assign(new Error("overloaded"), { status: 529 }))).toMatch(
      /having trouble/,
    );
    expect(
      aiFailureWords(Object.assign(new Error("Connection error."), { name: "APIConnectionError" })),
    ).toMatch(/Couldn't reach the AI service/);
  });
  it("leaves every other error for the generic wording", () => {
    expect(aiFailureWords(new Error("relation does not exist"))).toBeNull();
    expect(aiFailureWords("boom")).toBeNull();
    expect(aiFailureWords(null)).toBeNull();
    expect(aiFailureWords(Object.assign(new Error("not found"), { status: 404 }))).toBeNull();
  });
});

describe("chase drafts", () => {
  const body =
    "Pearl has been quiet for 2 business days. Send this from the thread:\n\nTo: subs@pearl.com\nSubject: Re: [D-12] Chase Co\n\nHi Pearl team,\n\nAny update on Chase Co (D-12)? Happy to send anything else you need.\n\nThanks,\nJosh";
  it("splits the alert body the nightly chase writes", () => {
    const p = parseChaseDraft(body);
    expect(p.why).toBe("Pearl has been quiet for 2 business days. Send this from the thread:");
    expect(p.to).toBe("subs@pearl.com");
    expect(p.subject).toBe("Re: [D-12] Chase Co");
    expect(p.text.startsWith("Hi Pearl team,")).toBe(true);
    expect(p.text.endsWith("Thanks,\nJosh")).toBe(true);
  });
  it("keeps a body it cannot split as the text", () => {
    expect(parseChaseDraft("Just a nudge")).toEqual({
      why: "",
      to: "",
      subject: "",
      text: "Just a nudge",
    });
  });
  it("reads the lender row from the dedupe key, and nothing from any other key", () => {
    const id = "0f9c1a52-3b64-4c0e-9a55-6d1f0b2a7e31";
    expect(submissionOfChaseKey(`chase_draft:${id}:2`)).toBe(id);
    expect(submissionOfChaseKey(`chase_draft:${id}`)).toBeNull();
    expect(submissionOfChaseKey("chase_draft:not-a-uuid:1")).toBeNull();
    expect(submissionOfChaseKey(`approval_landed:${id}`)).toBeNull();
    expect(submissionOfChaseKey(null)).toBeNull();
  });
});

describe("dealOfferMath", () => {
  const offer = (over: Partial<FunderOfferRow>): FunderOfferRow => ({
    id: "o1",
    submission_id: "s1",
    client_id: "c1",
    amount_cents: 5_000_000,
    factor_rate: 1.3,
    payment_cents: 45_000,
    frequency: "daily",
    term_days: 130,
    position_no: null,
    fees_cents: 50_000,
    note: "",
    received_on: "2026-11-16",
    status: "open",
    ...over,
  });
  const sub = (
    id: string,
    funder: string,
    dealId: string | null,
    offers: FunderOfferRow[],
  ): SubmissionRow & { deal_id: string | null } => ({
    id,
    client_id: "c1",
    funder_id: `f-${funder}`,
    funder_name: funder,
    sent_on: "2026-11-10",
    status: "approved",
    decline_reason: null,
    decline_note: "",
    note: "",
    status_changed_at: "2026-11-10T10:00:00Z",
    responded_on: null,
    chase_due_on: null,
    offers,
    deal_id: dealId,
  });
  const funders = [
    { id: "f-Alpha", commission_points: 6 },
    { id: "f-Bravo", commission_points: null },
  ];

  it("works out payback, net to merchant and commission from the rows the page already has", () => {
    const [m] = dealOfferMath([sub("s1", "Alpha", "d1", [offer({})])], funders, "d1");
    expect(m).toMatchObject({
      funderName: "Alpha",
      paybackCents: 6_500_000,
      costCents: 1_500_000,
      paymentCount: 145,
      netToMerchantCents: 4_950_000,
      commissionPoints: 6,
      commissionCents: 300_000,
      best: false,
    });
  });
  it("marks the lowest factor as best, and only when there is something to compare it with", () => {
    const math = dealOfferMath(
      [
        sub("s1", "Alpha", "d1", [offer({ id: "a" })]),
        sub("s2", "Bravo", "d1", [offer({ id: "b", factor_rate: 1.25, amount_cents: 4_000_000 })]),
      ],
      funders,
      "d1",
    );
    expect(math.map((m) => [m.funderName, m.best])).toEqual([
      ["Bravo", true],
      ["Alpha", false],
    ]);
    expect(math[0]?.commissionCents).toBeNull();
  });
  it("leaves out offers that are no longer in play, and offers on another deal", () => {
    const math = dealOfferMath(
      [
        sub("s1", "Alpha", "d1", [
          offer({ id: "a" }),
          offer({ id: "x", status: "declined" }),
          offer({ id: "y", status: "expired" }),
        ]),
        sub("s2", "Bravo", "d-other", [offer({ id: "b" })]),
      ],
      funders,
      "d1",
    );
    expect(math.map((m) => m.offerId)).toEqual(["a"]);
  });
  it("keeps accepted and presented offers", () => {
    const math = dealOfferMath(
      [
        sub("s1", "Alpha", null, [
          offer({ id: "a", status: "accepted" }),
          offer({ id: "p", status: "presented", factor_rate: 1.4 }),
        ]),
      ],
      funders,
      "d1",
    );
    expect(math.map((m) => m.offerId)).toEqual(["a", "p"]);
  });
});
