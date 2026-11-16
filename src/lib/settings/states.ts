import type { Db } from "../db";
import { STATES } from "../funders/states";
import type { RegistrationStatus } from "./schemas";

/** One state's rules (kept by the shop's lawyer) beside the shop's registration there, if any. */
export interface StateLine {
  state: string;
  name: string;
  broker_registration: boolean;
  registration_deadline: string | null;
  advance_fee_ban: boolean;
  apr_wording_rule: boolean;
  disclosure_law: boolean;
  note: string;
  source_url: string;
  last_reviewed: string;
  /** null = the shop has nothing on file for this state. */
  status: RegistrationStatus | null;
  registration_no: string;
  renews_on: string | null;
  registration_note: string;
}

export async function listStateLines(q: Db): Promise<StateLine[]> {
  const { rows } = await q.query<Omit<StateLine, "name">>(
    `select r.state::text as state, r.broker_registration, r.registration_deadline::text as registration_deadline,
            r.advance_fee_ban, r.apr_wording_rule, r.disclosure_law, r.note, r.source_url, r.last_reviewed::text as last_reviewed,
            g.status, coalesce(g.registration_no, '') as registration_no, g.renews_on::text as renews_on,
            coalesce(g.note, '') as registration_note
       from state_rules r left join shop_registrations g on g.state = r.state
      order by r.state`,
  );
  return rows.map((r) => ({ ...r, name: STATES[r.state] ?? r.state }));
}

/** Plain words for how close a renewal is, against today's date in the shop's calendar. */
export function renewalTone(
  renewsOn: string | null,
  today: string,
): { tone: "bad" | "warn" | "good" | "neutral"; text: string } {
  if (!renewsOn) return { tone: "neutral", text: "no date" };
  const days = Math.round(
    (Date.parse(`${renewsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return { tone: "bad", text: `lapsed ${-days} day${days === -1 ? "" : "s"} ago` };
  if (days <= 30)
    return {
      tone: "warn",
      text: days === 0 ? "renews today" : `renews in ${days} day${days === 1 ? "" : "s"}`,
    };
  return { tone: "good", text: `renews in ${days} days` };
}
