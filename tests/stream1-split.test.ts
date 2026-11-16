import { describe, expect, it } from "vitest";
import {
  splitLeadText,
  verifySplit,
  type SplitOutcome,
  type SplitResult,
  type Splitter,
} from "@/lib/ai/splitLeadLine";
import { UserError } from "@/lib/data/mutations";

/** Stream 1, S1-12: paste a lead line; the code refuses a phone or email the model invented. */

const blank: SplitResult = {
  first_name: "",
  last_name: "",
  business_name: "",
  phone: "",
  phone2: "",
  email: "",
  email2: "",
  industry: "",
  state: "",
  wanted_amount: "",
  looking_for: "",
  notes: "",
};
const scripted =
  (r: Partial<SplitResult>): Splitter =>
  async (_text, model) => {
    const out: SplitOutcome = {
      result: { ...blank, ...r },
      model,
      inputTokens: 100,
      outputTokens: 50,
      inputHash: "h",
    };
    return out;
  };
const TEXT =
  "Rosa Diaz - Harbor Tacos - (310) 555-0199 - rosa@HarborTacos.com - CA - wants 60k for a second truck, call after 3pm";

describe("S1-12: paste a lead line", () => {
  it("pure check: the phone digits and the email must be in the text", () => {
    const good = {
      ...blank,
      first_name: "Rosa",
      phone: "310-555-0199",
      email: "rosa@harbortacos.com",
      state: "ca",
    };
    expect(verifySplit(TEXT, good)).toEqual([]);
    expect(verifySplit(TEXT, { ...good, phone: "3105550100" })).toEqual([
      "the phone 3105550100 is not in the text",
    ]);
    expect(verifySplit(TEXT, { ...good, email: "rosa@gmail.com" })).toEqual([
      "the email rosa@gmail.com is not in the text",
    ]);
    expect(verifySplit(TEXT, { ...good, phone2: "555" })).toEqual([
      "the second phone 555 is not in the text",
    ]);
    expect(verifySplit(TEXT, { ...good, state: "California" })).toEqual([
      "the state is not a two-letter code",
    ]);
  });

  it("a faithful split comes back as the form's fields, trimmed, state upper-cased", async () => {
    const { fields } = await splitLeadText(
      TEXT,
      scripted({
        first_name: " Rosa",
        last_name: "Diaz",
        business_name: "Harbor Tacos",
        phone: "(310) 555-0199",
        email: "rosa@HarborTacos.com",
        state: "ca",
        wanted_amount: "60k",
        looking_for: "a second truck",
        notes: "call after 3pm",
      }),
      "claude-haiku-5-5",
    );
    expect(fields).toMatchObject({
      first_name: "Rosa",
      last_name: "Diaz",
      business_name: "Harbor Tacos",
      phone: "(310) 555-0199",
      email: "rosa@HarborTacos.com",
      state: "CA",
      wanted_amount: "60k",
      looking_for: "a second truck",
    });
  });

  it("a split with an invented phone or email is refused in words, and empty text never reaches the model", async () => {
    await expect(
      splitLeadText(
        TEXT,
        scripted({ phone: "(310) 555-0100", email: "rosa@harbortacos.com" }),
        "m",
      ),
    ).rejects.toThrow(
      /did not match what was pasted: the phone \(310\) 555-0100 is not in the text/,
    );
    const err = await splitLeadText(TEXT, scripted({ email: "rosa@gmail.com" }), "m").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserError);
    let called = 0;
    const counting: Splitter = async (t, m) => ((called += 1), scripted({})(t, m));
    await expect(splitLeadText("   ", counting, "m")).rejects.toThrow(/Paste the lead first/);
    expect(called).toBe(0);
  });
});
