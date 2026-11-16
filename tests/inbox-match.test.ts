import { describe, expect, it } from "vitest";
import { verify, type ReadInput, type ReaderResult } from "@/lib/ai/readLenderEmail";
import {
  authResults,
  dealTokenIn,
  domainOf,
  matchEmail,
  nameSimilarity,
  type Candidate,
} from "@/lib/inbox/match";
import { htmlToText, parseAddress, splitMessageIds } from "@/lib/inbox/gmailRead";

const cand = (over: Partial<Candidate>): Candidate => ({
  submissionId: "s1",
  dealId: "d1",
  clientId: "c1",
  funderId: "f1",
  threadId: null,
  messageId: null,
  dealNumber: 1042,
  businessName: "Mike's Pizza LLC",
  dba: "",
  funderDomain: "pearlcapital.com",
  ...over,
});
const headers = (over: Partial<Parameters<typeof matchEmail>[0]>) => ({
  threadId: null,
  inReplyTo: null,
  references: [],
  fromAddress: "uw@pearlcapital.com",
  subject: "",
  text: "",
  ...over,
});

describe("the matching ladder", () => {
  it("1. the Gmail thread of the submission we sent", () => {
    const c = cand({ threadId: "t-abc" });
    expect(matchEmail(headers({ threadId: "t-abc", subject: "Re: anything" }), [c])?.by).toBe(
      "thread",
    );
  });
  it("2. reply headers pointing at our Message-ID", () => {
    const c = cand({ messageId: "<m1@selectivecap.com>" });
    expect(matchEmail(headers({ inReplyTo: "<m1@selectivecap.com>" }), [c])?.by).toBe(
      "reply_headers",
    );
    expect(matchEmail(headers({ references: ["<x>", "<m1@selectivecap.com>"] }), [c])?.by).toBe(
      "reply_headers",
    );
  });
  it("3. the [D-1042] token, narrowed to the sender's lender", () => {
    const pearl = cand({ submissionId: "s1", funderDomain: "pearlcapital.com" });
    const fora = cand({ submissionId: "s2", funderId: "f2", funderDomain: "forafinancial.com" });
    const m = matchEmail(
      headers({ subject: "Approved: [D-1042] Mike's Pizza", fromAddress: "ops@forafinancial.com" }),
      [pearl, fora],
    );
    expect(m?.by).toBe("deal_token");
    expect(m?.candidate.submissionId).toBe("s2");
    expect(dealTokenIn("Re: [D-7] x")).toBe(7);
    expect(dealTokenIn("no token")).toBeNull();
  });
  it("4. a known lender naming the business; a stranger does not match", () => {
    const c = cand({});
    expect(
      matchEmail(headers({ subject: "Offer for Mikes Pizza", text: "please see attached" }), [c])
        ?.by,
    ).toBe("funder_name");
    expect(
      matchEmail(headers({ subject: "Offer for Mikes Pizza", fromAddress: "someone@gmail.com" }), [
        c,
      ]),
    ).toBeNull();
    expect(
      matchEmail(headers({ subject: "Weekly newsletter", text: "rates are great" }), [c]),
    ).toBeNull();
  });
  it("name similarity ignores suffixes and punctuation", () => {
    expect(nameSimilarity("Mike's Pizza, LLC", "mikes pizza")).toBe(1);
    expect(nameSimilarity("Sunrise Dental Group Inc", "Sunrise Dental")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Golden Wok", "Bella Nails")).toBeLessThan(0.3);
  });
  it("helpers: domain, auth results, addresses, html", () => {
    expect(domainOf("Jane <jane@Pearl.com>")).toBe("pearl.com");
    expect(authResults("mx.google.com; spf=pass smtp.mailfrom=x; dkim=pass header.i=@x")).toEqual({
      spf: true,
      dkim: true,
    });
    expect(authResults("mx.google.com; spf=softfail; dkim=none")).toEqual({
      spf: false,
      dkim: false,
    });
    expect(parseAddress('"Jane Doe" <jane@x.com>')).toEqual({
      name: "Jane Doe",
      address: "jane@x.com",
    });
    expect(splitMessageIds("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"]);
    expect(htmlToText("<p>Approved <b>$45,000</b></p><br>at 1.35")).toBe(
      "Approved $45,000\n\nat 1.35",
    );
  });
});

describe("the reader's code-side checks", () => {
  const input: ReadInput = {
    from: "uw@pearlcapital.com",
    subject: "Approval - Mike's Pizza",
    text: "Good news. Mike's Pizza is approved for $45,000 at a 1.35 factor, 120 day term, $506.25 daily. Payback $60,750. Need voided check and DL.",
    attachmentNames: [],
  };
  const base: ReaderResult = {
    event: "approved",
    is_from_lender: true,
    lender_name: "Pearl",
    business_name: "Mike's Pizza",
    offer: {
      amount_dollars: 45000,
      factor_rate: 1.35,
      payback_dollars: 60750,
      payment_dollars: 506.25,
      frequency: "daily",
      term_days: 120,
      buy_rate: null,
      max_upsell_points: null,
      fees_dollars: null,
      expires_on: null,
      position_no: null,
    },
    offers_count: 1,
    decline_reason: null,
    stips_requested: ["voided check", "driver's license"],
    portal_link_only: false,
    summary: "Pearl approved $45,000 at 1.35, 120 days",
    next_step: "Pitch the offer",
    evidence: [
      { field: "event", quote: "is approved for" },
      { field: "amount_dollars", quote: "$45,000" },
      { field: "factor_rate", quote: "1.35 factor" },
      { field: "payback_dollars", quote: "Payback $60,750" },
      { field: "payment_dollars", quote: "$506.25 daily" },
      { field: "frequency", quote: "$506.25 daily" },
      { field: "term_days", quote: "120 day term" },
    ],
    confidence: 0.95,
  };
  it("every quoted fact is found and the maths add up", () => {
    expect(verify(input, base)).toEqual({ unsupported: [], problems: [] });
  });
  it("a number with no quote in the email is unsupported; wrong maths is a problem", () => {
    const r: ReaderResult = {
      ...base,
      offer: { ...base.offer!, amount_dollars: 50000, payback_dollars: 61000 },
      evidence: base.evidence.filter((e) => e.field !== "amount_dollars"),
    };
    const v = verify(input, r);
    expect(v.unsupported).toContain("amount_dollars");
    expect(v.problems).toContain("payback ≠ amount × factor");
  });
  it("an invented quote is unsupported even when the field is present", () => {
    const r: ReaderResult = {
      ...base,
      evidence: [
        ...base.evidence.filter((e) => e.field !== "event"),
        { field: "event", quote: "we are thrilled to approve" },
      ],
    };
    expect(verify(input, r).unsupported).toContain("event");
  });
});
