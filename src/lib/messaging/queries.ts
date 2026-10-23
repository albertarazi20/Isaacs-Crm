import type { Db } from "../db";
import type { ClientCard, UserContext } from "../data/types";
import type { SnippetKind } from "./defaults";
import { pickBestOffer, type OfferSummary } from "./merge";
import { buildWinback, WINBACK_STAGES, type OfferRecord, type WinbackRow } from "./winback";

export interface SnippetRow {
  id: string;
  title: string;
  kind: SnippetKind;
  body: string;
  sort: number;
}

export interface MessageSettings {
  signature: string;
  applicationLink: string;
}

export async function getMessageSettings(q: Db): Promise<MessageSettings> {
  const { rows } = await q.query<{ signature: string; application_link: string }>(
    "select signature, application_link from app_users where id = app.current_user_id()",
  );
  return { signature: rows[0]?.signature ?? "", applicationLink: rows[0]?.application_link ?? "" };
}

export async function listSnippets(q: Db): Promise<SnippetRow[]> {
  const { rows } = await q.query<SnippetRow>(
    "select id, title, kind, body, sort from snippets order by kind, sort, created_at, id",
  );
  return rows;
}

/** What the Text and Email dialogs need for one merchant, in one round trip. */
export interface MessagingContext extends MessageSettings {
  snippets: SnippetRow[];
  wantedAmountCents: number | null;
  bestOffer: OfferSummary | null;
}

function toSummary(o: OfferRecord): OfferSummary {
  return {
    funderName: o.funder_name,
    amountCents: o.amount_cents,
    factorRate: o.factor_rate,
    termDays: o.term_days,
    offeredOn: o.offered_on,
    won: o.won,
  };
}

const offerSql = `select to_jsonb(o) as j from competing_offers o`;

export async function getMessagingContext(q: Db, clientId: string): Promise<MessagingContext> {
  const settings = await getMessageSettings(q);
  const snippets = await listSnippets(q);
  const ask = await q.query<{ w: string | null }>(
    "select wanted_amount_cents::text as w from client_asks where client_id = $1 order by created_at desc limit 1",
    [clientId],
  );
  const offers = await q.query<{ j: OfferRecord }>(`${offerSql} where o.client_id = $1`, [
    clientId,
  ]);
  const best = pickBestOffer(
    offers.rows.map((r) => ({
      amountCents: r.j.amount_cents,
      factorRate: r.j.factor_rate,
      record: r.j,
    })),
  );
  const w = ask.rows[0]?.w;
  return {
    ...settings,
    snippets,
    wantedAmountCents: w ? Number(w) : null,
    bestOffer: best ? toSummary(best.record) : null,
  };
}

/** Win-back candidates: cards in a win-back stage that are OK to contact, plus the offers on lost deals. */
export async function loadWinback(q: Db, ctx: UserContext, days: number): Promise<WinbackRow[]> {
  const cards = await q.query<{ j: ClientCard }>(
    `select to_jsonb(c) as j from client_cards c
      where c.stage = any($1::text[]) and c.contact_status = 'ok' and c.next_due_on is not null
        and c.next_due_on <= ($2::date + $3::int)`,
    [WINBACK_STAGES, ctx.today, days],
  );
  const list = cards.rows.map((r) => r.j);
  const lostIds = list.filter((c) => c.stage === "lost").map((c) => c.id);
  const offers =
    lostIds.length === 0
      ? []
      : (
          await q.query<{ j: OfferRecord }>(`${offerSql} where o.client_id = any($1::uuid[])`, [
            lostIds,
          ])
        ).rows.map((r) => r.j);
  return buildWinback(list, offers, { today: ctx.today, days, timezone: ctx.timezone });
}
