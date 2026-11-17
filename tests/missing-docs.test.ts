import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueBlast } from "@/lib/buckets/engine";
import { getMessagingContext } from "@/lib/messaging/queries";
import { missingDocsPhrase } from "@/lib/mca/stips";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * The {missing_docs} merge field: what a merchant still owes, in the words an email uses. The phrase is pure; the
 * queued email and the composer's context are read back from the DATABASE.
 */

describe("missingDocsPhrase", () => {
  it.each([
    [[], ""],
    [[{ kind: "signed_application", period: null }], "the signed application"],
    [[{ kind: "bank_statement", period: "2026-09-01" }], "your September bank statement"],
    [
      [
        { kind: "bank_statement", period: "2026-10-01" },
        { kind: "bank_statement", period: "2026-09-01" },
      ],
      "your September and October bank statements",
    ],
    [
      [
        { kind: "voided_check", period: null },
        { kind: "bank_statement", period: "2026-08-01" },
        { kind: "signed_application", period: null },
        { kind: "bank_statement", period: "2026-09-01" },
        { kind: "drivers_license", period: null },
      ],
      "the signed application, your August and September bank statements, a photo of your driver's license and a voided check",
    ],
    [
      [
        { kind: "bank_statement", period: "2026-01-01" },
        { kind: "bank_statement", period: "2025-12-01" },
      ],
      "your December 2025 and January 2026 bank statements",
    ],
    [[{ kind: "bank_statement", period: null }], "your recent bank statements"],
    [[{ kind: "other", period: null }], ""],
  ] as const)("%j", (missing, want) => {
    expect(missingDocsPhrase(missing)).toBe(want);
  });
});

describe("{missing_docs} in an email (database)", () => {
  let t: TestDb;
  let rep: string;
  let tpl: string;
  const APP = "https://crm.example.com";
  let phone = 3055550900;
  const merchant = async (name: string) => {
    phone += 1;
    return (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, 'Dana Cole', $3, $4, 'FL') returning id",
        [rep, name, String(phone), `d${phone}@shop.com`],
      )
    ).rows[0]!.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    tpl = (
      await t.pool.query<{ id: string }>(
        `insert into templates (owner_id, name, subject, body, approved)
         values (null, 'What is left', 'Almost there, {first_name}', 'Hi {first_name}, we still need {missing_docs}. {upload_link}', true)
         returning id`,
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await t.drop();
  });

  it("names exactly what this merchant still owes, and the composer gets the same words", async () => {
    const id = await merchant("Owes Two Co");
    await t.db.withUser(rep, (q) =>
      q.query("select add_stips($1, $2::jsonb)", [
        id,
        JSON.stringify([
          { kind: "signed_application", period: null, required: true },
          { kind: "bank_statement", period: "2026-10-01", required: true },
          { kind: "voided_check", period: null, required: true },
        ]),
      ]),
    );
    await t.pool.query(
      "update stips set received_at = now() where client_id = $1 and kind = 'signed_application'",
      [id],
    );
    const r = await t.db.withUser(rep, (q) =>
      queueBlast(q, { templateId: tpl, clientIds: [id], appUrl: APP }),
    );
    expect(r.queued).toBe(1);
    const row = await t.pool.query<{ text_body: string }>(
      "select text_body from outbox where client_id = $1 and lane = 'blast'",
      [id],
    );
    expect(row.rows[0]!.text_body).toContain(
      "we still need your October bank statement and a voided check.",
    );
    const ctx = await t.db.withUser(rep, (q) => getMessagingContext(q, id));
    expect(ctx.missingDocs).toBe("your October bank statement and a voided check");
  });

  it("a merchant who owes nothing is skipped, never sent a blank", async () => {
    const id = await merchant("Owes Nothing Co");
    const r = await t.db.withUser(rep, (q) =>
      queueBlast(q, { templateId: tpl, clientIds: [id], appUrl: APP }),
    );
    expect(r.queued).toBe(0);
    expect(r.skipped[0]!.reason).toMatch(/missing_docs/);
    const rows = await t.pool.query("select 1 from outbox where client_id = $1", [id]);
    expect(rows.rowCount).toBe(0);
  });
});
