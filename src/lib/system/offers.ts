import { UserError } from "../data/mutations";
import { db as defaultDb, type Db, type DbAccess } from "../db";
import { labelOf } from "../docs/label";
import { mintUploadSession, type Wanted } from "../docs/upload";
import { formatMoney } from "../money";
import { stopApprovalEmails } from "../approvals/engine";
import {
  OFFER_DOC_WORDS,
  factorWords,
  finalPayment,
  type Frequency,
  type OfferDoc,
  validThroughWords,
  offerNumber,
} from "../offers/terms";

/**
 * The merchant's side of an offer: the page their link opens, and accepting it. No account: the token is the key, so
 * this runs on the owner connection and never reads more than the one offer and its merchant.
 */

const TOKEN = /^[a-f0-9]{64}$/;

export interface OfferPage {
  id: string;
  /** "SC-2026-1F3A9C": what the merchant and the rep can both say on the phone. */
  number: string;
  state: "open" | "accepted" | "withdrawn" | "expired";
  businessName: string;
  contactName: string;
  firstName: string;
  shopName: string;
  repName: string;
  repPhone: string;
  repEmail: string;
  fundedCents: number;
  factorRate: number;
  frequency: Frequency;
  payments: number;
  paybackCents: number;
  paymentCents: number;
  /** The last payment, which carries the few cents left over (the same as the others when nothing is). */
  finalPaymentCents: number;
  message: string;
  expiresAt: string;
  validThrough: string;
  docs: { kind: OfferDoc; label: string; hint: string; onFile: boolean }[];
  /** A two-hour upload session for the documents still missing; null when nothing is missing or it no longer stands. */
  uploadToken: string | null;
  acceptedAt: string | null;
  acceptedName: string;
}

interface Row {
  id: string;
  client_id: string;
  user_id: string;
  status: "sent" | "accepted" | "withdrawn";
  expired: boolean;
  business_name: string;
  contact_name: string;
  timezone: string;
  shop_name: string;
  rep_name: string;
  rep_phone: string;
  rep_email: string;
  funded_cents: string;
  factor_rate: string;
  frequency: Frequency;
  payments: number;
  payback_cents: string;
  payment_cents: string;
  message: string;
  docs: OfferDoc[];
  expires_at: string;
  accepted_at: string | null;
  accepted_name: string;
  views: number;
  approval_id: string | null;
  created_at: string;
}

const ROW_SQL = `
  select o.id, o.client_id, c.user_id, o.status, o.expires_at <= now() as expired, c.business_name, c.contact_name,
         app.client_timezone(c) as timezone, (select shop_name from shop_settings) as shop_name,
         coalesce(u.name, '') as rep_name, coalesce(u.phone, '') as rep_phone, u.email as rep_email,
         o.funded_cents::text, o.factor_rate::text, o.frequency, o.payments, o.payback_cents::text, o.payment_cents::text,
         o.message, o.docs,
         to_char(o.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
         to_char(o.accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as accepted_at, o.accepted_name, o.views,
         o.approval_id, o.created_at::text as created_at
    from merchant_offers o join clients c on c.id = o.client_id join app_users u on u.id = c.user_id
   where o.token = $1 and not exists (select 1 from trashed_clients t where t.client_id = c.id)`;

const stateOf = (r: Pick<Row, "status" | "expired">): OfferPage["state"] =>
  r.status === "accepted"
    ? "accepted"
    : r.status === "withdrawn"
      ? "withdrawn"
      : r.expired
        ? "expired"
        : "open";

/**
 * What /offer/<token> shows, or null when the token means nothing. Opening the page changes nothing about the offer: a
 * mail scanner fetches links before the merchant does, so the open is recorded by the page itself (recordOfferView).
 */
export async function openOffer(
  token: string,
  opts: { db?: DbAccess } = {},
): Promise<OfferPage | null> {
  if (!TOKEN.test(token)) return null;
  const access = opts.db ?? defaultDb;
  return access.withSystem(async (q) => {
    const r = (await q.query<Row>(ROW_SQL, [token])).rows[0];
    if (!r) return null;
    const state = stateOf(r);
    const onFile = await docsOnFile(q, r.client_id, r.docs);
    const missing = r.docs.filter((d) => !onFile.has(d));
    let uploadToken: string | null = null;
    if (state === "open" && missing.length > 0) {
      const wanted: Wanted[] = missing.map((kind) => ({
        kind,
        period: null,
        label: labelOf(kind, null),
      }));
      // the same visitor refreshing keeps one session; it is the offer page's own (purpose 'offer')
      const live = await q.query<{ token: string }>(
        `select token from upload_sessions where client_id = $1 and created_by is null and purpose = 'offer'
            and expires_at > now() + interval '20 minutes' and files_received < max_files
          order by created_at desc limit 1`,
        [r.client_id],
      );
      uploadToken =
        live.rows[0]?.token ??
        (
          await mintUploadSession(q, {
            clientId: r.client_id,
            wanted,
            createdBy: null,
            purpose: "offer",
          })
        ).token;
    }
    return {
      id: r.id,
      number: offerNumber(r.id, r.created_at),
      state,
      businessName: r.business_name,
      contactName: r.contact_name,
      firstName: r.contact_name.trim().split(/\s+/)[0] ?? "",
      shopName: r.shop_name || "Selective Capital",
      repName: r.rep_name,
      repPhone: r.rep_phone,
      repEmail: r.rep_email,
      fundedCents: Number(r.funded_cents),
      factorRate: Number(r.factor_rate),
      frequency: r.frequency,
      payments: r.payments,
      paybackCents: Number(r.payback_cents),
      paymentCents: Number(r.payment_cents),
      finalPaymentCents: finalPayment(Number(r.payback_cents), Number(r.payment_cents), r.payments),
      message: r.message,
      expiresAt: r.expires_at,
      validThrough: validThroughWords(r.expires_at, r.timezone),
      docs: r.docs.map((kind) => ({ kind, ...OFFER_DOC_WORDS[kind], onFile: onFile.has(kind) })),
      uploadToken,
      acceptedAt: r.accepted_at,
      acceptedName: r.accepted_name,
    };
  });
}

/**
 * The merchant has the page in front of them (the page calls this a few seconds after it opens, and never for a
 * signed-in rep). The first time, their rep hears about it.
 */
export async function recordOfferView(token: string, access: DbAccess = defaultDb): Promise<void> {
  if (!TOKEN.test(token)) return;
  await access.withSystem(async (q) => {
    const r = (await q.query<Row>(`${ROW_SQL} for update of o`, [token])).rows[0];
    if (!r || stateOf(r) !== "open") return;
    await q.query(
      `update merchant_offers set views = views + 1, first_viewed_at = coalesce(first_viewed_at, now()),
                                  last_viewed_at = now() where id = $1`,
      [r.id],
    );
    // the same signal as an opened upload link: "Do this now" shows it while the offer waits on them
    // at most one signal every half hour, like the upload link's (src/lib/system/linkSignals.ts)
    await q.query(
      `insert into link_opens (client_id, kind)
       select $1, 'offer' where not exists (select 1 from link_opens where client_id = $1 and kind = 'offer'
                                             and opened_at > now() - interval '30 minutes')`,
      [r.client_id],
    );
    if (r.views > 0) return;
    await q.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
      [r.user_id, r.client_id, `Opened the offer of ${formatMoney(Number(r.funded_cents))}`],
    );
    await q.query(
      `insert into user_alerts (user_id, kind, client_id, title, body, href, dedupe_key)
       values ($1, 'offer_opened', $2, $3, $4, $5, $6) on conflict do nothing`,
      [
        r.user_id,
        r.client_id,
        `${r.business_name} opened their offer`,
        `${formatMoney(Number(r.funded_cents))}. A good moment to call.`,
        `/clients/${r.client_id}`,
        `offer_opened:${r.id}`,
      ],
    );
  });
}

async function docsOnFile(q: Db, clientId: string, kinds: readonly string[]): Promise<Set<string>> {
  if (kinds.length === 0) return new Set();
  const { rows } = await q.query<{ kind: string }>(
    `select distinct kind from documents
      where client_id = $1 and deleted_at is null and kind = any($2::text[])
        and scan_status not in ('infected', 'rejected')`,
    [clientId, kinds],
  );
  return new Set(rows.map((x) => x.kind));
}

/** Where the offer stands now (open, accepted, withdrawn, expired), for a page that just had an accept refused. */
export async function offerState(
  token: string,
  access: DbAccess = defaultDb,
): Promise<OfferPage["state"] | null> {
  if (!TOKEN.test(token)) return null;
  return access.withSystem(async (q) => {
    const r = (await q.query<Row>(ROW_SQL, [token])).rows[0];
    return r ? stateOf(r) : null;
  });
}

/** Which of the offer's documents are on file now (the page asks after each upload). */
export async function offerDocs(
  token: string,
  access: DbAccess = defaultDb,
): Promise<string[] | null> {
  if (!TOKEN.test(token)) return null;
  return access.withSystem(async (q) => {
    const r = (await q.query<Row>(ROW_SQL, [token])).rows[0];
    if (!r) return null;
    return [...(await docsOnFile(q, r.client_id, r.docs))];
  });
}

/**
 * The merchant accepts: the offer must still stand and every document it asks for must be on file. Their rep hears
 * about it at once, the merchant's timeline says so, and an approval's emails stop (they have answered).
 */
export async function acceptOffer(
  token: string,
  a: { name: string; email: string; ip: string },
  access: DbAccess = defaultDb,
): Promise<{ acceptedAt: string; offerId: string; already?: boolean }> {
  if (!TOKEN.test(token)) throw new UserError("This link is not valid");
  return access.withSystem(async (q) => {
    const r = (await q.query<Row>(`${ROW_SQL} for update of o`, [token])).rows[0];
    if (!r) throw new UserError("This link is not valid");
    const state = stateOf(r);
    if (state === "accepted")
      return { acceptedAt: r.accepted_at ?? "", offerId: r.id, already: true };
    if (state === "withdrawn") throw new UserError("This offer is no longer available");
    if (state === "expired")
      throw new UserError("This offer has expired. Contact us and we'll see what we can do");
    const onFile = await docsOnFile(q, r.client_id, r.docs);
    const missing = r.docs.filter((d) => !onFile.has(d));
    if (missing.length > 0)
      throw new UserError(
        `Upload your ${missing.map((d) => OFFER_DOC_WORDS[d].label.toLowerCase()).join(" and ")} first`,
      );
    const done = await q.query<{ accepted_at: string }>(
      `update merchant_offers set status = 'accepted', accepted_at = now(), accepted_name = $2, accepted_email = $3,
                                  accepted_ip = $4
        where id = $1 returning accepted_at::text`,
      [r.id, a.name.slice(0, 160), a.email.slice(0, 254), a.ip.slice(0, 64)],
    );
    const amount = formatMoney(Number(r.funded_cents));
    await q.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
      [
        r.user_id,
        r.client_id,
        `Accepted the offer: ${amount} at factor ${factorWords(Number(r.factor_rate))}${a.name ? `, accepted as ${a.name}` : ""}`,
      ],
    );
    await q.query(
      `insert into user_alerts (user_id, kind, client_id, title, body, href, dedupe_key)
       values ($1, 'offer_accepted', $2, $3, $4, $5, $6) on conflict do nothing`,
      [
        r.user_id,
        r.client_id,
        `${r.business_name} accepted their offer`,
        `${amount}. The documents it asked for are on file.`,
        `/clients/${r.client_id}`,
        `offer_accepted:${r.id}`,
      ],
    );
    if (r.approval_id) {
      const ap = await q.query<{ emails: string }>(
        "select emails from approvals where id = $1 and status = 'open'",
        [r.approval_id],
      );
      if (ap.rows[0] && (ap.rows[0].emails === "running" || ap.rows[0].emails === "paused"))
        await stopApprovalEmails(q, r.approval_id, "stopped", "offer_accepted");
    }
    return { acceptedAt: done.rows[0]!.accepted_at, offerId: r.id };
  });
}
