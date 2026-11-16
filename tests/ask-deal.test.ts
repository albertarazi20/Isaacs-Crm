/** "Where does this deal stand?" (plan §7): answered from the timeline, cited, verified in code, logged. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askInputHash, verifyCitations, type Asker } from "@/lib/ai/askDeal";
import { askDeal } from "@/lib/deals/ask";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

describe("ask the deal a question", () => {
  let t: TestDb;
  let rep: string;
  let other: string;
  let client: string;
  let dealId: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    other = await insertUser(t.pool, "other@x.com");
    client = await insertClient(t.db, rep, "Harbor Bakery");
    await t.db.withUser(rep, async (q) => {
      await q.query("select submit_to_ops($1, 'new', 3000000, 'a second oven')", [client]);
      await q.query(
        "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'note', 'Owner wants the money before Thanksgiving, statements for October are on the way')",
        [rep, client],
      );
    });
    dealId = (
      await t.pool.query<{ id: string }>("select id from deals where client_id = $1", [client])
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("keeps only the citations whose quote is really in the cited event", () => {
    const input = {
      question: "when does he want it",
      businessName: "Harbor Bakery",
      status: "queued",
      blocker: "",
      events: [
        {
          ref: "e1",
          at: "2026-11-16",
          kind: "note",
          actor: "Ray",
          title: "Note",
          detail: "Owner wants the money before Thanksgiving",
        },
      ],
    };
    const { verified, dropped } = verifyCitations(input, {
      answer: "Before Thanksgiving.",
      cannot_answer: false,
      confidence: "high",
      citations: [
        { ref: "e1", quote: "wants the money before Thanksgiving" },
        { ref: "e1", quote: "wants it by Christmas" },
        { ref: "e9", quote: "wants the money before Thanksgiving" },
      ],
    });
    expect(verified).toEqual([{ ref: "e1", quote: "wants the money before Thanksgiving" }]);
    expect(dropped).toBe(2);
    expect(askInputHash(input)).toHaveLength(64);
  });

  it("answers from the timeline, points at the real event, and logs the run", async () => {
    let seen: string[] = [];
    const asker: Asker = async (i, model) => {
      seen = i.events.map((e) => e.detail);
      const note = i.events.find((e) => e.detail.includes("Thanksgiving"))!;
      const r = {
        answer: "He wants the money before Thanksgiving; October statements are on the way.",
        cannot_answer: false,
        confidence: "high" as const,
        citations: [
          { ref: note.ref, quote: "before Thanksgiving, statements for October" },
          { ref: note.ref, quote: "this was never written anywhere" },
        ],
      };
      return {
        result: r,
        model,
        inputTokens: 900,
        outputTokens: 60,
        inputHash: askInputHash(i),
        verified: [{ ref: note.ref, quote: "before Thanksgiving, statements for October" }],
        dropped: 1,
      };
    };
    const a = await askDeal({
      db: t.db,
      userId: rep,
      dealId,
      question: "When does he need it?",
      asker,
    });
    expect(seen.some((d) => d.includes("Thanksgiving"))).toBe(true);
    expect(a.answer).toMatch(/Thanksgiving/);
    expect(a.confidence).toBe("high");
    expect(a.dropped).toBe(1);
    expect(a.citations).toHaveLength(1);
    expect(a.citations[0]!.ref_type).toBe("activity");
    expect(a.citations[0]!.quote).toBe("before Thanksgiving, statements for October");
    const run = await t.pool.query<{ purpose: string; deal_id: string; cost: string; q: string }>(
      "select purpose, deal_id, cost_cents::text as cost, output->>'question' as q from ai_runs where purpose = 'ask_deal'",
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({
      purpose: "ask_deal",
      deal_id: dealId,
      q: "When does he need it?",
    });
    expect(Number(run.rows[0]!.cost)).toBeGreaterThan(0);
  });

  it("an answer with no surviving citation is marked low, and 'the material does not say' stays honest", async () => {
    const asker: Asker = async (i, model) => ({
      result: {
        answer: "Probably next week.",
        cannot_answer: false,
        confidence: "high",
        citations: [],
      },
      model,
      inputTokens: 10,
      outputTokens: 5,
      inputHash: askInputHash(i),
      verified: [],
      dropped: 0,
    });
    const a = await askDeal({ db: t.db, userId: rep, dealId, question: "Funding date?", asker });
    expect(a.confidence).toBe("low");
    expect(a.citations).toEqual([]);
  });

  it("another rep cannot ask about a deal that is not theirs; the kill switch stops everyone", async () => {
    const asker: Asker = async () => {
      throw new Error("should not be called");
    };
    await expect(
      askDeal({ db: t.db, userId: other, dealId, question: "status?", asker }),
    ).rejects.toThrow(/isn't in your view/);
    await t.pool.query("update shop_settings set ai_enabled = false");
    await expect(
      askDeal({ db: t.db, userId: rep, dealId, question: "status?", asker }),
    ).rejects.toThrow(/switched off/);
    await t.pool.query("update shop_settings set ai_enabled = true");
  });
});
