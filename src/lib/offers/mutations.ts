import type { Db } from "../db";
import { UserError } from "../data/mutations";
import { enqueueEmail, type EnqueueResult } from "../send/enqueue";
import { offerEmail } from "./email";
import {
  exactMoney,
  FREQUENCY_WORDS,
  computeTerms,
  factorWords,
  finalPayment,
  offerGreetingName,
  offerNumber,
  validThroughWords,
  type OfferInput,
} from "./terms";

export { validThroughWords };

export interface OfferCtx {
  userId: string;
  now: Date;
  /** The site's address, for the merchant's link. */
  appUrl: string;
}

export const offerUrl = (appUrl: string, token: string) =>
  `${appUrl.replace(/\/+$/, "")}/offer/${token}`;

export interface MadeOffer {
  offerId: string;
  token: string;
  url: string;
  /** What happened to the email; null when the rep chose to send the link their own way. */
  email: EnqueueResult | null;
}

/**
 * Make an offer for a merchant the person can see, and (unless they chose otherwise) email it from the merchant's
 * rep. Runs as the person: row security decides whether the merchant is theirs to make an offer for.
 */
export async function createOffer(q: Db, i: OfferInput, ctx: OfferCtx): Promise<MadeOffer> {
  const { rows } = await q.query<{
    business_name: string;
    contact_name: string;
    timezone: string;
    rep_name: string;
    rep_phone: string;
    rep_email: string;
    shop_name: string;
  }>(
    `select c.business_name, c.contact_name, app.client_timezone(c) as timezone,
            coalesce(u.name, '') as rep_name, coalesce(u.phone, '') as rep_phone, u.email as rep_email,
            (select shop_name from shop_settings) as shop_name
       from clients c join app_users u on u.id = c.user_id
      where c.id = $1 and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
    [i.clientId],
  );
  const c = rows[0];
  if (!c) throw new UserError("That merchant isn't in your view");
  if (i.approvalId) {
    const a = await q.query<{ status: string }>(
      "select status from approvals where id = $1 and client_id = $2",
      [i.approvalId, i.clientId],
    );
    if (!a.rows[0]) throw new UserError("That approval is not this merchant's");
  }
  const ins = await q.query<{
    id: string;
    token: string;
    payment_cents: string;
    payback_cents: string;
    created_at: string;
  }>(
    `insert into merchant_offers (client_id, approval_id, funded_cents, factor_rate, frequency, payments, funder, message,
                                  docs, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)
     returning id, token, payment_cents::text, payback_cents::text, created_at::text`,
    [
      i.clientId,
      i.approvalId ?? null,
      i.funded,
      i.factorRate,
      i.frequency,
      i.payments,
      i.funder,
      i.message,
      i.docs,
      i.expiresAt,
    ],
  );
  const o = ins.rows[0]!;
  await retireOtherOffers(q, i.clientId, o.id, ctx);
  const url = offerUrl(ctx.appUrl, o.token);
  const paymentCents = Number(o.payment_cents);
  const through = validThroughWords(i.expiresAt, c.timezone);
  const summary = `${exactMoney(i.funded)} · factor ${factorWords(i.factorRate)} · ${i.payments} ${FREQUENCY_WORDS[i.frequency].label.toLowerCase()} payments of ${exactMoney(paymentCents)} · valid through ${through}`;

  let email: EnqueueResult | null = null;
  if (i.send) {
    const mail = offerEmail({
      number: offerNumber(o.id, o.created_at),
      message: i.message,
      paybackCents: Number(o.payback_cents),
      logoUrl: `${ctx.appUrl.replace(/\/+$/, "")}/brand/SC-horizontal-light-web.png`,
      heroUrl: `${ctx.appUrl.replace(/\/+$/, "")}/brand/offer-hero.png`,
      firstName: offerGreetingName(c.contact_name),
      businessName: c.business_name,
      shopName: c.shop_name,
      fundedCents: i.funded,
      paymentCents,
      finalPaymentCents: finalPayment(Number(o.payback_cents), paymentCents, i.payments),
      payments: i.payments,
      frequency: i.frequency,
      factorRate: i.factorRate,
      validThrough: through,
      url,
      repName: c.rep_name,
      repPhone: c.rep_phone,
      repEmail: c.rep_email,
    });
    email = await enqueueEmail(
      q,
      {
        clientId: i.clientId,
        lane: "reply",
        source: `offer:${o.id}`,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        when: "now",
        // an offer email that has not gone by the time the offer ends is no use to anyone
        expiresInHours: Math.max(
          1,
          (new Date(i.expiresAt).getTime() - ctx.now.getTime()) / 3_600_000,
        ),
      },
      ctx.now,
    );
    if ("outboxId" in email)
      await q.query("update merchant_offers set outbox_id = $2 where id = $1", [
        o.id,
        email.outboxId,
      ]);
  }
  await q.query(
    "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
    [ctx.userId, i.clientId, `${email?.queued ? "Offer emailed" : "Offer made"}: ${summary}`],
  );
  // a sanity line: the database and the form agree on the arithmetic (they share the rule in terms.ts)
  const expected = computeTerms({
    fundedCents: i.funded,
    factorRate: i.factorRate,
    payments: i.payments,
  });
  if (expected.paymentCents !== paymentCents || expected.paybackCents !== Number(o.payback_cents))
    console.error("offer arithmetic differs between the form and the database", o.id);
  return { offerId: o.id, token: o.token, url, email };
}

/**
 * A new offer replaces the merchant's earlier ones that still stand: only the newest link may be accepted, and an
 * older email not yet sent is taken back. Runs in the new offer's transaction. Each one leaves a line on the timeline.
 */
async function retireOtherOffers(q: Db, clientId: string, keepId: string, ctx: OfferCtx) {
  const { rows } = await q.query<{ id: string; outbox_id: string | null; funded_cents: string }>(
    `update merchant_offers set status = 'withdrawn', withdrawn_at = $3
      where client_id = $1 and id <> $2 and status = 'sent' and expires_at > $3
      returning id, outbox_id, funded_cents::text`,
    [clientId, keepId, ctx.now.toISOString()],
  );
  for (const old of rows) {
    if (old.outbox_id)
      await q.query(
        "update outbox set status = 'cancelled', skip_reason = 'offer_withdrawn' where id = $1 and status = 'queued'",
        [old.outbox_id],
      );
    await q.query(
      "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
      [
        ctx.userId,
        clientId,
        `Earlier offer of ${exactMoney(Number(old.funded_cents))} withdrawn: replaced by a new offer`,
      ],
    );
  }
}

/** Take an offer back while it still stands: its page says so, and an email not yet sent stays unsent. */
export async function withdrawOffer(q: Db, offerId: string, ctx: OfferCtx): Promise<void> {
  const { rows } = await q.query<{
    client_id: string;
    outbox_id: string | null;
    funded_cents: string;
  }>(
    `update merchant_offers set status = 'withdrawn', withdrawn_at = $2
      where id = $1 and status = 'sent'
      returning client_id, outbox_id, funded_cents::text`,
    [offerId, ctx.now.toISOString()],
  );
  const o = rows[0];
  if (!o) throw new UserError("That offer was already accepted or taken back");
  if (o.outbox_id)
    await q.query(
      "update outbox set status = 'cancelled', skip_reason = 'offer_withdrawn' where id = $1 and status = 'queued'",
      [o.outbox_id],
    );
  await q.query(
    "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
    [ctx.userId, o.client_id, `Offer of ${exactMoney(Number(o.funded_cents))} withdrawn`],
  );
}
