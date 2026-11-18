import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeTerms, offerSchema } from "@/lib/offers/terms";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

/**
 * Merchant offers (0555), read back from the DATABASE: the database's arithmetic agrees with the form's, an offer is
 * made only for a merchant the rep can see, its email is queued from the rep with the designed HTML, withdrawing it
 * takes the email back and cannot be undone, the merchant's page counts their first open (and tells the rep) but
 * not a rep's preview, accepting needs the documents on file, tells the rep, stops the approval's emails, and holds
 * once done; an expired or withdrawn offer cannot be accepted.
 */

let t: TestDb;
let rita: string;
let omar: string;
let ritaMerchant: string;
let mutations: typeof import("@/lib/offers/mutations");
let queries: typeof import("@/lib/offers/queries");
let system: typeof import("@/lib/system/offers");
let db: typeof import("@/lib/db").db;

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as T[];
const one = async <T>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0]!;
const ctx = (userId: string) => ({ userId, now: new Date(), appUrl: "https://crm.example.com" });
const input = (over: Record<string, unknown> = {}) =>
  offerSchema.parse({
    clientId: ritaMerchant,
    funded: "80850",
    factorRate: "1.35",
    frequency: "weekly",
    payments: "26",
    expiresAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    message: "Great speaking with you.",
    ...over,
  });
let docSeq = 0;
const addDoc = (clientId: string, userId: string, kind: string) =>
  t.pool.query(
    `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status)
     values ($1, $2, $3, 'f.pdf', 'application/pdf', 10, $4, $5, 'upload_link', 'clean')`,
    [userId, clientId, kind, String(++docSeq).padStart(64, "0"), `k/${docSeq}`],
  );

beforeAll(async () => {
  t = await createTestDb();
  const url = new URL(
    (t.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  );
  process.env.DATABASE_URL = url.toString();
  rita = await insertUser(t.pool, "rita@x.com");
  omar = await insertUser(t.pool, "omar@x.com");
  await t.pool.query(
    "update app_users set name = 'Rita Rep', phone = '+13055550100' where id = $1",
    [rita],
  );
  ritaMerchant = (
    await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email, state) values ($1, 'Winchester Creek Farm', 'Gayle Woods', '3105550199', 'gayle@farm.com', 'NY') returning id",
      [rita],
    )
  ).id;
  mutations = await import("@/lib/offers/mutations");
  queries = await import("@/lib/offers/queries");
  system = await import("@/lib/system/offers");
  db = (await import("@/lib/db")).db;
});
afterAll(async () => {
  const g = globalThis as unknown as { __isaacPool?: { end(): Promise<void> } };
  await g.__isaacPool?.end();
  await t.drop();
});

describe("the database's arithmetic", () => {
  it("is the form's, to the cent", async () => {
    const cases = [
      [8_085_000, 1.5, 127],
      [8_085_000, 1.35, 26],
      [10_000_001, 1.499, 7],
      [123_456, 1.001, 3],
      [999_999_99, 2.5, 1000],
      [5_000_000, 1.275, 60],
    ] as const;
    for (const [funded, factor, payments] of cases) {
      const r = await one<{ payback: string; payment: string }>(
        `insert into merchant_offers (client_id, user_id, funded_cents, factor_rate, frequency, payments, expires_at)
         values ($1, $2, $3, $4, 'weekly', $5, now() + interval '1 day')
         returning payback_cents::text as payback, payment_cents::text as payment`,
        [ritaMerchant, rita, funded, factor, payments],
      );
      const js = computeTerms({ fundedCents: funded, factorRate: factor, payments });
      expect([Number(r.payback), Number(r.payment)], `${funded} × ${factor} / ${payments}`).toEqual(
        [js.paybackCents, js.paymentCents],
      );
    }
    await t.pool.query("delete from merchant_offers");
  });
});

describe("making an offer", () => {
  let offerId: string;
  let token: string;

  it("only for a merchant the rep can see", async () => {
    await expect(
      db.withUser(omar, (q) => mutations.createOffer(q, input(), ctx(omar))),
    ).rejects.toThrow(/isn't in your view/);
    expect(await rows("select 1 from merchant_offers")).toHaveLength(0);
  });

  it("stores the terms, queues the email from the rep with the designed page, and notes it on the timeline", async () => {
    const made = await db.withUser(rita, (q) => mutations.createOffer(q, input(), ctx(rita)));
    offerId = made.offerId;
    token = made.token;
    expect(made.url).toBe(`https://crm.example.com/offer/${made.token}`);
    expect(made.token).toMatch(/^[a-f0-9]{64}$/);
    expect(made.email).toMatchObject({ queued: true });
    const o = await one<Record<string, unknown>>("select * from merchant_offers where id = $1", [
      offerId,
    ]);
    expect(o).toMatchObject({
      user_id: rita,
      status: "sent",
      payments: 26,
      frequency: "weekly",
      message: "Great speaking with you.",
      docs: ["drivers_license", "voided_check"],
    });
    expect(Number(o.funded_cents)).toBe(8_085_000);
    expect(Number(o.payment_cents)).toBe(419_798);
    const mail = await one<Record<string, string>>(
      "select lane, source, to_address, subject, text_body, html_body, user_id, status from outbox where id = $1",
      [o.outbox_id],
    );
    expect(mail).toMatchObject({
      lane: "reply",
      source: `offer:${offerId}`,
      to_address: "gayle@farm.com",
      user_id: rita,
      status: "queued",
      subject: "Your funding offer for Winchester Creek Farm is ready",
    });
    expect(mail.html_body).toContain(`/offer/${token}`);
    expect(mail.text_body).toContain("$4,197.98");
    expect(mail.text_body).toContain("final payment $4,198");
    const line = await one<{ body: string }>(
      "select body from activities where client_id = $1 and body like 'Offer emailed%'",
      [ritaMerchant],
    );
    expect(line.body).toContain("$80,850 · factor 1.350 · 26 weekly payments of $4,197.98");
  });

  it("shows on the merchant's page for whoever can see them, not for another rep", async () => {
    const mine = await db.withUser(rita, (q) => queries.listOffers(q, ritaMerchant));
    expect(mine.map((o) => [o.state, o.payment_cents, o.email_status])).toEqual([
      ["sent", 419_798, "queued"],
    ]);
    expect(await db.withUser(omar, (q) => queries.listOffers(q, ritaMerchant))).toHaveLength(0);
  });

  it("can be made without an email: the rep sends the link", async () => {
    const made = await db.withUser(rita, (q) =>
      mutations.createOffer(q, input({ send: false, funded: "50000" }), ctx(rita)),
    );
    expect(made.email).toBeNull();
    expect(
      (
        await one<{ outbox_id: string | null }>(
          "select outbox_id from merchant_offers where id = $1",
          [made.offerId],
        )
      ).outbox_id,
    ).toBeNull();
    // keep the tests below about the first offer
    await t.pool.query("delete from merchant_offers where id = $1", [made.offerId]);
  });

  it("opening the page changes nothing (a mail scanner fetches links first); the page's own beacon counts the open", async () => {
    const page = await system.openOffer(token);
    expect(page).toMatchObject({
      state: "open",
      businessName: "Winchester Creek Farm",
      firstName: "Gayle",
      repName: "Rita Rep",
      repPhone: "+13055550100",
      fundedCents: 8_085_000,
      paymentCents: 419_798,
      finalPaymentCents: 419_800,
      paybackCents: 10_914_750,
    });
    expect(page!.docs.map((d) => [d.kind, d.onFile])).toEqual([
      ["drivers_license", false],
      ["voided_check", false],
    ]);
    expect(
      (await one<{ views: number }>("select views from merchant_offers where id = $1", [offerId]))
        .views,
    ).toBe(0);
    expect(
      await rows("select 1 from user_alerts where client_id = $1", [ritaMerchant]),
    ).toHaveLength(0);
    // the same visitor keeps one upload session, the offer page's own
    const again = await system.openOffer(token);
    expect(again!.uploadToken).toBe(page!.uploadToken);
    const session = await one<{ wanted: { kind: string }[]; purpose: string }>(
      "select wanted, purpose from upload_sessions where token = $1",
      [page!.uploadToken],
    );
    expect(session.purpose).toBe("offer");
    expect(session.wanted.map((w) => w.kind)).toEqual(["drivers_license", "voided_check"]);

    await system.recordOfferView(token);
    await system.recordOfferView(token);
    const o = await one<{ views: number; first: boolean }>(
      "select views, first_viewed_at is not null as first from merchant_offers where id = $1",
      [offerId],
    );
    expect(o).toEqual({ views: 2, first: true });
    expect(
      await rows<{ kind: string; user_id: string }>(
        "select kind, user_id from user_alerts where client_id = $1",
        [ritaMerchant],
      ),
    ).toEqual([{ kind: "offer_opened", user_id: rita }]);
  });

  it("the merchant's everyday upload link never picks up the offer's session", async () => {
    const { openUploadPage } = await import("@/lib/docs/upload");
    const permanent = (
      await one<{ upload_token: string }>("select upload_token from clients where id = $1", [
        ritaMerchant,
      ])
    ).upload_token;
    const everyday = await openUploadPage(db, permanent, t.today);
    expect(everyday!.purpose).not.toBe("offer");
    const offerSession = (await system.openOffer(token))!.uploadToken;
    expect(everyday!.token).not.toBe(offerSession);
  });

  it("a token that is not an offer opens nothing", async () => {
    expect(await system.openOffer("0".repeat(64))).toBeNull();
    expect(await system.openOffer("not-a-token")).toBeNull();
  });

  it("only the offer page's slots name a file's kind, and a merchant's pick is a label to check", async () => {
    const { acceptUpload } = await import("@/lib/docs/upload");
    const store = new Map<string, Uint8Array>();
    const blob = {
      put: async (k: string, b: Uint8Array) => void store.set(k, b),
      get: async (k: string) =>
        store.has(k) ? { bytes: store.get(k)!, contentType: "image/png" } : null,
      delete: async (k: string) => void store.delete(k),
    } as unknown as Parameters<typeof acceptUpload>[1];
    const png = (n: number) =>
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);
    // an everyday link: the kind is ignored, the file is read for what it is
    const permanent = (
      await one<{ upload_token: string }>("select upload_token from clients where id = $1", [
        ritaMerchant,
      ])
    ).upload_token;
    const { openUploadPage } = await import("@/lib/docs/upload");
    const everyday = (await openUploadPage(db, permanent, t.today))!.token;
    const plain = await acceptUpload(db, blob, {
      token: everyday,
      filename: "photo.png",
      contentType: "image/png",
      bytes: png(1),
      today: t.today,
      kind: "voided_check",
    });
    expect(plain.kind).not.toBe("voided_check");
    // the offer page: the slot's kind, as a rule label under the review line
    const offerSession = (await system.openOffer(token))!.uploadToken!;
    const slot = await acceptUpload(db, blob, {
      token: offerSession,
      filename: "photo2.png",
      contentType: "image/png",
      bytes: png(2),
      today: t.today,
      kind: "voided_check",
    });
    expect(slot.kind).toBe("voided_check");
    const d = await one<{ label_by: string; label_confidence: number; label_reason: string }>(
      "select label_by, label_confidence, label_reason from documents where id = $1",
      [slot.documentId],
    );
    expect(d).toEqual({
      label_by: "rule",
      label_confidence: 0.7,
      label_reason: "chosen by the merchant on the offer page",
    });
    // the same file sent for the other slot is refused with words, not shown as done
    await expect(
      acceptUpload(db, blob, {
        token: offerSession,
        filename: "photo2.png",
        contentType: "image/png",
        bytes: png(2),
        today: t.today,
        kind: "drivers_license",
      }),
    ).rejects.toThrow(/already here as your voided check/);
    // an unsorted file sent again for a slot takes the slot's label
    const again = await acceptUpload(db, blob, {
      token: offerSession,
      filename: "photo.png",
      contentType: "image/png",
      bytes: png(1),
      today: t.today,
      kind: "drivers_license",
    });
    if (plain.kind === "other") expect(again.kind).toBe("drivers_license");
    // tidy: these documents are not part of the tests below
    await t.pool.query("delete from documents where client_id = $1", [ritaMerchant]);
  });

  it("accepting needs every document on file", async () => {
    await expect(
      system.acceptOffer(token, { name: "Gayle Woods", email: "", ip: "1.2.3.4" }),
    ).rejects.toThrow(/Upload your driver's license and voided check first/);
    await addDoc(ritaMerchant, rita, "drivers_license");
    await expect(system.acceptOffer(token, { name: "", email: "", ip: "" })).rejects.toThrow(
      /voided check first/,
    );
    expect(
      (await one<{ status: string }>("select status from merchant_offers where id = $1", [offerId]))
        .status,
    ).toBe("sent");
  });

  it("accepts once the documents are in: the rep hears, the timeline says so, an approval's emails stop", async () => {
    const approval = await one<{ id: string }>(
      "insert into approvals (client_id, user_id, amount_cents) values ($1, $2, 8085000) returning id",
      [ritaMerchant, rita],
    );
    await t.pool.query("update merchant_offers set approval_id = $2 where id = $1", [
      offerId,
      approval.id,
    ]);
    await addDoc(ritaMerchant, rita, "voided_check");
    expect((await system.openOffer(token))!.docs.every((d) => d.onFile)).toBe(true);
    const r = await system.acceptOffer(token, {
      name: "Gayle Woods",
      email: "gayle@farm.com",
      ip: "1.2.3.4",
    });
    expect(r.acceptedAt).toBeTruthy();
    const o = await one<Record<string, unknown>>("select * from merchant_offers where id = $1", [
      offerId,
    ]);
    expect(o).toMatchObject({
      status: "accepted",
      accepted_name: "Gayle Woods",
      accepted_email: "gayle@farm.com",
      accepted_ip: "1.2.3.4",
    });
    expect(
      (
        await rows<{ kind: string }>(
          "select kind from user_alerts where client_id = $1 order by id",
          [ritaMerchant],
        )
      ).map((a) => a.kind),
    ).toEqual(["offer_opened", "offer_accepted"]);
    expect(
      (
        await one<{ body: string }>(
          "select body from activities where client_id = $1 and body like 'Accepted the offer%'",
          [ritaMerchant],
        )
      ).body,
    ).toBe("Accepted the offer: $80,850 at factor 1.350, accepted as Gayle Woods");
    expect(
      await one("select emails, emails_note from approvals where id = $1", [approval.id]),
    ).toEqual({ emails: "stopped", emails_note: "offer_accepted" });
    // the page now says accepted, and a second press changes nothing
    expect((await system.openOffer(token))!.state).toBe("accepted");
    await system.acceptOffer(token, { name: "Someone Else", email: "", ip: "" });
    expect(
      (
        await one<{ accepted_name: string }>(
          "select accepted_name from merchant_offers where id = $1",
          [offerId],
        )
      ).accepted_name,
    ).toBe("Gayle Woods");
  });

  it("an accepted offer is final: nothing on it can be changed by the app role", async () => {
    await expect(
      db.withUser(rita, (q) =>
        q.query("update merchant_offers set outbox_id = null where id = $1", [offerId]),
      ),
    ).rejects.toThrow(/already accepted/);
  });

  it("a document behind an accepted offer that fails its check tells the rep", async () => {
    const { scanPending } = await import("@/lib/docs/upload");
    const doc = await one<{ id: string }>(
      "select id from documents where client_id = $1 and kind = 'voided_check'",
      [ritaMerchant],
    );
    await t.pool.query("update documents set scan_status = 'pending' where id = $1", [doc.id]);
    const blob = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as Parameters<typeof scanPending>[1];
    await scanPending(db, blob);
    expect(
      await rows<{ kind: string }>(
        "select kind from user_alerts where client_id = $1 and kind = 'offer_doc_rejected'",
        [ritaMerchant],
      ),
    ).toHaveLength(1);
  });

  it("an accepted offer cannot be withdrawn", async () => {
    await expect(
      db.withUser(rita, (q) => mutations.withdrawOffer(q, offerId, ctx(rita))),
    ).rejects.toThrow(/already accepted or taken back/);
  });
});

describe("withdrawing and expiry", () => {
  it("withdrawing takes the email back, the page says it is gone, and it cannot come back", async () => {
    const made = await db.withUser(rita, (q) => mutations.createOffer(q, input(), ctx(rita)));
    await db.withUser(rita, (q) => mutations.withdrawOffer(q, made.offerId, ctx(rita)));
    const o = await one<{ status: string; outbox_id: string }>(
      "select status, outbox_id from merchant_offers where id = $1",
      [made.offerId],
    );
    expect(o.status).toBe("withdrawn");
    expect(
      await one("select status, skip_reason from outbox where id = $1", [o.outbox_id]),
    ).toEqual({
      status: "cancelled",
      skip_reason: "offer_withdrawn",
    });
    expect((await system.openOffer(made.token))!.state).toBe("withdrawn");
    await expect(system.acceptOffer(made.token, { name: "", email: "", ip: "" })).rejects.toThrow(
      /no longer available/,
    );
    await expect(
      db.withUser(rita, (q) =>
        q.query("update merchant_offers set status = 'sent', withdrawn_at = null where id = $1", [
          made.offerId,
        ]),
      ),
    ).rejects.toThrow(/already withdrawn/);
  });

  it("an offer past its time cannot be accepted, and shows as expired", async () => {
    const made = await db.withUser(rita, (q) =>
      mutations.createOffer(q, input({ send: false }), ctx(rita)),
    );
    await t.pool.query(
      "update merchant_offers set created_at = now() - interval '3 days', expires_at = now() - interval '1 minute' where id = $1",
      [made.offerId],
    );
    const page = await system.openOffer(made.token);
    expect(page).toMatchObject({ state: "expired", uploadToken: null });
    await expect(system.acceptOffer(made.token, { name: "", email: "", ip: "" })).rejects.toThrow(
      /expired/,
    );
    const listed = await db.withUser(rita, (q) => queries.listOffers(q, ritaMerchant));
    expect(listed.find((o) => o.id === made.offerId)!.state).toBe("expired");
  });

  it("a merchant in the trash has no offer page", async () => {
    const made = await db.withUser(rita, (q) =>
      mutations.createOffer(q, input({ send: false }), ctx(rita)),
    );
    await t.pool.query("insert into trashed_clients (client_id, user_id) values ($1, $2)", [
      ritaMerchant,
      rita,
    ]);
    expect(await system.openOffer(made.token)).toBeNull();
    await t.pool.query("delete from trashed_clients where client_id = $1", [ritaMerchant]);
  });

  it("a rep cannot write the merchant's side", async () => {
    const id = (await one<{ id: string }>("select id from merchant_offers limit 1")).id;
    await expect(
      db.withUser(rita, (q) =>
        q.query("update merchant_offers set views = 99 where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withUser(rita, (q) =>
        q.query("update merchant_offers set accepted_name = 'x' where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
