/** The merchant signs their own application in the app (plan §13.5, §7 Documents). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applicationPdf,
  latestApplication,
  openApplicationPage,
  signApplication,
} from "@/lib/docs/apply";
import { applyLink } from "@/lib/docs/applyLink";
import { LocalStore } from "@/lib/docs/storage";
import { createTestDb, insertUser, type TestDb } from "./helpers/db";

// a moment from now, so the signature is newer than anything the setup wrote
const SIGNED = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
const SIGNED_ISO = `${SIGNED.toISOString().slice(0, 19)}Z`;

const FIELDS = {
  legal_business_name: "Harbor Bakery LLC",
  dba: "Harbor Bakery",
  owner_name: "Dana Reyes",
  title: "Owner",
  phone: "(305) 555-0141",
  email: "dana@harborbakery.com",
  address: "12 Pier St",
  city: "Miami",
  state: "fl",
  zip: "33101",
  ein_last4: "4321",
  industry: "Restaurant",
  business_start: "2021-03",
  monthly_revenue_dollars: 62000,
  amount_requested_dollars: 45000,
  use_of_funds: "A second oven before the holidays",
  existing_advances: "none",
  consent_email: true,
  consent_sms: true,
  agree: true,
  signer_name: "Dana Reyes",
};

describe("the in-app application", () => {
  let t: TestDb;
  let dir: string;
  let store: LocalStore;
  let rep: string;
  let client: string;
  let token: string;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "apply-"));
    store = new LocalStore(dir);
    rep = await insertUser(t.pool, "rep@x.com", "America/New_York");
    // a merchant the rep knows little about yet: a name, a phone, no email, no state
    client = (
      await t.pool.query<{ id: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, 'Harbor Bakery', '', '3055550141', '') returning id",
        [rep],
      )
    ).rows[0]!.id;
    await t.pool.query(
      "insert into client_asks (user_id, client_id, wanted_amount_cents) values ($1, $2, 4000000)",
      [rep, client],
    );
    token = (
      await t.pool.query<{ t: string }>(
        "select application_token as t from clients where id = $1",
        [client],
      )
    ).rows[0]!.t;
  });
  afterAll(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the link resolves to the merchant's page, prefilled, and a stranger's token resolves to nothing", async () => {
    const page = await openApplicationPage(t.db, token);
    expect(page).toMatchObject({
      business_name: "Harbor Bakery",
      phone: "3055550141",
      signed_at: null,
    });
    expect(page!.wanted_amount_dollars).toBe(40000);
    expect(await openApplicationPage(t.db, "deadbeef".repeat(6))).toBeNull();
    expect(await openApplicationPage(t.db, "../etc")).toBeNull();
    expect(applyLink("https://crm.test", token)).toBe(`https://crm.test/apply/${token}`);
  });

  it("the PDF carries what was typed and the signature block, and never a full EIN", async () => {
    const bytes = await applicationPdf({
      shopName: "Selective Capital",
      fields: { ...FIELDS, state: "FL" },
      signedAt: new Date("2026-11-16T15:00:00Z"),
      ip: "203.0.113.9",
      userAgent: "Safari",
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    // the page's content streams are deflated and the standard-font text inside is hex-encoded: unpack both
    const content = doc
      .getPages()
      .flatMap((pg) => {
        const c = pg.node.Contents();
        const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
        return refs.map((r) => doc.context.lookup(r));
      })
      .map((s) =>
        s instanceof PDFRawStream
          ? Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")
          : "",
      )
      .join("\n")
      .toLowerCase();
    const hex = (s: string) => Buffer.from(s, "latin1").toString("hex");
    expect(content).toContain(hex("Dana Reyes"));
    expect(content).toContain(hex("***-***4321"));
    expect(content).not.toContain(hex("4321 "));
  });

  it("signing files the PDF as the signed application, ticks the checklist, fills the blanks, alerts the rep and emails the merchant", async () => {
    const out = await signApplication(t.db, store, {
      token,
      fields: FIELDS,
      ip: "203.0.113.9",
      userAgent: "Safari",
      today: t.today,
      now: SIGNED,
    });
    const doc = await t.pool.query<{
      kind: string;
      source: string;
      scan: string;
    }>("select kind, source, scan_status as scan from documents where id = $1", [out.documentId]);
    expect(doc.rows[0]).toMatchObject({
      kind: "signed_application",
      source: "upload_link",
      scan: "clean",
    });
    const stip = await t.pool.query<{ received: boolean }>(
      "select received_at is not null as received from stips where client_id = $1 and kind = 'signed_application'",
      [client],
    );
    expect(stip.rows[0]?.received).toBe(true);
    const app = await t.pool.query<{
      signer: string;
      email_ok: boolean;
      sms_ok: boolean;
      ein: string | null;
      ssn: string | null;
    }>(
      "select signer_name as signer, consent_email as email_ok, consent_sms as sms_ok, fields->>'ein_last4' as ein, fields->>'signer_name' as ssn from applications where id = $1",
      [out.applicationId],
    );
    expect(app.rows[0]).toEqual({
      signer: "Dana Reyes",
      email_ok: true,
      sms_ok: true,
      ein: "4321",
      ssn: null,
    });
    const c = await t.pool.query<{
      contact_name: string;
      email: string;
      state: string;
      industry: string;
      revenue: string;
      months: number;
      sms_src: string;
      app_on: string | null;
      phone: string;
    }>(
      `select contact_name, email, state, industry, monthly_revenue_cents::text as revenue, time_in_business_months as months,
              sms_consent_source as sms_src, application_received_on::text as app_on, phone from clients where id = $1`,
      [client],
    );
    // blanks filled; the phone the rep already had is kept as it was
    expect(c.rows[0]).toMatchObject({
      contact_name: "Dana Reyes",
      email: "dana@harborbakery.com",
      state: "FL",
      industry: "Restaurant",
      revenue: "6200000",
      sms_src: "application",
      phone: "3055550141",
    });
    expect(c.rows[0]?.months).toBeGreaterThan(50);
    expect(c.rows[0]?.app_on).not.toBeNull();
    const act = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from activities where client_id = $1 and body = 'Application signed by Dana Reyes'",
      [client],
    );
    expect(act.rows[0]?.n).toBe(1);
    const alert = await t.pool.query<{ kind: string; title: string }>(
      "select kind, title from user_alerts where user_id = $1 and kind = 'application_signed'",
      [rep],
    );
    expect(alert.rows[0]?.title).toBe("Harbor Bakery LLC signed the application");
    const mail = await t.pool.query<{ lane: string; to: string; subject: string }>(
      "select lane, to_address as to, subject from outbox where client_id = $1 and source = 'application'",
      [client],
    );
    expect(mail.rows[0]).toMatchObject({ lane: "intake", to: "dana@harborbakery.com" });
    expect(mail.rows[0]?.subject).toMatch(/received your application/);
    const latest = await t.db.withUser(rep, (q) => latestApplication(q, client));
    expect(latest?.signer_name).toBe("Dana Reyes");
    expect((await openApplicationPage(t.db, token))?.signed_at).toBe(SIGNED_ISO);
  });

  it("a merchant who types no DBA and no industry still signs (the columns are not-null and empty means empty)", async () => {
    const other = (
      await t.pool.query<{ id: string; tok: string }>(
        "insert into clients (user_id, business_name, contact_name, phone, email) values ($1, 'Plain Co', 'Sam Lee', '3055550177', 'sam@plain.co') returning id, application_token as tok",
        [rep],
      )
    ).rows[0]!;
    const out = await signApplication(t.db, store, {
      token: other.tok,
      fields: {
        ...FIELDS,
        legal_business_name: "Plain Co",
        dba: "",
        industry: "",
        owner_name: "Sam Lee",
        signer_name: "Sam Lee",
      },
      ip: "203.0.113.10",
      userAgent: "Chrome",
      today: t.today,
    });
    const c = await t.pool.query<{ dba: string; industry: string }>(
      "select dba, industry from clients where id = $1",
      [other.id],
    );
    expect(c.rows[0]).toEqual({ dba: "", industry: "" });
    expect(out.applicationId).toBeTruthy();
  });

  it("a second signature is refused, and a bad form never writes", async () => {
    await expect(
      signApplication(t.db, store, {
        token,
        fields: FIELDS,
        ip: "",
        userAgent: "",
        today: t.today,
      }),
    ).rejects.toThrow(/already signed/);
    const before = (await t.pool.query<{ n: number }>("select count(*)::int as n from documents"))
      .rows[0]?.n;
    await expect(
      signApplication(t.db, store, {
        token: "deadbeef".repeat(6),
        fields: FIELDS,
        ip: "",
        userAgent: "",
        today: t.today,
      }),
    ).rejects.toThrow(/isn't valid/);
    await expect(
      signApplication(t.db, store, {
        token,
        fields: { ...FIELDS, agree: false },
        ip: "",
        userAgent: "",
        today: t.today,
      }),
    ).rejects.toThrow(/already signed|Tick the box/);
    const after = (await t.pool.query<{ n: number }>("select count(*)::int as n from documents"))
      .rows[0]?.n;
    expect(after).toBe(before);
  });
});
