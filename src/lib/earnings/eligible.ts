import type { ClientCard } from "../data/types";
import { stageDef, type StageKey } from "../mca/stages";

/** Deals that have an offer in hand or a contract out: close enough to count as coming. */
export const PIPELINE_STAGES: readonly StageKey[] = [
  "offers_in",
  "offer_presented",
  "contract_out",
];

/** Why an active advance is not a renewal call Isaac can make (and so not money he can count on). */
export type NotRenewable = "dnc" | "exit" | "in_deal";

export interface Excluded {
  dnc: number;
  exit: number;
  inDeal: number;
}

export const noExclusions = (): Excluded => ({ dnc: 0, exit: 0, inDeal: 0 });

/**
 * A do-not-contact merchant cannot be called; one who said no (or went elsewhere) is not a renewal. Both stay out of
 * the call list and the dollars. `pipeline` additionally drops merchants already in a funding deal: the Pipeline tile
 * prices that deal, and counting the old advance too would count the same renewal twice.
 */
export function notRenewable(
  card: Pick<ClientCard, "stage" | "contact_status">,
  opts: { pipeline: boolean },
): NotRenewable | null {
  if (card.contact_status === "dnc") return "dnc";
  if (stageDef(card.stage).group === "exit") return "exit";
  if (opts.pipeline && PIPELINE_STAGES.includes(card.stage)) return "in_deal";
  return null;
}

export function tally(ex: Excluded, why: NotRenewable): void {
  if (why === "in_deal") ex.inDeal += 1;
  else ex[why] += 1;
}

/** "2 said no, 1 do-not-contact" — null when nothing was left out. */
export function excludedLine(ex: Excluded): string | null {
  const parts = [
    ex.exit > 0 ? `${ex.exit} said no or went elsewhere` : "",
    ex.dnc > 0 ? `${ex.dnc} marked do-not-contact` : "",
    ex.inDeal > 0 ? `${ex.inDeal} already in a funding deal` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `Left out: ${parts.join(", ")}.` : null;
}
