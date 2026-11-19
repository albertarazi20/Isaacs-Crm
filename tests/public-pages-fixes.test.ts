/**
 * Fixes on the merchant-facing pages (offer, upload, apply): each test reads the DATABASE or the stored blob back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applicationPdf, pdfText, signApplication } from "@/lib/docs/apply";
import { clientIp } from "@/lib/docs/clientIp";
import { type BlobStore, keyName, LocalStore } from "@/lib/docs/storage";
import { acceptUpload, mintUploadSession, scanPending } from "@/lib/docs/upload";
import { instantMs, timeLeft } from "@/lib/offers/terms";
import { notifyOfferAccepted, retryOfferNotices } from "@/lib/system/offerNotice";
import { acceptOffer, offerState, openOffer } from "@/lib/system/offers";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

const pdf = (text: string) =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj << >> endobj\n% ${text}\n%%EOF\n`);

let t: TestDb;
let dir: string;
let store: LocalStore;
let rep: string;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows[0] as T;
const newClient = async (name: string) =>
  (
    await one<{ id: string }>(
      "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, $2, 'Pat Doe', '3055550141', 'pat@x.com') returning id",
      [rep, name],
    )
  ).id;

beforeAll(async () => {
  t = await createTestDb();
  dir = mkdtempSync(join(tmpdir(), "pubfix-"));
  store = new LocalStore(dir);
  rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
});
afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("file names with spaces", () => {
  it("keyName always passes the key check", () => {
    expect(keyName("Bank Statement Oct.pdf")).toBe("Bank_Statement_Oct.pdf");
    expect(keyName("report..pdf")).toBe("report.pdf");
    expect(keyName("Screenshot 2026-11-18 at 10.32.11 AM.png")).toBe(
      "Screenshot_2026-11-18_at_10.32.11_AM.png",
    );
  });

  it("a merchant can upload 'Voided Check.pdf': the row and the blob exist", async () => {
    const client = await newClient("Spacey Diner");
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    const r = await acceptUpload(t.db, store, {
      token,
      filename: "Voided Check..pdf",
      contentType: "application/pdf",
      bytes: pdf("space"),
      today: t.today,
    });
    const d = await one<{ filename: string; storage_key: string }>(
      "select filename, storage_key from documents where id = $1",
      [r.documentId],
    );
    expect(d.filename).toBe("Voided Check..pdf");
    expect(await store.get(d.storage_key)).not.toBeNull();
  });
});

describe("the upload cap", () => {
  it("parallel uploads cannot pass max_files", async () => {
    const client = await newClient("Parallel Pizza");
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    await t.pool.query("update upload_sessions set max_files = 2 where token = $1", [token]);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        acceptUpload(t.db, store, {
          token,
          filename: `f${i}.pdf`,
          contentType: "application/pdf",
          bytes: pdf(`distinct ${i}`),
          today: t.today,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const n = await one<{ n: number }>(
      "select count(*)::int as n from documents where client_id = $1",
      [client],
    );
    expect(n.n).toBe(2);
    expect(
      (
        await one<{ f: number }>(
          "select files_received as f from upload_sessions where token = $1",
          [token],
        )
      ).f,
    ).toBe(2);
  });
});

describe("scanPending", () => {
  it("one unreadable file does not undo the others and stays pending", async () => {
    const client = await newClient("Scan Cafe");
    const { token } = await t.db.withSystem((q) => mintUploadSession(q, { clientId: client }));
    const a = await acceptUpload(t.db, store, {
      token,
      filename: "a.pdf",
      contentType: "application/pdf",
      bytes: pdf("aaa"),
      today: t.today,
    });
    const b = await acceptUpload(t.db, store, {
      token,
      filename: "b.pdf",
      contentType: "application/pdf",
      bytes: pdf("bbb"),
      today: t.today,
    });
    const badKey = (
      await one<{ storage_key: string }>("select storage_key from documents where id = $1", [
        a.documentId,
      ])
    ).storage_key;
    const flaky: BlobStore = {
      kind: "local",
      put: (k, b2, c) => store.put(k, b2, c),
      delete: (k) => store.delete(k),
      get: async (k) => {
        if (k === badKey) throw new Error("storage get failed: 503");
        return store.get(k);
      },
    };
    const out = await scanPending(t.db, flaky);
    expect(out).toMatchObject({ rejected: 0, errors: 1 });
    expect(out.clean).toBeGreaterThanOrEqual(1);
    const st = await t.pool.query<{ id: string; scan_status: string }>(
      "select id, scan_status from documents where id = any($1)",
      [[a.documentId, b.documentId]],
    );
    const by = Object.fromEntries(st.rows.map((r) => [r.id, r.scan_status]));
    expect(by[a.documentId]).toBe("pending");
    expect(by[b.documentId]).toBe("clean");
  });
});

describe("rep notices for accepted offers", () => {
  const offerFor = async (client: string, kind: string, scan: "pending" | "clean", n: number) => {
    await t.pool.query(
      `insert into documents (user_id, client_id, kind, filename, content_type, size_bytes, sha256, storage_key, source, scan_status,
                              label_by, label_confidence, label_reason)
       values ($1, $2, $3, 'f.pdf', 'application/pdf', 10, $4, $5, 'upload_link', $6,
               'rule', 0.7, 'chosen by the merchant on the offer page')`,
      [rep, client, kind, `${n}`.padStart(64, "0"), `k/${n}`, scan],
    );
    const o = await one<{ id: string; token: string }>(
      `insert into merchant_offers (client_id, user_id, funded_cents, factor_rate, frequency, payments, expires_at, docs)
       values ($1, $2, 5000000, 1.3, 'weekly', 26, now() + interval '2 days', array[$3]::text[]) returning id, token`,
      [client, rep, kind],
    );
    await acceptOffer(o.token, { name: "Pat Doe", email: "", ip: "1.1.1.1" }, t.db);
    return o.id;
  };

  it("offers blocked on a pending scan do not hog the retry queue", async () => {
    const blocked: string[] = [];
    for (let i = 0; i < 3; i++)
      blocked.push(
        await offerFor(await newClient(`Blocked ${i}`), "voided_check", "pending", 10 + i),
      );
    const ready = await offerFor(await newClient("Ready Co"), "voided_check", "clean", 20);
    const sentTo: string[] = [];
    const memory: BlobStore = {
      kind: "local",
      put: async () => undefined,
      delete: async () => undefined,
      get: async () => ({ bytes: pdf("x"), contentType: "application/pdf" }),
    };
    const r = await retryOfferNotices({
      store: memory,
      senders: {
        gmail: async (userId) => void sentTo.push(userId),
        resend: null,
      },
      appUrl: "https://crm.example.com",
      db: t.db,
    });
    expect(r.sent).toBe(1);
    expect(sentTo).toHaveLength(1);
    const done = await t.pool.query<{ id: string; done: boolean; attempts: number }>(
      "select id, accept_notified_at is not null as done, accept_notice_attempts as attempts from merchant_offers where id = any($1)",
      [[...blocked, ready]],
    );
    const by = Object.fromEntries(done.rows.map((x) => [x.id, x]));
    expect(by[ready]!.done).toBe(true);
    for (const id of blocked) expect(by[id]).toMatchObject({ done: false, attempts: 0 });
    // and a direct notify on a blocked one still declines
    const direct = await notifyOfferAccepted(blocked[0]!, {
      store: memory,
      senders: { gmail: async () => undefined, resend: null },
      appUrl: "x",
      db: t.db,
    });
    expect(direct.sent).toBe(false);
  });
});

describe("signing the application", () => {
  const FIELDS = {
    legal_business_name: "Café Łódź LLC",
    dba: "",
    owner_name: "Nguyễn Văn Łukasz 🍕",
    title: "Owner",
    phone: "(305) 555-0141",
    email: "dana@x.com",
    address: "12 Pier St",
    city: "Miami",
    state: "fl",
    zip: "33101",
    ein_last4: "4321",
    industry: "Restaurant",
    business_start: "2021-03",
    monthly_revenue_dollars: 62000,
    amount_requested_dollars: 45000,
    use_of_funds: `${"A very long explanation of what the money is for ".repeat(6)}${"x".repeat(100)}`,
    existing_advances: "none",
    consent_email: true,
    consent_sms: false,
    agree: true,
    signer_name: "Łukasz Nguyễn",
  };

  it("pdfText keeps what Helvetica can draw and folds or replaces the rest", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(pdfText("Café Niño", font)).toBe("Café Niño");
    expect(pdfText("Nguyễn", font)).toBe("Nguyen");
    expect(pdfText("Łódź 🍕 Ж", font)).toMatch(/^[^Ł🍕Ж]*$/);
    expect(pdfText("line\none", font)).toBe("line one");
  });

  it("a name outside Latin-1 and a 500-character answer still make a PDF within the page", async () => {
    const bytes = await applicationPdf({
      shopName: "Selective Capital",
      fields: FIELDS as never,
      signedAt: new Date(),
      ip: "1.2.3.4",
      userAgent: "x",
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("signs once: two simultaneous submits make one application, one document, one alert", async () => {
    const client = await newClient("Race LLC");
    const token = (
      await one<{ t: string }>("select application_token as t from clients where id = $1", [client])
    ).t;
    const go = () =>
      signApplication(t.db, store, {
        token,
        fields: FIELDS as never,
        ip: "1.2.3.4",
        userAgent: "x",
        today: t.today,
      });
    const out = await Promise.allSettled([go(), go(), go()]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const o of out)
      if (o.status === "rejected") expect(String(o.reason)).toMatch(/already signed/);
    const n = await one<{ a: number; d: number; al: number }>(
      `select (select count(*) from applications where client_id = $1)::int as a,
              (select count(*) from documents where client_id = $1 and kind = 'signed_application')::int as d,
              (select count(*) from user_alerts where client_id = $1 and kind = 'application_signed')::int as al`,
      [client],
    );
    expect(n).toEqual({ a: 1, d: 1, al: 1 });
  });
});

describe("the offer page's clock and state", () => {
  it("reads Postgres's timestamp text and ISO alike, and never shows NaN", () => {
    const now = Date.parse("2026-11-19T00:00:00Z");
    expect(instantMs("2026-11-19 02:30:00.123456+00")).toBe(Date.parse("2026-11-19T02:30:00.123Z"));
    expect(timeLeft("2026-11-19 02:30:00+00", now)).toBe("2h 30m");
    expect(timeLeft("2026-11-19T02:30:00.000Z", now)).toBe("2h 30m");
    expect(timeLeft("garbage", now)).toBeNull();
  });

  it("the page gets ISO instants, and a refused accept can say withdrawn", async () => {
    const client = await newClient("Withdrawn Deli");
    const o = await one<{ id: string; token: string }>(
      `insert into merchant_offers (client_id, user_id, funded_cents, factor_rate, frequency, payments, expires_at, docs)
       values ($1, $2, 5000000, 1.3, 'weekly', 26, now() + interval '2 days', '{}') returning id, token`,
      [client, rep],
    );
    const page = await openOffer(o.token, { db: t.db });
    expect(page!.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await offerState(o.token, t.db)).toBe("open");
    await t.pool.query(
      "update merchant_offers set status = 'withdrawn', withdrawn_at = now() where id = $1",
      [o.id],
    );
    await expect(acceptOffer(o.token, { name: "", email: "", ip: "" }, t.db)).rejects.toThrow(
      /no longer available/,
    );
    expect(await offerState(o.token, t.db)).toBe("withdrawn");
  });
});

describe("the address on a signature", () => {
  it("prefers the platform's header and never trusts the client's first forwarded entry", () => {
    expect(
      clientIp(
        new Headers({ "x-nf-client-connection-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" }),
      ),
    ).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }))).toBe("7.7.7.7");
    expect(clientIp(new Headers())).toBe("");
  });
});
