import type { Db } from "../db";
import { getCard } from "../data/queries";
import { UserError } from "../data/mutations";
import { checkFit, merchantFacts, type FitResult } from "../funders/fit";
import type { FunderRow } from "../funders/types";
import type { DealRow } from "./types";

/**
 * Reshop (S2-10). When every lender declined, the candidates are the lenders whose rules fit the merchant and who
 * have not seen this merchant on any deal; one click closes the declined deal, opens a new one pre-filled, and asks
 * the merchant for the newest statement (start_reshop, 0514).
 */
export interface ReshopCandidate {
  funderId: string;
  name: string;
  fit: FitResult;
}

export async function reshopCandidates(q: Db, clientId: string): Promise<ReshopCandidate[]> {
  const card = await getCard(q, clientId);
  if (!card) throw new UserError("That merchant isn't in your view");
  const facts = merchantFacts(card);
  const seen = new Set(
    (
      await q.query<{ funder_id: string }>(
        "select distinct funder_id from submissions where client_id = $1",
        [clientId],
      )
    ).rows.map((r) => r.funder_id),
  );
  const { rows } = await q.query<FunderRow>(
    "select * from funders where active and submission_email <> '' order by lower(name)",
  );
  const rank = { fits: 0, check: 1, warn: 2 } as const;
  return rows
    .filter((f) => !seen.has(f.id))
    .map((f) => ({ funderId: f.id, name: f.name, fit: checkFit(f, facts) }))
    .filter((c) => c.fit.level !== "warn")
    .sort((a, b) => rank[a.fit.level] - rank[b.fit.level] || a.name.localeCompare(b.name));
}

export async function startReshop(q: Db, clientId: string): Promise<Omit<DealRow, "status">> {
  const { rows } = await q.query<Omit<DealRow, "status">>("select * from start_reshop($1)", [
    clientId,
  ]);
  const d = rows[0];
  if (!d) throw new Error("start_reshop returned no row");
  return d;
}
