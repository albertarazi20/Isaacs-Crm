import { describe, expect, it } from "vitest";
import { defaultSnippets, DEFAULT_SNIPPET_TITLES, snippetsFor } from "@/lib/messaging/defaults";
import {
  appendSignature,
  describeLeftovers,
  describeOffer,
  effectiveSignature,
  isMergeField,
  leftoverFields,
  MERGE_FIELDS,
  mergeValues,
  pickBestOffer,
  resolveMergeFields,
  splitSubject,
  type MergeContext,
  type OfferSummary,
} from "@/lib/messaging/merge";
import { messageSettingsSchema, snippetSchema } from "@/lib/messaging/schemas";

const ctx: MergeContext = {
  contactName: "Mike Ross",
  businessName: "Mike's Pizza",
  senderName: "Isaac Cohen",
  applicationLink: "https://apply.example.com/isaac",
  wantedAmountCents: 6_000_000,
  bestOffer: {
    funderName: "Rival Capital",
    amountCents: 5_000_000,
    factorRate: 1.42,
    termDays: 180,
    offeredOn: "2026-05-01",
    won: true,
  },
};

describe("resolveMergeFields", () => {
  const values = mergeValues(ctx);

  it("fills every field", () => {
    const r = resolveMergeFields(
      "Hey {first_name}, it's {sender}. {business} wants {amount_wanted}. Apply: {application_link}. Best so far: {funder_best_offer}.",
      values,
    );
    expect(r.text).toBe(
      "Hey Mike, it's Isaac. Mike's Pizza wants $60,000. Apply: https://apply.example.com/isaac. Best so far: $50,000 at 1.42 from Rival Capital.",
    );
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("fills the same field every time it appears", () => {
    expect(resolveMergeFields("{business}, {business}!", values).text).toBe(
      "Mike's Pizza, Mike's Pizza!",
    );
  });

  it("treats the field name case-insensitively", () => {
    expect(resolveMergeFields("Hi {First_Name} {BUSINESS}", values).text).toBe(
      "Hi Mike Mike's Pizza",
    );
  });

  it("leaves a field with no value VISIBLE and reports it — never a silent blank", () => {
    const r = resolveMergeFields(
      "Hey {first_name}, apply here: {application_link}",
      mergeValues({ ...ctx, applicationLink: "" }),
    );
    expect(r.text).toBe("Hey Mike, apply here: {application_link}");
    expect(r.missing).toEqual(["application_link"]);
    expect(r.unknown).toEqual([]);
  });

  it("reports each missing field once, in order of appearance", () => {
    const r = resolveMergeFields(
      "{amount_wanted} {funder_best_offer} {amount_wanted}",
      mergeValues({ ...ctx, wantedAmountCents: null, bestOffer: null }),
    );
    expect(r.missing).toEqual(["amount_wanted", "funder_best_offer"]);
    expect(r.text).toBe("{amount_wanted} {funder_best_offer} {amount_wanted}");
  });

  it("leaves an unknown field visible and flags it", () => {
    const r = resolveMergeFields("Hi {firstname}, {business} and {Nope}", values);
    expect(r.text).toBe("Hi {firstname}, Mike's Pizza and {Nope}");
    expect(r.unknown).toEqual(["firstname", "Nope"]);
    expect(r.missing).toEqual([]);
  });

  it("only the exact {name} form is a field", () => {
    const text = "{ } {} {1} {a b} {first-name} {{business}} { first_name }";
    const r = resolveMergeFields(text, values);
    expect(r.unknown).toEqual([]);
    // {{business}} is the one real field in there, inside literal braces
    expect(r.text).toBe("{ } {} {1} {a b} {first-name} {Mike's Pizza} { first_name }");
  });

  it("is a single pass: a value that looks like a field is not expanded again", () => {
    const r = resolveMergeFields("{business}", {
      business: "Foo {first_name}",
      first_name: "Mike",
    });
    expect(r.text).toBe("Foo first_name");
  });

  it("treats whitespace-only values as missing", () => {
    const r = resolveMergeFields("Hi {first_name}", { first_name: "   " });
    expect(r.text).toBe("Hi {first_name}");
    expect(r.missing).toEqual(["first_name"]);
  });

  it("leaves a message with no fields alone", () => {
    const r = resolveMergeFields("Just checking in.\n\nThanks", values);
    expect(r).toEqual({ text: "Just checking in.\n\nThanks", missing: [], unknown: [] });
  });
});

describe("mergeValues", () => {
  it("greets by first name, keeping an honorific", () => {
    expect(mergeValues({ ...ctx, contactName: "Dr. Alan Weiss" }).first_name).toBe("Dr. Weiss");
    expect(mergeValues({ ...ctx, contactName: "  Priya   Nair " }).first_name).toBe("Priya");
  });
  it("leaves first_name blank (so it is flagged) when there is no contact name", () => {
    expect(mergeValues({ ...ctx, contactName: "" }).first_name).toBe("");
  });
  it("signs with a tidy first name, defaulting to Isaac", () => {
    expect(mergeValues({ ...ctx, senderName: "isaac cohen" }).sender).toBe("Isaac");
    expect(mergeValues({ ...ctx, senderName: "" }).sender).toBe("Isaac");
  });
  it("formats the ask and says nothing when there isn't one", () => {
    expect(mergeValues(ctx).amount_wanted).toBe("$60,000");
    expect(mergeValues({ ...ctx, wantedAmountCents: null }).amount_wanted).toBe("");
  });
  it("has a value key for every merge field", () => {
    expect(Object.keys(mergeValues(ctx)).sort()).toEqual([...MERGE_FIELDS].sort());
  });
  it("recognises the field names", () => {
    for (const f of MERGE_FIELDS) expect(isMergeField(f)).toBe(true);
    expect(isMergeField("FIRST_NAME")).toBe(true);
    expect(isMergeField("firstname")).toBe(false);
  });
});

describe("offers", () => {
  const o = (
    funderName: string,
    amountCents: number | null,
    factorRate: number | null,
  ): OfferSummary => ({
    funderName,
    amountCents,
    factorRate,
    termDays: null,
    offeredOn: null,
    won: false,
  });

  it("describes only what was logged", () => {
    expect(describeOffer(o("Rival Capital", 5_000_000, 1.42))).toBe(
      "$50,000 at 1.42 from Rival Capital",
    );
    expect(describeOffer(o("Rival Capital", 5_000_000, null))).toBe("$50,000 from Rival Capital");
    expect(describeOffer(o("Rival Capital", null, 1.345))).toBe("1.345 from Rival Capital");
    expect(describeOffer(o("Rival Capital", null, 1.4))).toBe("1.40 from Rival Capital");
    expect(describeOffer(o("Rival Capital", null, null))).toBe("an offer from Rival Capital");
  });
  it("picks the most money, then the lowest factor rate; offers with no amount come last", () => {
    expect(pickBestOffer([])).toBeNull();
    const list = [
      o("A", 3_000_000, 1.3),
      o("B", 5_000_000, 1.45),
      o("C", 5_000_000, 1.38),
      o("D", null, 1.1),
    ];
    expect(pickBestOffer(list)?.funderName).toBe("C");
    expect(pickBestOffer([o("D", null, 1.1), o("E", null, 1.2)])?.funderName).toBe("D");
  });
});

describe("leftovers", () => {
  it("lists every field still in a message", () => {
    expect(leftoverFields("Hi {first_name}, {foo} and {first_name} again")).toEqual([
      "{first_name}",
      "{foo}",
    ]);
    expect(leftoverFields("All filled in.")).toEqual([]);
  });
  it("explains in plain words", () => {
    expect(describeLeftovers("Hi Mike")).toBeNull();
    expect(describeLeftovers("Apply {application_link}", { applicationLinkSet: false })).toBe(
      "This message still has {application_link} in it. Add your application link in Settings, or take it out.",
    );
    expect(describeLeftovers("Hi {first_name}")).toBe(
      "This message still has {first_name} in it. Fill it in or take it out before you send.",
    );
  });
});

describe("email subject and signature", () => {
  it("splits a Subject: first line off the body", () => {
    expect(
      splitSubject("Subject: Your application for {business}\n\nHi {first_name},\n\nBody"),
    ).toEqual({
      subject: "Your application for {business}",
      body: "Hi {first_name},\n\nBody",
    });
    expect(splitSubject("subject:Hello\r\n\r\nBody")).toEqual({ subject: "Hello", body: "Body" });
    expect(splitSubject("No subject line here")).toEqual({
      subject: null,
      body: "No subject line here",
    });
    expect(splitSubject("Subject:   \n\nBody").subject).toBeNull();
    // not at the very start: it is just text
    expect(splitSubject("Hi\nSubject: x\n\nBody").subject).toBeNull();
  });
  it("uses his signature, or Thanks and his name until he writes one", () => {
    expect(effectiveSignature("  Isaac Cohen\nFunding · 555-0100 ", "Isaac Cohen")).toBe(
      "Isaac Cohen\nFunding · 555-0100",
    );
    expect(effectiveSignature("", "isaac cohen")).toBe("Thanks,\nIsaac Cohen");
    expect(effectiveSignature("   ", "")).toBe("Thanks,\nIsaac");
  });
  it("puts the signature on the end once", () => {
    expect(appendSignature("Hi Mike,\n\nQuick note.\n\n", "Isaac\n555-0100")).toBe(
      "Hi Mike,\n\nQuick note.\n\nIsaac\n555-0100",
    );
    // already there (pasted in): not doubled
    expect(appendSignature("Hi\n\nIsaac\n555-0100", "Isaac\n555-0100")).toBe(
      "Hi\n\nIsaac\n555-0100",
    );
    expect(appendSignature("Hi", "")).toBe("Hi");
    expect(appendSignature("", "Isaac")).toBe("Isaac");
  });
});

describe("the six built-in snippets", () => {
  it("are exactly the six named, in both kinds", () => {
    expect(DEFAULT_SNIPPET_TITLES).toEqual([
      "Send application",
      "Need statements",
      "Following up on offers",
      "Contract reminder",
      "Renewal check",
      "Win-back",
    ]);
    for (const kind of ["text", "email"] as const) {
      const list = defaultSnippets(kind);
      expect(list.map((s) => s.title)).toEqual([...DEFAULT_SNIPPET_TITLES]);
      expect(list.every((s) => s.isDefault && s.kind === kind && s.id.startsWith("default:"))).toBe(
        true,
      );
      expect(new Set(list.map((s) => s.id)).size).toBe(6);
    }
  });
  it("only use real fields, resolve fully for a known merchant, and say nothing a loan shop would", () => {
    const values = mergeValues(ctx);
    for (const kind of ["text", "email"] as const) {
      for (const s of defaultSnippets(kind)) {
        const { subject, body } =
          kind === "email" ? splitSubject(s.body) : { subject: null, body: s.body };
        const r = resolveMergeFields(body, values);
        expect(r.unknown, s.title).toEqual([]);
        expect(r.missing, s.title).toEqual([]);
        expect(leftoverFields(r.text), s.title).toEqual([]);
        if (kind === "email") expect(subject, s.title).toBeTruthy();
        expect(s.body.toLowerCase(), s.title).not.toMatch(
          /\bloans?\b|lender|borrower|interest rate|\bapr\b|customer|\bpayment/,
        );
        // they parse as saveable snippets
        expect(
          snippetSchema.safeParse({ title: s.title, kind, body: s.body }).success,
          s.title,
        ).toBe(true);
      }
    }
  });
  it("only Send application needs an application link", () => {
    const values = mergeValues({ ...ctx, applicationLink: "" });
    const needing = defaultSnippets("text").filter(
      (s) => resolveMergeFields(s.body, values).missing.length > 0,
    );
    expect(needing.map((s) => s.title)).toEqual(["Send application"]);
  });
  it("keep texts short enough to send", () => {
    for (const s of defaultSnippets("text")) expect(s.body.length, s.title).toBeLessThan(260);
  });
  it("show until he saves his own of that kind, then his replace them", () => {
    expect(snippetsFor([], "text")).toHaveLength(6);
    const saved = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Mine",
        kind: "text" as const,
        body: "Hi {first_name}",
      },
    ];
    expect(snippetsFor(saved, "text").map((s) => s.title)).toEqual(["Mine"]);
    expect(snippetsFor(saved, "text")[0]?.isDefault).toBe(false);
    // a text snippet doesn't hide the email defaults
    expect(snippetsFor(saved, "email")).toHaveLength(6);
  });
});

describe("snippet and settings validation (plain words)", () => {
  const ok = {
    title: "Quick hello",
    kind: "text" as const,
    body: "Hi {first_name} from {business}",
  };

  it("accepts a good snippet and trims the title", () => {
    const r = snippetSchema.parse({ ...ok, title: "  Quick hello  " });
    expect(r.title).toBe("Quick hello");
  });
  it("needs a name and a message", () => {
    expect(snippetSchema.safeParse({ ...ok, title: " " }).error?.issues[0]?.message).toBe(
      "Give the snippet a name",
    );
    expect(snippetSchema.safeParse({ ...ok, body: "  " }).error?.issues[0]?.message).toBe(
      "Write the message first",
    );
  });
  it("refuses a name with a line break", () => {
    expect(snippetSchema.safeParse({ ...ok, title: "a\nb" }).success).toBe(false);
  });
  it("refuses a field it doesn't know, and names the real ones", () => {
    const r = snippetSchema.safeParse({ ...ok, body: "Hi {firstname}" });
    const msg = r.error?.issues[0]?.message ?? "";
    expect(msg).toContain("{firstname} isn't a field I know");
    expect(msg).toContain("{first_name}");
    expect(msg).toContain("{funder_best_offer}");
  });
  it("refuses an SSN or a card number in the body", () => {
    expect(
      snippetSchema.safeParse({ ...ok, body: "SSN 123-45-6789" }).error?.issues[0]?.message,
    ).toMatch(/Social Security/);
    expect(
      snippetSchema.safeParse({ ...ok, body: "Card 4111 1111 1111 1111" }).error?.issues[0]
        ?.message,
    ).toMatch(/card number/);
    expect(
      snippetSchema.safeParse({ ...ok, body: "routing number 021000021" }).error?.issues[0]
        ?.message,
    ).toMatch(/bank account or routing/);
  });
  it("checks the Subject: line of an email snippet", () => {
    const email = { title: "E", kind: "email" as const };
    expect(snippetSchema.safeParse({ ...email, body: "Subject: Hi\n\nBody" }).success).toBe(true);
    expect(
      snippetSchema.safeParse({ ...email, body: "Subject:  \n\nBody" }).error?.issues[0]?.message,
    ).toMatch(/Subject: line is empty/);
    expect(
      snippetSchema.safeParse({ ...email, body: `Subject: ${"x".repeat(201)}\n\nBody` }).success,
    ).toBe(false);
    expect(snippetSchema.safeParse({ ...email, body: "Subject: Hi\n\n" }).success).toBe(false);
  });
  it("limits the size", () => {
    expect(snippetSchema.safeParse({ ...ok, body: "x".repeat(3001) }).success).toBe(false);
    expect(snippetSchema.safeParse({ ...ok, title: "x".repeat(81) }).success).toBe(false);
  });

  it("accepts a blank or real web address for the application link", () => {
    for (const link of ["", "https://apply.example.com/isaac", "http://example.com/a?b=c"]) {
      expect(
        messageSettingsSchema.safeParse({ signature: "", applicationLink: link }).success,
        link,
      ).toBe(true);
    }
  });
  it("refuses an application link that isn't a web address", () => {
    for (const link of [
      "apply.example.com",
      "javascript:alert(1)",
      "ftp://x.com/a",
      "https://a b.com",
      "https://x.com/\nfoo",
    ]) {
      const r = messageSettingsSchema.safeParse({ signature: "", applicationLink: link });
      expect(r.success, link).toBe(false);
    }
    expect(
      messageSettingsSchema.safeParse({ signature: "", applicationLink: "nope" }).error?.issues[0]
        ?.message,
    ).toBe("Enter a full web address that starts with https://");
  });
  it("keeps the signature short and clean", () => {
    expect(
      messageSettingsSchema.safeParse({
        signature: "Isaac\nFunding · 555-0100",
        applicationLink: "",
      }).success,
    ).toBe(true);
    expect(
      messageSettingsSchema.safeParse({ signature: "x".repeat(1001), applicationLink: "" }).success,
    ).toBe(false);
    expect(
      messageSettingsSchema.safeParse({ signature: "SSN 123-45-6789", applicationLink: "" })
        .success,
    ).toBe(false);
    expect(
      messageSettingsSchema.safeParse({ signature: "a\u0000b", applicationLink: "" }).success,
    ).toBe(false);
  });
});
