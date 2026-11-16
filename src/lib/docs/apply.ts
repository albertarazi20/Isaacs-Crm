import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { UserError } from "../data/mutations";
import type { Db, DbAccess } from "../db";
import type { ISODate } from "../mca/dates";
import { enqueueEmail } from "../send/enqueue";
import type { BlobStore } from "./storage";
import { fileGeneratedDocument } from "./upload";

/**
 * The application the merchant fills in and signs in the app (plan §13.5: nothing is submitted that the owner has
 * not seen; §7 Documents). No sign-in: the merchant's permanent application token is the key, like the upload
 * link. Signing writes a PDF into Documents as the signed application (the checklist box ticks itself through the
 * documents trigger), records what was typed and the consents, fills in blanks on the merchant, tells the rep, and
 * sends the merchant a confirmation. No SSN anywhere; the EIN is kept as its last four only.
 */

export const ApplicationFields = z.object({
  legal_business_name: z.string().trim().min(2).max(120),
  dba: z.string().trim().max(120).default(""),
  owner_name: z.string().trim().min(2).max(100),
  title: z.string().trim().max(60).default(""),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(200),
  address: z.string().trim().max(200).default(""),
  city: z.string().trim().max(80).default(""),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use the two-letter state"),
  zip: z.string().trim().max(12).default(""),
  ein_last4: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/, "The last four digits of the EIN")
    .default(""),
  industry: z.string().trim().max(80).default(""),
  business_start: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Year and month the business started")
    .default(""),
  monthly_revenue_dollars: z.coerce.number().min(0).max(100_000_000).default(0),
  amount_requested_dollars: z.coerce.number().min(0).max(50_000_000).default(0),
  use_of_funds: z.string().trim().max(500).default(""),
  existing_advances: z.string().trim().max(500).default(""),
  consent_email: z.coerce.boolean().default(false),
  consent_sms: z.coerce.boolean().default(false),
  agree: z.coerce.boolean(),
  signer_name: z.string().trim().min(3).max(100),
});
export type ApplicationFieldsInput = z.input<typeof ApplicationFields>;
export type ApplicationFieldsData = z.infer<typeof ApplicationFields>;

export interface ApplicationPage {
  token: string;
  shop_name: string;
  rep_name: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  state: string;
  industry: string;
  monthly_revenue_dollars: number | null;
  wanted_amount_dollars: number | null;
  signed_at: string | null;
}

/** What the page shows for a token; null when the link is not one of ours. */
export async function openApplicationPage(
  db: DbAccess,
  token: string,
): Promise<ApplicationPage | null> {
  if (!/^[0-9a-f]{40,80}$/.test(token)) return null;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{
      business_name: string;
      contact_name: string;
      phone: string;
      email: string;
      state: string;
      industry: string;
      monthly_revenue_cents: string | null;
      wanted_amount_cents: string | null;
      shop_name: string;
      rep_name: string;
      signed_at: string | null;
    }>(
      `select c.business_name, c.contact_name, c.phone, c.email, coalesce(c.state, '') as state, coalesce(c.industry, '') as industry,
              c.monthly_revenue_cents::text as monthly_revenue_cents,
              coalesce((select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1),
                       (select d.requested_cents from deals d where d.client_id = c.id and d.outcome = 'open' order by d.created_at desc limit 1))::text as wanted_amount_cents,
              (select shop_name from shop_settings) as shop_name,
              coalesce(nullif(u.name, ''), u.email) as rep_name,
              (select to_char(a.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from applications a
                 where a.client_id = c.id and a.signed_at > coalesce((select max(d.created_at) from deals d where d.client_id = c.id and d.outcome = 'open'), a.signed_at - interval '1 second')
                 order by a.signed_at desc limit 1) as signed_at
         from clients c join app_users u on u.id = c.user_id
        where c.application_token = $1 and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
      [token],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      token,
      shop_name: r.shop_name,
      rep_name: r.rep_name,
      business_name: r.business_name,
      contact_name: r.contact_name,
      phone: r.phone,
      email: r.email,
      state: r.state,
      industry: r.industry,
      monthly_revenue_dollars:
        r.monthly_revenue_cents === null ? null : Math.round(Number(r.monthly_revenue_cents) / 100),
      wanted_amount_dollars:
        r.wanted_amount_cents === null ? null : Math.round(Number(r.wanted_amount_cents) / 100),
      signed_at: r.signed_at,
    };
  });
}

const money = (d: number) => `$${Math.round(d).toLocaleString("en-US")}`;

function monthsSince(start: string, today: ISODate): number | null {
  const m = start.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  const n = (ty - y) * 12 + (tm - mo);
  return n >= 0 && n < 1200 ? n : null;
}

/** The application as a one- or two-page PDF: what was typed, then the signature block. Pure. */
export async function applicationPdf(a: {
  shopName: string;
  fields: ApplicationFieldsData;
  signedAt: Date;
  ip: string;
  userAgent: string;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 740;
  const left = 54;
  const width = 612 - 2 * left;
  const ink = rgb(0.05, 0.05, 0.08);
  const grey = rgb(0.4, 0.4, 0.45);
  const line = (text: string, size = 10.5, f = font, color = ink) => {
    // simple word wrap on the page width
    const words = text.split(/\s+/);
    let cur = "";
    const flush = () => {
      if (y < 60) {
        page = doc.addPage([612, 792]);
        y = 740;
      }
      page.drawText(cur, { x: left, y, size, font: f, color });
      y -= size * 1.45;
      cur = "";
    };
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width) flush();
      cur = cur ? `${cur} ${w}` : w;
    }
    if (cur || text === "") flush();
  };
  const row = (label: string, value: string) => {
    if (y < 60) {
      page = doc.addPage([612, 792]);
      y = 740;
    }
    page.drawText(label, { x: left, y, size: 9, font, color: grey });
    page.drawText(value || "—", { x: left + 190, y, size: 10.5, font, color: ink });
    y -= 16;
  };
  const f = a.fields;
  line(a.shopName || "Selective Capital", 11, bold, grey);
  line("Merchant funding application", 20, bold);
  y -= 6;
  line(
    `Submitted ${a.signedAt.toISOString().slice(0, 10)} by ${f.signer_name}. Soft inquiry only; nothing here is a loan.`,
    9.5,
    font,
    grey,
  );
  y -= 10;
  line("Business", 12, bold);
  row("Legal business name", f.legal_business_name);
  row("DBA", f.dba);
  row("Industry", f.industry);
  row("Business start", f.business_start);
  row("EIN (last four)", f.ein_last4 ? `***-***${f.ein_last4}` : "");
  row("Address", [f.address, f.city, f.state, f.zip].filter(Boolean).join(", "));
  y -= 8;
  line("Owner", 12, bold);
  row("Name", f.owner_name);
  row("Title", f.title);
  row("Phone", f.phone);
  row("Email", f.email);
  y -= 8;
  line("The request", 12, bold);
  row("Monthly revenue", f.monthly_revenue_dollars ? money(f.monthly_revenue_dollars) : "");
  row("Amount requested", f.amount_requested_dollars ? money(f.amount_requested_dollars) : "");
  row("Use of funds", f.use_of_funds);
  row("Existing advances", f.existing_advances);
  y -= 8;
  line("Consent and signature", 12, bold);
  line(
    `I confirm the information above is accurate and complete, and I authorize ${a.shopName || "Selective Capital"} to share it with funding providers to obtain offers on my behalf.`,
    10,
  );
  line(
    `Email updates: ${f.consent_email ? "yes" : "no"}. Text messages: ${f.consent_sms ? "yes" : "no"}.`,
    10,
  );
  y -= 6;
  line(`Signed electronically by ${f.signer_name}`, 13, bold);
  line(
    `${a.signedAt.toISOString().replace("T", " ").slice(0, 19)} UTC · from ${a.ip || "an unknown address"} · ${a.userAgent.slice(0, 120)}`,
    8.5,
    font,
    grey,
  );
  return doc.save();
}

export interface SignedApplication {
  applicationId: string;
  documentId: string;
}

/** The merchant submits the form. System connection: the merchant has no login. */
export async function signApplication(
  db: DbAccess,
  store: BlobStore,
  a: {
    token: string;
    fields: ApplicationFieldsInput;
    ip: string;
    userAgent: string;
    today: ISODate;
    now?: Date;
  },
): Promise<SignedApplication> {
  const parsed = ApplicationFields.safeParse(a.fields);
  if (!parsed.success)
    throw new UserError(parsed.error.issues[0]?.message ?? "Check the form and try again");
  const f = parsed.data;
  if (!f.agree) throw new UserError("Tick the box to confirm the information is accurate");
  const now = a.now ?? new Date();
  const page = await openApplicationPage(db, a.token);
  if (!page) throw new UserError("This link isn't valid any more");
  if (page.signed_at) throw new UserError("This application was already signed");
  return db.withSystem(async (q) => {
    const c = (
      await q.query<{
        id: string;
        user_id: string;
        deal_id: string | null;
        shop_name: string;
        has_ask: boolean;
      }>(
        `select c.id, c.user_id,
                (select d.id from deals d where d.client_id = c.id and d.outcome = 'open' order by d.created_at desc limit 1) as deal_id,
                (select shop_name from shop_settings) as shop_name,
                exists (select 1 from client_asks k where k.client_id = c.id) as has_ask
           from clients c where c.application_token = $1`,
        [a.token],
      )
    ).rows[0];
    if (!c) throw new UserError("This link isn't valid any more");
    const bytes = await applicationPdf({
      shopName: c.shop_name,
      fields: f,
      signedAt: now,
      ip: a.ip,
      userAgent: a.userAgent,
    });
    const doc = await fileGeneratedDocument(q, store, {
      clientId: c.id,
      dealId: c.deal_id,
      kind: "signed_application",
      filename: `application-${now.toISOString().slice(0, 10)}.pdf`,
      bytes,
      today: a.today,
    });
    const { fields: _omit, ...rest } = { fields: null, ...f };
    void _omit;
    const app = (
      await q.query<{ id: string }>(
        `insert into applications (client_id, user_id, deal_id, document_id, fields, signer_name, signed_at, ip, user_agent, consent_email, consent_sms)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) returning id`,
        [
          c.id,
          c.user_id,
          c.deal_id,
          doc.documentId,
          JSON.stringify({ ...rest, agree: undefined, signer_name: undefined }),
          f.signer_name,
          now,
          a.ip.slice(0, 64),
          a.userAgent.slice(0, 300),
          f.consent_email,
          f.consent_sms,
        ],
      )
    ).rows[0]!;
    // blanks on the merchant fill in from what the owner typed; nothing already there is overwritten
    const months = monthsSince(f.business_start, a.today);
    await q.query(
      `update clients set
         contact_name = case when btrim(contact_name) = '' then $2 else contact_name end,
         phone = case when btrim(phone) = '' then $3 else phone end,
         email = case when btrim(email) = '' then $4 else email end,
         state = coalesce(nullif(state, ''), $5),
         industry = coalesce(nullif(industry, ''), $6),
         dba = coalesce(nullif(dba, ''), $7),
         monthly_revenue_cents = coalesce(monthly_revenue_cents, case when $8::bigint > 0 then $8::bigint end),
         time_in_business_months = coalesce(time_in_business_months, $9::int),
         sms_consent_at = case when $10 then coalesce(sms_consent_at, $11::timestamptz) else sms_consent_at end,
         sms_consent_source = case when $10 and sms_consent_at is null then 'application' else sms_consent_source end,
         application_received_on = coalesce(application_received_on, $12::date)
       where id = $1`,
      [
        c.id,
        f.owner_name,
        f.phone,
        f.email,
        f.state,
        f.industry,
        f.dba,
        Math.round(f.monthly_revenue_dollars * 100),
        months,
        f.consent_sms,
        now,
        a.today,
      ],
    );
    if (!c.has_ask && f.amount_requested_dollars > 0)
      await q.query(
        "insert into client_asks (user_id, client_id, wanted_amount_cents, wanted_terms) values ($1, $2, $3, $4)",
        [
          c.user_id,
          c.id,
          Math.round(f.amount_requested_dollars * 100),
          f.use_of_funds.slice(0, 200),
        ],
      );
    await q.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
      [c.user_id, c.id, `Application signed by ${f.signer_name}`],
    );
    await q.query("select app.alert($1, 'application_signed', $2, $3, $4, $5, $6, $7)", [
      c.user_id,
      c.id,
      c.deal_id,
      `${f.legal_business_name} signed the application`,
      `${f.signer_name} signed in the app${f.amount_requested_dollars > 0 ? `, asking for ${money(f.amount_requested_dollars)}` : ""}.`,
      c.deal_id ? `/deals/${c.deal_id}` : `/clients/${c.id}`,
      `application_signed:${app.id}`,
    ]);
    await enqueueEmail(
      q,
      {
        clientId: c.id,
        lane: "intake",
        source: "application",
        subject: `We received your application — ${c.shop_name || "Selective Capital"}`,
        text: `Hi ${f.owner_name.split(" ")[0]},\n\nThanks — your application for ${f.legal_business_name} is in. ${page.rep_name} will be in touch shortly. If any statements or documents are still missing, the upload link in your earlier email still works.\n\n${c.shop_name || "Selective Capital"}`,
        when: "now",
      },
      now,
    );
    return { applicationId: app.id, documentId: doc.documentId };
  });
}

/** For a rep's page: the latest signed application on a merchant, if any. */
export async function latestApplication(
  q: Db,
  clientId: string,
): Promise<{
  id: string;
  signer_name: string;
  signed_at: string;
  document_id: string | null;
} | null> {
  const { rows } = await q.query<{
    id: string;
    signer_name: string;
    signed_at: string;
    document_id: string | null;
  }>(
    `select id, signer_name, to_char(signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as signed_at, document_id
       from applications where client_id = $1 order by signed_at desc limit 1`,
    [clientId],
  );
  return rows[0] ?? null;
}
