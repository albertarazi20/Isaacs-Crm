import type { Db } from "../db";
import { listCards } from "../data/queries";
import type { ClientCard } from "../data/types";
import type { ContactStatus } from "../mca/contact";
import type { ISODate } from "../mca/dates";
import type { Frequency } from "../mca/funding";
import type { StageKey } from "../mca/stages";
import type {
  AdvanceRow,
  AdvanceStatus,
  CompetingOfferRow,
  DealRow,
  FunderTerms,
  OfferRow,
} from "./types";

const json = async <T>(q: Db, sql: string): Promise<T[]> =>
  (await q.query<{ j: T }>(sql)).rows.map((r) => r.j);

/** True when the table exists. The Funders migration (0010) may not be applied, and the pages must still load. */
export async function tableExists(
  q: Db,
  name: "offers" | "funders" | "trashed_clients",
): Promise<boolean> {
  const { rows } = await q.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [
    `public.${name}`,
  ]);
  return rows[0]?.ok === true;
}

/**
 * "and not exists (...)" for a merchant alias `c`, hiding trashed merchants (migration 0040). These queries read
 * the clients table directly — client_cards would run its per-merchant subqueries once per query — so the filter the
 * view applies is repeated here, and skipped when the Trash migration is not applied.
 */
async function hideTrashed(q: Db): Promise<string> {
  return (await tableExists(q, "trashed_clients"))
    ? "and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)"
    : "";
}

interface AdvanceJson {
  id: string;
  client_id: string;
  business_name: string;
  industry: string;
  stage: StageKey;
  contact_status: ContactStatus;
  funded_on: ISODate;
  funder_name: string;
  amount_cents: number;
  factor_rate: number;
  payback_cents: number;
  payment_cents: number;
  frequency: Frequency;
  position_no: number;
  term_days: number | null;
  commission_cents: number | null;
  commission_received_cents: number | null;
  commission_received_on: ISODate | null;
  paid_back_override_cents: number | null;
  status: AdvanceStatus;
}

/** Every advance of every merchant that is not in the trash, newest first. */
export async function listAdvances(q: Db): Promise<AdvanceRow[]> {
  const hide = await hideTrashed(q);
  const rows = await json<AdvanceJson>(
    q,
    `select jsonb_build_object(
        'id', f.id, 'client_id', f.client_id, 'business_name', c.business_name, 'industry', c.industry,
        'stage', c.stage, 'contact_status', c.contact_status, 'funded_on', f.funded_on,
        'funder_name', f.funder_name, 'amount_cents', f.amount_cents, 'factor_rate', f.factor_rate,
        'payback_cents', f.payback_cents, 'payment_cents', f.payment_cents, 'frequency', f.frequency,
        'position_no', f.position_no, 'term_days', f.term_days, 'commission_cents', f.commission_cents,
        'commission_received_cents', f.commission_received_cents,
        'commission_received_on', f.commission_received_on,
        'paid_back_override_cents', f.paid_back_override_cents, 'status', f.status) as j
       from fundings f join clients c on c.id = f.client_id
      where true ${hide}
      order by f.funded_on desc, f.created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    businessName: r.business_name,
    industry: r.industry,
    stage: r.stage,
    contactStatus: r.contact_status,
    fundedOn: r.funded_on,
    funderName: r.funder_name,
    amountCents: r.amount_cents,
    factorRate: r.factor_rate,
    paybackCents: r.payback_cents,
    paymentCents: r.payment_cents,
    frequency: r.frequency,
    positionNo: r.position_no,
    termDays: r.term_days,
    commissionCents: r.commission_cents,
    commissionReceivedCents: r.commission_received_cents,
    commissionReceivedOn: r.commission_received_on,
    paidBackOverrideCents: r.paid_back_override_cents,
    status: r.status,
  }));
}

export async function listFunderTerms(q: Db): Promise<FunderTerms[]> {
  const rows = await json<{
    name: string;
    commission_points: number | null;
    renewal_paydown_pct: number | null;
  }>(
    q,
    `select jsonb_build_object('name', name, 'commission_points', commission_points,
                               'renewal_paydown_pct', renewal_paydown_pct) as j
       from funders order by lower(name)`,
  );
  return rows.map((r) => ({
    name: r.name,
    commissionPoints: r.commission_points,
    renewalPaydownPct: r.renewal_paydown_pct,
  }));
}

export async function listOffers(q: Db): Promise<(OfferRow & { industry: string })[]> {
  const hide = await hideTrashed(q);
  const rows = await json<{
    id: string;
    client_id: string;
    funder_name: string;
    amount_cents: number;
    factor_rate: number;
    position_no: number | null;
    status: OfferRow["status"];
    received_on: ISODate;
    industry: string;
  }>(
    q,
    `select jsonb_build_object(
        'id', o.id, 'client_id', o.client_id, 'funder_name', fu.name, 'amount_cents', o.amount_cents,
        'factor_rate', o.factor_rate, 'position_no', o.position_no, 'status', o.status,
        'received_on', o.received_on, 'industry', c.industry) as j
       from offers o
       join submissions s on s.id = o.submission_id
       join funders fu on fu.id = s.funder_id
       join clients c on c.id = o.client_id
      where true ${hide}`,
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    funderName: r.funder_name,
    amountCents: r.amount_cents,
    factorRate: r.factor_rate,
    positionNo: r.position_no,
    status: r.status,
    receivedOn: r.received_on,
    industry: r.industry,
  }));
}

export async function listCompetingOffers(q: Db): Promise<CompetingOfferRow[]> {
  const hide = await hideTrashed(q);
  const rows = await json<{
    id: string;
    client_id: string;
    business_name: string;
    industry: string;
    funder_name: string;
    amount_cents: number | null;
    factor_rate: number | null;
    position_no: number | null;
    won: boolean;
  }>(
    q,
    `select jsonb_build_object(
        'id', o.id, 'client_id', o.client_id, 'business_name', c.business_name, 'industry', c.industry,
        'funder_name', o.funder_name, 'amount_cents', o.amount_cents, 'factor_rate', o.factor_rate,
        'position_no', o.position_no, 'won', o.won) as j
       from competing_offers o join clients c on c.id = o.client_id
      where true ${hide}`,
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    businessName: r.business_name,
    industry: r.industry,
    funderName: r.funder_name,
    amountCents: r.amount_cents,
    factorRate: r.factor_rate,
    positionNo: r.position_no,
    won: r.won,
  }));
}

export interface EarningsData {
  advances: AdvanceRow[];
  cards: ClientCard[];
  deals: DealRow[];
  funders: FunderTerms[];
  offers: (OfferRow & { industry: string })[];
  competing: CompetingOfferRow[];
  /** False when the Funders migration has not been applied: the price book then says what it is missing. */
  hasOffers: boolean;
  hasFunders: boolean;
}

export const dealOf = (c: ClientCard): DealRow => ({
  id: c.id,
  businessName: c.business_name,
  stage: c.stage,
  estApprovalCents: c.est_approval_cents,
});

/** One read of everything the earnings and renewals pages need. Run it inside db.withUser(). */
export async function loadEarningsData(q: Db): Promise<EarningsData> {
  const hasFunders = await tableExists(q, "funders");
  const hasOffers = await tableExists(q, "offers");
  // One query at a time: a pooled connection runs a single query at once.
  const cards = await listCards(q);
  const advances = await listAdvances(q);
  const competing = await listCompetingOffers(q);
  const funders = hasFunders ? await listFunderTerms(q) : [];
  const offers = hasOffers ? await listOffers(q) : [];
  return {
    advances,
    cards,
    deals: cards.map(dealOf),
    funders,
    offers,
    competing,
    hasOffers,
    hasFunders,
  };
}
