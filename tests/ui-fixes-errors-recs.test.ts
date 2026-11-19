import { describe, expect, it } from "vitest";
import { toActionError } from "@/lib/data/errors";
import { buildRecommendations, type RecommendationFacts } from "@/lib/assistant/recommendations";
import { shopSchema } from "@/lib/settings/schemas";
import { z, ZodError } from "zod";

const shop = {
  shopName: "Selective",
  postalAddress: "1 Main St",
  dailyCap: 200,
  amberAt: 150,
  reservedForIntake: 20,
  sequencesEnabled: true,
  sendWindowStart: 9,
  sendWindowEnd: 17,
  sendOnWeekends: false,
  perMerchantDaily: 1,
  perMerchantWeekly: 3,
  automationFrom: "",
  automationReplyToRep: true,
};
const errorOf = (patch: Record<string, unknown>): ZodError => {
  const r = shopSchema.safeParse({ ...shop, ...patch });
  if (r.success) throw new Error("expected the settings to be refused");
  return r.error;
};

describe("toActionError names the field", () => {
  it("a daily cap below the minimum says 'Daily cap', not an anonymous 'Too small'", () => {
    const words = toActionError(errorOf({ dailyCap: 10 }));
    expect(words).toContain("Daily cap");
    expect(words).toContain("50");
    expect(words).not.toMatch(/^Too small/);
  });

  it("too big, and not a number, are named too", () => {
    expect(toActionError(errorOf({ dailyCap: 99999 }))).toBe("Daily cap must be at most 2000");
    expect(toActionError(errorOf({ perMerchantDaily: "abc" }))).toBe(
      "Emails per merchant a day must be a number",
    );
  });

  it("reports every failing field, once, not just the first", () => {
    const words = toActionError(errorOf({ dailyCap: 10, perMerchantWeekly: 99 }));
    expect(words).toContain("Daily cap");
    expect(words).toContain("Emails per merchant a week");
  });

  it("a key without a label is spelled out from its name", () => {
    const err = z.object({ sendDelayHours: z.number().min(1) }).safeParse({ sendDelayHours: 0 });
    expect(toActionError(err.error)).toBe("Send delay hours must be at least 1");
  });

  it("a message written for the field is kept as it is", () => {
    expect(toActionError(errorOf({ sendWindowStart: 18, sendWindowEnd: 17 }))).toMatch(
      /^The send window must end after it starts/,
    );
    const err = z
      .object({ amount: z.number().min(1, "Enter an amount above $0") })
      .safeParse({ amount: 0 });
    expect(toActionError(err.error)).toBe("Enter an amount above $0");
  });

  it("long lists are cut to three and counted", () => {
    const err = z
      .object({
        a: z.number().min(1),
        b: z.number().min(1),
        c: z.number().min(1),
        d: z.number().min(1),
      })
      .safeParse({ a: 0, b: 0, c: 0, d: 0 });
    expect(toActionError(err.error)).toMatch(/; and 1 more$/);
  });
});

describe("the postal-address recommendation", () => {
  const base: RecommendationFacts = {
    manager: false,
    replyWaiting: 0,
    overdue: 0,
    readyToHandOff: 0,
    readyBucketId: null,
    queue: {},
    quietMissingDocs: 0,
    postalAddressSet: false,
    gmailConnected: true,
    weakBuckets: [],
    repBehind: null,
  };
  const card = (manager: boolean) =>
    buildRecommendations({ ...base, manager }).find((r) => r.id === "postal-address")!;

  it("a manager is sent to Settings, Email", () => {
    expect(card(true).href).toBe("/settings/email");
  });

  it("a rep is told to ask a manager and is never sent to a manager-only page", () => {
    const rep = card(false);
    expect(rep.title).toMatch(/ask a manager/i);
    expect(rep.href).not.toMatch(/^\/settings/);
    expect(rep.prompt).toMatch(/only a manager/i);
  });
});
