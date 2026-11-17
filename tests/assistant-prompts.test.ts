import { describe, expect, it } from "vitest";
import { queueBrief, type QueueReason } from "@/lib/assistant/prompts";
import type { QueueKind } from "@/lib/followup/overview";

// The two unions must stay the same list: a QueueKind the briefs do not know would crash the Overview row.
const sameList: Record<QueueKind, QueueReason> = {
  reply: "reply",
  opened: "opened",
  call_now: "call_now",
  ready: "ready",
  upload: "upload",
  bounced: "bounced",
  overdue: "overdue",
};

describe("queueBrief", () => {
  it("names the merchant and its id for every reason, with a short label", () => {
    for (const reason of Object.values(sameList)) {
      const b = queueBrief(reason, " Joe's Pizza ", "11111111-2222-3333-4444-555555555555");
      expect(b.prompt).toContain("Joe's Pizza (merchant_id 11111111-2222-3333-4444-555555555555)");
      expect(b.label).toMatch(/: Joe's Pizza$/);
      expect(b.label.length).toBeLessThan(60);
    }
  });

  it("a reply asks for a draft to review, not a sent email", () => {
    expect(queueBrief("reply", "A", "x").prompt).toMatch(/review and send/);
  });

  it("a merchant with no name still reads as a sentence", () => {
    expect(
      queueBrief("overdue", "  ", "x").prompt.startsWith("This merchant (merchant_id x)"),
    ).toBe(true);
  });
});
