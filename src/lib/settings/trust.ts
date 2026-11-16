import type { Db } from "../db";

/*
 * Team & trust, the parts the trust panel does not already carry: who has accepted the anti-backdoor policy, and what
 * each kind of trust alert means. The alerts themselves are written by the hourly job (lib/system/alerts.ts); here
 * they are only read, as the signed-in manager.
 */

/** The four things the trust watcher alerts on, in the order a manager should worry about them. */
export const TRUST_ALERT_KINDS = [
  {
    key: "canary",
    label: "Canary touched",
    explain:
      "A fake merchant seeded in a rep's book was opened. Any call to its number says whose book leaked.",
  },
  {
    key: "others",
    label: "Another rep's lead",
    explain:
      "A rep opened or copied a merchant that belongs to someone else. Ask why before it becomes a habit.",
  },
  {
    key: "copies",
    label: "Burst of copies",
    explain:
      "Many contact details copied inside one hour (20 or more). A busy day does not look like this.",
  },
  {
    key: "after_hours",
    label: "Copies after hours",
    explain: "Contact details copied outside 7am to 8pm in the person's own time zone.",
  },
] as const;
export type TrustAlertKey = (typeof TRUST_ALERT_KINDS)[number]["key"];

/** Older and newer alert rows name the same four patterns differently; map every spelling to one key. */
const ALIASES: Record<string, TrustAlertKey> = {
  canary: "canary",
  canary_touched: "canary",
  others: "others",
  others_lead_copy: "others",
  copies: "copies",
  copy_burst: "copies",
  after_hours: "after_hours",
  after_hours_copy: "after_hours",
};

/** Which pattern an alert row is: the hourly job writes kind 'trust' and puts the pattern in the dedupe key. */
export function trustAlertKey(kind: string, dedupeKey: string | null): TrustAlertKey | null {
  if (ALIASES[kind]) return ALIASES[kind];
  if (kind !== "trust" || !dedupeKey) return null;
  const part = dedupeKey.split(":")[1] ?? "";
  return ALIASES[part] ?? null;
}

export interface TrustAlertLine {
  id: string;
  key: TrustAlertKey;
  title: string;
  href: string;
  created_at: string;
  read: boolean;
}

/** The signed-in manager's own trust alerts from the last N days, newest first. */
export async function recentTrustAlerts(q: Db, days = 30, limit = 12): Promise<TrustAlertLine[]> {
  const { rows } = await q.query<{
    id: string;
    kind: string;
    dedupe_key: string | null;
    title: string;
    href: string;
    created_at: string;
    read: boolean;
  }>(
    `select id::text as id, kind, dedupe_key, title, href, created_at::text as created_at, read_at is not null as read
       from user_alerts
      where user_id = app.current_user_id()
        and (kind = 'trust' or kind in ('canary_touched', 'others_lead_copy', 'copy_burst', 'after_hours_copy'))
        and created_at > now() - make_interval(days => $1)
      order by created_at desc limit $2`,
    [days, limit],
  );
  return rows.flatMap((r) => {
    const key = trustAlertKey(r.kind, r.dedupe_key);
    return key
      ? [{ id: r.id, key, title: r.title, href: r.href, created_at: r.created_at, read: r.read }]
      : [];
  });
}

/** When each active person accepted the policy (null = not yet). A manager reads everyone's. */
export async function policyAcceptance(q: Db): Promise<Record<string, string | null>> {
  const { rows } = await q.query<{ id: string; at: string | null }>(
    "select id, policy_accepted_at::text as at from app_users",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.at]));
}
