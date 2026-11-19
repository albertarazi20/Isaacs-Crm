import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfferView } from "@/components/offers/OfferView";
import { offerGreetingName, offerSchema } from "@/lib/offers/terms";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Review fixes for merchant offers, each read back from the DATABASE or the rendered page: the merchant sees the final
 * payment, cents agree everywhere, a new offer retires the old one, the greeting is never a bare "Dr.", and a
 * filename guess does not count as a document on file.
 */

let t: TestDb;
let rita: string;
let mutations: typeof import("@/lib/offers/mutations");
let system: typeof import("@/lib/system/offers");
let db: typeof import("@/lib/db").db;

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];
const one = async <T>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0]!;
const ctx = () => ({ userId: rita, now: new Date(), appUrl: "https://crm.example.com" });
const input = (clientId: string, over: Record<string, unknown> = {}) =>
  offerSchema.parse({
    clientId,
    funded: "80850",
    factorRate: "1.35",
    frequency: "weekly",
    payments: "26",
    expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    message: "",
    ...over,
  });
let seq = 0;
const merchant = async (contact: string) =>
  (
    await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, $2, $3, $4, $5, 'NY') returning id",
      [
        rita,
        `Shop ${++seq}`,
        contact,
        `31055501${String(seq).padStart(2, "0")}`,
        `s${seq}@shop.com`,
      ],
    )
  ).id;
const make = (clientId: string, over: Record<string, unknown> = {}) =>
  db.withUser(rita, (q) => mutations.createOffer(q, input(clientId, over), ctx()));
const statusOf = async (id: string) =>
  (await one<{ status: string }>("select status from merchant_offers where id = $1", [id])).status;
const addDoc = (
  clientId: string,
  kind: string,
  label: { by: string; confidence: number; reason: string },
) =>
  t.pool.query(
    `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source,
                            scan_status, label_by, label_confidence, label_reason)
     values ($1, $2, $3, 'f.pdf', 'application/pdf', 10, $4, $5, 'upload_link', 'clean', $6, $7, $8)`,
    [
      rita,
      clientId,
      kind,
      String(++seq).padStart(64, "0"),
      `k/${seq}`,
      label.by,
      label.confidence,
      label.reason,
    ],
  );

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  rita = await insertUser(t.pool, "rita@x.com");
  mutations = await import("@/lib/offers/mutations");
  system = await import("@/lib/system/offers");
  db = (await import("@/lib/db")).db;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the final payment", () => {
  it("is computed (the last payment carries leftover cents) but not shown on the merchant's page", async () => {
    const client = await merchant("Gayle Woods");
    // 26 weekly payments of a payback that does not divide evenly
    const made = await make(client, { funded: "80850.50", send: false });
    const page = (await system.openOffer(made.token))!;
    expect(page.paymentCents).toBe(419_800);
    expect(page.finalPaymentCents).toBe(419_818);
    expect(page.finalPaymentCents * 1 + page.paymentCents * 25).toBe(page.paybackCents);
    const render = (p: typeof page) =>
      renderToStaticMarkup(
        createElement(OfferView, {
          offer: p,
          token: made.token,
          preview: true,
          serverNow: Date.now(),
        }),
      );
    const html = render(page);
    // the owner asked for the merchant's page to carry no "Final payment" line (2026-11-18): the remainder is in the
    // contract, the page shows the weekly payment and the total payback
    expect(html).not.toContain("Final payment");
    expect(html).toContain("$4,198"); // the regular payment, cents only when there are some
    // an even split has no extra row
    const even = await make(client, {
      funded: "10000",
      factorRate: "1.5",
      payments: "10",
      send: false,
    });
    const evenPage = (await system.openOffer(even.token))!;
    expect(evenPage.finalPaymentCents).toBe(evenPage.paymentCents);
    expect(render(evenPage)).not.toContain("Final payment");
  });
});

describe("cents agree everywhere", () => {
  it("the email, the timeline, the opened and accepted alerts and the withdrawal all say $80,850.50", async () => {
    const client = await merchant("Gayle Woods");
    const made = await make(client, { funded: "80850.50" });
    const o = await one<{ outbox_id: string }>(
      "select outbox_id from merchant_offers where id = $1",
      [made.offerId],
    );
    const mail = await one<{ html_body: string; text_body: string }>(
      "select html_body, text_body from outbox where id = $1",
      [o.outbox_id],
    );
    for (const part of [mail.html_body, mail.text_body]) {
      expect(part).toContain("$80,850.50");
      expect(part).not.toContain("$80,851");
    }
    // the hero and the hidden preview line both carry it
    expect(mail.html_body.match(/\$80,850\.50/g)!.length).toBeGreaterThanOrEqual(2);
    const bodies = async () =>
      (
        await rows<{ body: string }>(
          "select body from activities where client_id = $1 and kind = 'system' order by created_at, id",
          [client],
        )
      ).map((r) => r.body);
    expect((await bodies()).join("\n")).toContain("Offer emailed: $80,850.50 ·");

    await system.recordOfferView(made.token, db);
    expect((await bodies()).join("\n")).toContain("Opened the offer of $80,850.50");
    const alert = await one<{ body: string }>(
      "select body from user_alerts where client_id = $1 and kind = 'offer_opened'",
      [client],
    );
    expect(alert.body).toContain("$80,850.50.");

    // withdraw one, accept another
    const second = await make(client, { funded: "60000.25", send: false });
    expect((await bodies()).join("\n")).toContain(
      "Earlier offer of $80,850.50 withdrawn: replaced by a new offer",
    );
    await db.withUser(rita, (q) => mutations.withdrawOffer(q, second.offerId, ctx()));
    expect((await bodies()).join("\n")).toContain("Offer of $60,000.25 withdrawn");

    const third = await make(client, {
      funded: "70000.75",
      docs: ["drivers_license"],
      send: false,
    });
    await addDoc(client, "drivers_license", { by: "human", confidence: 1, reason: "set by staff" });
    await system.acceptOffer(third.token, { name: "Gayle", email: "", ip: "1.1.1.1" });
    expect((await bodies()).join("\n")).toContain("Accepted the offer: $70,000.75 at factor");
    const acc = await one<{ body: string }>(
      "select body from user_alerts where client_id = $1 and kind = 'offer_accepted'",
      [client],
    );
    expect(acc.body).toContain("$70,000.75.");
  });
});

describe("a new offer replaces the old one", () => {
  it("withdraws the merchant's earlier open offer in the same step, takes back its unsent email, and notes it", async () => {
    const client = await merchant("Gayle Woods");
    const other = await merchant("Sam Roe");
    const first = await make(client, { funded: "50000" });
    const bystander = await make(other, { funded: "50000" });
    const firstRow = await one<{ outbox_id: string }>(
      "select outbox_id from merchant_offers where id = $1",
      [first.offerId],
    );
    const second = await make(client, { funded: "55000" });

    expect(await statusOf(first.offerId)).toBe("withdrawn");
    expect(
      (
        await one<{ withdrawn_at: string | null }>(
          "select withdrawn_at from merchant_offers where id = $1",
          [first.offerId],
        )
      ).withdrawn_at,
    ).not.toBeNull();
    expect(await statusOf(second.offerId)).toBe("sent");
    // another merchant's offer is not touched
    expect(await statusOf(bystander.offerId)).toBe("sent");
    // the old email never goes; the new one is queued
    expect(
      await one("select status, skip_reason from outbox where id = $1", [firstRow.outbox_id]),
    ).toEqual({ status: "cancelled", skip_reason: "offer_withdrawn" });
    const secondRow = await one<{ outbox_id: string }>(
      "select outbox_id from merchant_offers where id = $1",
      [second.offerId],
    );
    expect(
      (
        await one<{ status: string }>("select status from outbox where id = $1", [
          secondRow.outbox_id,
        ])
      ).status,
    ).toBe("queued");
    // the old link shows the withdrawn state and cannot be accepted; the new one stands
    expect((await system.openOffer(first.token))!.state).toBe("withdrawn");
    await expect(system.acceptOffer(first.token, { name: "", email: "", ip: "" })).rejects.toThrow(
      /no longer available/,
    );
    expect((await system.openOffer(second.token))!.state).toBe("open");
    const note = await rows<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Earlier offer%'",
      [client],
    );
    expect(note.map((n) => n.body)).toEqual([
      "Earlier offer of $50,000 withdrawn: replaced by a new offer",
    ]);
  });

  it("leaves an accepted offer and an already expired one as they are", async () => {
    const client = await merchant("Gayle Woods");
    const accepted = await make(client, { docs: ["drivers_license"], send: false });
    await addDoc(client, "drivers_license", { by: "human", confidence: 1, reason: "set by staff" });
    await system.acceptOffer(accepted.token, { name: "G", email: "", ip: "1" });
    const lapsed = await make(client, { send: false });
    await t.pool.query(
      "update merchant_offers set expires_at = now() - interval '1 minute', created_at = now() - interval '3 days' where id = $1",
      [lapsed.offerId],
    );
    await make(client, { send: false });
    expect(await statusOf(accepted.offerId)).toBe("accepted");
    expect(await statusOf(lapsed.offerId)).toBe("sent");
    expect((await system.openOffer(lapsed.token))!.state).toBe("expired");
  });

  it("a refused offer (no such merchant) retires nothing", async () => {
    const client = await merchant("Gayle Woods");
    const first = await make(client, { send: false });
    await expect(
      db.withUser(rita, (q) =>
        mutations.createOffer(q, input("00000000-0000-4000-8000-000000000000"), ctx()),
      ),
    ).rejects.toThrow(/isn't in your view/);
    expect(await statusOf(first.offerId)).toBe("sent");
  });
});

describe("the greeting", () => {
  it("is the merchant's real name, never a bare honorific", async () => {
    expect(offerGreetingName("Dr. Gayle Woods")).toBe("Dr. Woods");
    expect(offerGreetingName("gayle woods")).toBe("Gayle");
    expect(offerGreetingName("Gayle Woods")).toBe("Gayle");
    expect(offerGreetingName("Dr.")).toBe("");
    expect(offerGreetingName("  ")).toBe("");

    const client = await merchant("Dr. Gayle Woods");
    const made = await make(client);
    const o = await one<{ outbox_id: string }>(
      "select outbox_id from merchant_offers where id = $1",
      [made.offerId],
    );
    const mail = await one<{ text_body: string; html_body: string }>(
      "select text_body, html_body from outbox where id = $1",
      [o.outbox_id],
    );
    expect(mail.text_body.startsWith("Hi Dr. Woods,")).toBe(true);
    expect(mail.html_body).toContain("Hi Dr. Woods,");
    expect((await system.openOffer(made.token))!.firstName).toBe("Dr. Woods");

    const bare = await make(await merchant("Dr."), { send: false });
    expect((await system.openOffer(bare.token))!.firstName).toBe("");
  });
});

describe("documents on file", () => {
  const guess = { by: "rule", confidence: 0.35, reason: "looks like a license from the filename" };

  it("a low-confidence guess is not on file: the page asks for it and accepting is refused", async () => {
    const client = await merchant("Gayle Woods");
    const made = await make(client, { docs: ["drivers_license"], send: false });
    await addDoc(client, "drivers_license", guess);
    const page = (await system.openOffer(made.token))!;
    expect(page.docs.map((d) => [d.kind, d.onFile])).toEqual([["drivers_license", false]]);
    expect(page.uploadToken).not.toBeNull();
    expect(await system.offerDocs(made.token)).toEqual([]);
    await expect(system.acceptOffer(made.token, { name: "", email: "", ip: "" })).rejects.toThrow(
      /Upload your driver's license first/,
    );
    expect(await statusOf(made.offerId)).toBe("sent");
  });

  it("an AI label counts from 0.8, not below", async () => {
    const client = await merchant("Gayle Woods");
    const made = await make(client, { docs: ["drivers_license", "voided_check"], send: false });
    await addDoc(client, "drivers_license", { by: "ai", confidence: 0.79, reason: "read" });
    await addDoc(client, "voided_check", { by: "ai", confidence: 0.8, reason: "read" });
    expect(await system.offerDocs(made.token)).toEqual(["voided_check"]);
  });

  it("a person's label, and a file sent into the offer page's own slot, count", async () => {
    const client = await merchant("Gayle Woods");
    const made = await make(client, { docs: ["drivers_license", "voided_check"], send: false });
    await addDoc(client, "drivers_license", { by: "human", confidence: 1, reason: "set by staff" });
    await addDoc(client, "voided_check", {
      by: "rule",
      confidence: 0.7,
      reason: "chosen by the merchant on the offer page",
    });
    expect((await system.offerDocs(made.token))!.sort()).toEqual([
      "drivers_license",
      "voided_check",
    ]);
    const done = await system.acceptOffer(made.token, { name: "G", email: "", ip: "1" });
    expect(done.already).toBeUndefined();
    expect(await statusOf(made.offerId)).toBe("accepted");
  });

  it("a file really uploaded through the offer page's session is on file", async () => {
    const { acceptUpload } = await import("@/lib/docs/upload");
    const store = new Map<string, Uint8Array>();
    const blob = {
      put: async (k: string, b: Uint8Array) => void store.set(k, b),
      get: async () => null,
      delete: async (k: string) => void store.delete(k),
    } as unknown as Parameters<typeof acceptUpload>[1];
    const client = await merchant("Gayle Woods");
    const made = await make(client, { docs: ["voided_check"], send: false });
    const session = (await system.openOffer(made.token))!.uploadToken!;
    await acceptUpload(db, blob, {
      token: session,
      filename: "IMG_0001.png",
      contentType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 77]),
      today: t.today,
      kind: "voided_check",
    });
    expect(await system.offerDocs(made.token)).toEqual(["voided_check"]);
  });
});
