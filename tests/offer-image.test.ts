/** A screenshot of a lender's portal becomes a proposed update in the Review tray (plan §7 Offers Import). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadOutcome, ReaderResult } from "@/lib/ai/readLenderEmail";
import { imageHash, type Transcriber } from "@/lib/ai/transcribeImage";
import { importOfferImage } from "@/lib/inbox/pasteImage";
import type { Reader } from "@/lib/inbox/process";
import { createTestDb, insertClient, insertUser, type TestDb } from "./helpers/db";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const reading = (r: Partial<ReaderResult>, text: string): ReadOutcome => {
  const result: ReaderResult = {
    event: "approved",
    is_from_lender: true,
    lender_name: "Pearl Capital",
    business_name: "Harbor Bakery",
    offer: {
      amount_dollars: 45000,
      factor_rate: 1.35,
      payback_dollars: 60750,
      payment_dollars: 506,
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
    stips_requested: [],
    portal_link_only: false,
    summary: "Pearl approved $45,000 at 1.35",
    next_step: "Pitch it",
    evidence: [
      { field: "event", quote: "Approved" },
      { field: "amount_dollars", quote: "$45,000" },
      { field: "factor_rate", quote: "1.35" },
      { field: "payback_dollars", quote: "60,750" },
      { field: "payment_dollars", quote: "506" },
      { field: "term_days", quote: "120 days" },
    ],
    confidence: 0.9,
    ...r,
  };
  return {
    result,
    model: "claude-opus-5-5",
    inputTokens: 500,
    outputTokens: 80,
    inputHash: "x".repeat(64),
    unsupported: [],
    problems: [],
  };
  void text;
};

describe("offer screenshot import", () => {
  let t: TestDb;
  let manager: string;
  let rep: string;
  let client: string;
  let dealId: string;

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com");
    manager = await insertUser(t.pool, "boss@x.com");
    await t.pool.query("update app_users set role = 'manager' where id = $1", [manager]);
    client = await insertClient(t.db, rep, "Harbor Bakery");
    await t.db.withUser(rep, (q) =>
      q.query("select submit_to_ops($1, 'new', 4500000, 'inventory')", [client]),
    );
    dealId = (
      await t.pool.query<{ id: string }>("select id from deals where client_id = $1", [client])
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("transcribes, reads the transcript like pasted text, and lands the terms in the tray as 'pasted'", async () => {
    const transcript =
      "Pearl Capital portal — Harbor Bakery — Approved $45,000 at 1.35, payback 60,750, 506 daily over 120 days";
    const transcriber: Transcriber = async (img, model) => ({
      result: { transcript, legible: true, looks_like: "lender_portal" },
      model,
      inputTokens: 1200,
      outputTokens: 90,
      inputHash: imageHash(img.bytes),
    });
    let readText = "";
    const reader: Reader = async (i) => {
      readText = i.text;
      return reading({}, i.text);
    };
    const out = await importOfferImage({
      db: t.db,
      userId: manager,
      input: { dealId, bytes: png(), mediaType: "image/png", filename: "pearl.png" },
      transcriber,
      reader,
    });
    expect(readText).toContain("transcribed from the screenshot pearl.png");
    expect(readText).toContain("Approved $45,000");
    expect(out.event).toBe("approved");
    expect(out.transcript).toBe(transcript);
    const p = await t.pool.query<{ source: string; status: string; event: string; amount: string }>(
      "select source, status, event, payload->>'amount_cents' as amount from proposed_updates where id = $1",
      [out.proposedId],
    );
    expect(p.rows[0]).toEqual({
      source: "pasted",
      status: "proposed",
      event: "approved",
      amount: "4500000",
    });
    const runs = await t.pool.query<{ purpose: string; n: number }>(
      "select purpose, count(*)::int as n from ai_runs group by purpose order by purpose",
    );
    expect(runs.rows.map((r) => r.purpose)).toContain("transcribe_offer_image");
    // nothing was applied: the lender row (if any) is untouched and no offer exists yet
    const offers = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from offers where client_id = $1",
      [client],
    );
    expect(offers.rows[0]?.n).toBe(0);
  });

  it("refuses an unreadable image, a wrong file type, and a non-manager", async () => {
    const blurry: Transcriber = async (img, model) => ({
      result: { transcript: "", legible: false, looks_like: "other" },
      model,
      inputTokens: 100,
      outputTokens: 5,
      inputHash: imageHash(img.bytes),
    });
    await expect(
      importOfferImage({
        db: t.db,
        userId: manager,
        input: { dealId, bytes: png(), mediaType: "image/png", filename: "blur.png" },
        transcriber: blurry,
      }),
    ).rejects.toThrow(/not readable enough/);
    await expect(
      importOfferImage({
        db: t.db,
        userId: manager,
        input: { dealId, bytes: png(), mediaType: "application/pdf", filename: "x.pdf" },
        transcriber: blurry,
      }),
    ).rejects.toThrow(/PNG, JPEG/);
    const nope: Transcriber = async () => {
      throw new Error("should not run");
    };
    // the rep can see the deal, but the pasted path is manager-only (CAN.editOffers) at the action layer;
    // here the library refuses a deal outside the view — a stranger's id never resolves
    await expect(
      importOfferImage({
        db: t.db,
        userId: rep,
        input: {
          dealId: "00000000-0000-0000-0000-000000000000",
          bytes: png(),
          mediaType: "image/png",
          filename: "x.png",
        },
        transcriber: nope,
      }),
    ).rejects.toThrow(/isn't in your view/);
  });
});
