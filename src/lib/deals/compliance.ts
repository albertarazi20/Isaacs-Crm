import type { Db } from "../db";
import {
  normalizeState,
  stateCompliance,
  type ShopRegistration,
  type StateBadge,
  type StateRules,
} from "../funders/states";

/**
 * The state badge and warnings for the deal header (S3-7): reads the two rows the rules need (`state_rules`, and the
 * shop's `shop_registrations` for that state) and hands them to the pure `stateCompliance`.
 */
export async function loadStateBadge(q: Db, rawState: string, today: string): Promise<StateBadge> {
  const code = normalizeState(rawState);
  if (code === null) return stateCompliance(rawState, null, null, today);
  const rules = (
    await q.query<StateRules>(
      `select state::text as state, broker_registration, registration_deadline::text as registration_deadline,
              advance_fee_ban, apr_wording_rule, disclosure_law, note
         from state_rules where state = $1`,
      [code],
    )
  ).rows[0];
  const registration = (
    await q.query<ShopRegistration>(
      `select state::text as state, status, renews_on::text as renews_on, registration_no
         from shop_registrations where state = $1`,
      [code],
    )
  ).rows[0];
  return stateCompliance(rawState, rules ?? null, registration ?? null, today);
}
