import type { Db } from "../db";

/**
 * What the security log is made of, in plain words: the kinds of event, one short sentence for each, and the read
 * for Settings > Security. The write side (and the alerts) is src/lib/system/audit.ts. Pure apart from the read,
 * which runs as the signed-in person, so row security keeps it to managers.
 */

export const AUDIT_KINDS = [
  "signin_ok",
  "signin_failed",
  "signout",
  "signout_everywhere",
  "session_killed",
  "team_added",
  "team_role_changed",
  "team_disabled",
  "team_enabled",
  "lead_token_created",
  "lead_token_revoked",
  "settings_shop_saved",
  "settings_approvals_saved",
  "settings_ai_saved",
  "gmail_connected",
  "gmail_disconnected",
  "export_download",
  "export_blocked",
  "merchant_emails_stopped",
  "merchant_emails_resumed",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** The words a filter and a row use for each kind. */
export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  signin_ok: "Signed in",
  signin_failed: "Failed sign-in",
  signout: "Signed out",
  signout_everywhere: "Signed out everywhere",
  session_killed: "Session ended",
  team_added: "Person added",
  team_role_changed: "Role changed",
  team_disabled: "Login switched off",
  team_enabled: "Login switched on",
  lead_token_created: "Lead connection made",
  lead_token_revoked: "Lead connection turned off",
  settings_shop_saved: "Email settings saved",
  settings_approvals_saved: "Approval settings saved",
  settings_ai_saved: "AI settings saved",
  gmail_connected: "Gmail connected",
  gmail_disconnected: "Gmail disconnected",
  export_download: "Export downloaded",
  export_blocked: "Export refused",
  merchant_emails_stopped: "Merchant emails stopped",
  merchant_emails_resumed: "Merchant emails turned back on",
};

/** The last 200 events are what the page shows. */
export const AUDIT_PAGE_SIZE = 200;

export interface AuditRow {
  id: string;
  at: string;
  user_id: string | null;
  email: string;
  kind: string;
  ip: string;
  user_agent: string;
  detail: Record<string, unknown>;
}

export interface AuditFilter {
  kind?: string;
  userId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest events, optionally one kind or one person. A filter that is not a known kind or an id is ignored. */
export async function listAuditEvents(q: Db, f: AuditFilter = {}): Promise<AuditRow[]> {
  const kind = f.kind && (AUDIT_KINDS as readonly string[]).includes(f.kind) ? f.kind : null;
  const userId = f.userId && UUID.test(f.userId) ? f.userId : null;
  const { rows } = await q.query<AuditRow>(
    // order by the real column: a bare "at" would mean the formatted output column of the same name (whole seconds)
    `select e.id::text as id,
            to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
            e.user_id::text as user_id, e.email, e.kind, e.ip, e.user_agent, e.detail
       from audit_events e
      where ($1::text is null or e.kind = $1)
        and ($2::uuid is null or e.user_id = $2)
      order by e.at desc, e.id
      limit $3`,
    [kind, userId, AUDIT_PAGE_SIZE],
  );
  return rows;
}

/** Everyone who appears in the log, for the person filter. */
export async function auditPeople(q: Db): Promise<{ user_id: string; email: string }[]> {
  const { rows } = await q.query<{ user_id: string; email: string }>(
    `select distinct on (user_id) user_id::text as user_id, email
       from audit_events
      where user_id is not null and email <> ''
      order by user_id, at desc`,
  );
  return rows.sort((a, b) => a.email.localeCompare(b.email));
}

/** "Chrome on Mac", "Safari on iPhone": enough to tell two devices apart in a sentence. */
export function browserOf(userAgent: string): string {
  const ua = userAgent;
  if (!ua) return "an unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "a browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux|CrOS/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const KEY_WORDS: Record<string, string> = {
  daily_cap: "daily send cap",
  amber_at: "warning level",
  reserved_for_intake: "slice held for new leads",
  shop_name: "shop name",
  postal_address: "postal address",
  sequences_enabled: "slowing sequences",
  send_window_start: "send window start",
  send_window_end: "send window end",
  send_on_weekends: "weekend sending",
  send_on_holidays: "holiday sending",
  per_merchant_daily: "emails per merchant a day",
  per_merchant_weekly: "emails per merchant a week",
  automation_from: "automation sender",
  automation_reply_to_rep: "replies go to the rep",
  open_nudge: "nudge after an open",
  approval_emails_on: "approval emails on or off",
  approval_window_start: "approval window start",
  approval_window_end: "approval window end",
  approval_weekends: "approval weekends",
  ai_enabled: "AI on or off",
  ai_model: "AI model",
  ai_daily_cap_cents: "AI daily cap",
  brain_on: "the brain on or off",
  brain_daily_per_rep: "brain preparations per rep",
  playbook: "house rules",
};
const keyWord = (k: string): string => KEY_WORDS[k] ?? k.replaceAll("_", " ");

/** One short plain sentence for a row: who did what, and the one fact that matters. */
export function describeEvent(r: Pick<AuditRow, "kind" | "email" | "detail">): string {
  const who = r.email || "Someone";
  const d = r.detail;
  switch (r.kind) {
    case "signin_ok":
      return `${who} signed in${str(d.method) === "passcode" ? " with the passcode" : ""}.`;
    case "signin_failed": {
      const why: Record<string, string> = {
        bad_passcode: "wrong passcode",
        not_allowed: "no active account for that address",
        bad_state: "the sign-in link was not valid",
        access_denied: "Google sign-in was cancelled",
        google_error: "Google sign-in failed",
        session_expired: "the session had expired",
      };
      const reason = why[str(d.reason)] ?? "it did not work";
      return `${r.email ? `A sign-in as ${r.email}` : "A sign-in"} failed: ${reason}.`;
    }
    case "signout":
      return `${who} signed out.`;
    case "signout_everywhere":
      return `${who} signed out of every device.`;
    case "session_killed":
      return `${str(d.target_email) || "A person"}'s sessions were ended (${
        str(d.reason) === "disabled" ? "login switched off" : "role changed"
      }).`;
    case "team_added":
      return `${who} added ${str(d.target_email)} as ${str(d.role)}.`;
    case "team_role_changed":
      return `${who} changed ${str(d.target_email)} from ${str(d.from)} to ${str(d.to)}.`;
    case "team_disabled":
      return `${who} switched off ${str(d.target_email)}'s login.`;
    case "team_enabled":
      return `${who} switched on ${str(d.target_email)}'s login.`;
    case "lead_token_created":
      return `${who} made a lead connection${str(d.label) ? ` named "${str(d.label)}"` : ""}.`;
    case "lead_token_revoked":
      return `${who} turned off a lead connection.`;
    case "settings_shop_saved":
    case "settings_approvals_saved":
    case "settings_ai_saved": {
      const keys = list(d.changed).map(keyWord);
      return keys.length > 0
        ? `${who} changed ${keys.join(", ")}.`
        : `${who} saved the settings with no change.`;
    }
    case "gmail_connected":
      return `${who} connected Gmail${str(d.google_email) ? ` (${str(d.google_email)})` : ""}.`;
    case "gmail_disconnected":
      return `${who} disconnected Gmail.`;
    case "export_download": {
      const rows = num(d.rows);
      return `${who} downloaded the ${str(d.export) || "an"} export${rows === null ? "" : `: ${rows} rows`}.`;
    }
    case "export_blocked":
      return `${who} was refused an export: too many in an hour.`;
    case "merchant_emails_stopped": {
      const cancelled = num(d.cancelled);
      return `${who} stopped all automated emails to a merchant${
        cancelled ? ` (${cancelled} queued email${cancelled === 1 ? "" : "s"} taken back)` : ""
      }.`;
    }
    case "merchant_emails_resumed":
      return `${who} turned automated emails back on for a merchant.`;
    default:
      return `${who}: ${r.kind.replaceAll("_", " ")}.`;
  }
}

/** The values worth showing for a settings change: numbers and on/off only, never text. */
export function settingsChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { changed: string[]; values: Record<string, { from: unknown; to: unknown }> } {
  // derived by the database when something else changes (the DNS check result, timestamps)
  const SKIP = new Set([
    "id",
    "updated_at",
    "dns_ok",
    "dns_checked_at",
    "dns_result",
    "open_nudge_since",
  ]);
  const changed: string[] = [];
  const values: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    changed.push(k);
    const small = (v: unknown) => typeof v === "number" || typeof v === "boolean";
    if (small(before[k]) && small(after[k])) values[k] = { from: before[k], to: after[k] };
  }
  return { changed, values };
}

/** The settings row as one object, for a before-and-after. */
export async function shopSnapshot(q: Db): Promise<Record<string, unknown>> {
  const { rows } = await q.query<{ j: Record<string, unknown> }>(
    "select to_jsonb(s) as j from shop_settings s",
  );
  return rows[0]?.j ?? {};
}
