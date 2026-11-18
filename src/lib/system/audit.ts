/**
 * The security audit log (0573): who signed in, from where, what they changed, what they downloaded. Rows are written
 * on the owner connection and read by managers on Settings > Security. This file is the only writer.
 *
 * recordAudit never throws into the caller's request: a log line that cannot be written must not stop a sign-in, a
 * settings save or an export, so every failure is caught and logged (the kind and the error message, nothing else).
 *
 * Alerts to the managers (the in-app alert feed, bundled into the hourly alert email) come from here too:
 *   - a sign-in from a device (address + browser) this person has not used in 90 days, when they have signed in before;
 *   - one export of more than 500 rows, or more than 5 exports in an hour by one person;
 *   - 5 or more failed sign-ins for the same email or the same address within 15 minutes (one alert an hour in total,
 *     whoever the subject, so a stream of different ones cannot fill the feed).
 * Per-person export limit: 20 downloads in an hour, counted from this table; the 21st is refused with a 429.
 */
import { headers } from "next/headers";
import { db as defaultDb, type Db, type DbAccess } from "../db";
import { clientIp } from "../docs/clientIp";
import { browserOf, type AuditKind } from "../settings/securityLog";

export type { AuditKind };

export interface AuditInput {
  kind: AuditKind;
  userId?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Facts only: which keys changed, how many rows, a label. Never a secret, a token or a merchant's details. */
  detail?: Record<string, unknown>;
  clientId?: string | null;
}

export const AUDIT_RETENTION_DAYS = 180;
export const NEW_DEVICE_WINDOW_DAYS = 90;
/** One export of more than this many rows alerts the managers. */
export const EXPORT_ROWS_ALERT = 500;
/** More than this many exports by one person in an hour alerts the managers. */
export const EXPORT_BURST_ALERT = 5;
/** A person who already made this many exports in the last hour is refused the next. */
export const EXPORT_HOURLY_LIMIT = 20;
/** This many failed sign-ins for one email or one address within the window alert the managers. */
export const FAILED_SIGNIN_ALERT_AT = 5;
export const FAILED_SIGNIN_WINDOW_MINUTES = 15;
/**
 * A flood guard: from one address, failed sign-ins past this many in the window are no longer written (the alert has
 * long since fired), so an unauthenticated loop cannot fill the table.
 */
export const FAILED_SIGNIN_LOG_CAP = 100;
/**
 * The same guard across every address together (and the only one that can see through a forged or unreadable
 * address): no more than this many failed lines are written in an hour in all.
 */
export const FAILED_SIGNIN_GLOBAL_CAP = 500;

const MAX_DETAIL_BYTES = 8_000;
const ALERT_HREF = "/settings/security";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clip = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

interface Event {
  kind: AuditKind;
  userId: string | null;
  email: string;
  ip: string;
  userAgent: string;
  detail: string;
  clientId: string | null;
}

function normalise(i: AuditInput): Event {
  let detail = JSON.stringify(i.detail ?? {});
  if (detail.length > MAX_DETAIL_BYTES) detail = JSON.stringify({ truncated: true });
  return {
    kind: i.kind,
    userId: i.userId ?? null,
    email: clip(i.email, 200).toLowerCase(),
    ip: clip(i.ip, 64),
    userAgent: clip(i.userAgent, 300),
    detail,
    clientId: i.clientId ?? null,
  };
}

/** The address and browser of the request being served. Empty strings outside a request (a test, a cron job). */
export async function requestMeta(h?: Headers): Promise<{ ip: string; userAgent: string }> {
  try {
    const hs = h ?? (await headers());
    return { ip: clientIp(hs), userAgent: hs.get("user-agent") ?? "" };
  } catch {
    return { ip: "", userAgent: "" };
  }
}

async function insertEvent(q: Db, e: Event): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `insert into audit_events (user_id, email, kind, ip, user_agent, detail, client_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id::text as id`,
    [e.userId, e.email, e.kind, e.ip, e.userAgent, e.detail, e.clientId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("audit insert returned no row");
  return id;
}

/** One alert for every manager; the dedupe key makes a repeat a no-op. */
async function alertManagers(
  q: Db,
  kind: string,
  title: string,
  body: string,
  dedupe: string,
): Promise<void> {
  await q.query("select app.alert_managers($1, null, null, $2, $3, $4, $5)", [
    kind,
    title,
    body,
    ALERT_HREF,
    dedupe,
  ]);
}

/** Alerts must never undo or hide the event they are about, so they run after it is committed. */
async function raise(access: DbAccess, what: string, fn: (q: Db) => Promise<void>): Promise<void> {
  try {
    await access.withSystem(fn);
  } catch (err) {
    console.error(`audit: could not raise the ${what} alert:`, message(err));
  }
}

/**
 * Writes one event. Never throws. A successful sign-in from a new device, a failed sign-in and an export each go on
 * to the alert checks above.
 */
export async function recordAudit(input: AuditInput, access: DbAccess = defaultDb): Promise<void> {
  try {
    const e = normalise(input);
    if (e.kind === "signin_failed") return await recordFailedSignIn(access, e);
    const newDevice = await access.withSystem(async (q) => {
      const fresh = e.kind === "signin_ok" ? await isNewDevice(q, e) : false;
      await insertEvent(q, e);
      return fresh;
    });
    if (newDevice) await raise(access, "new device", (q) => alertNewDevice(q, e));
    if (e.kind === "export_download") await exportAlerts(access, e);
  } catch (err) {
    console.error(`audit: could not record ${input.kind}:`, message(err));
  }
}

// ---------- sign-ins ----------

/** True when this person has signed in before but never from this address and browser in the last 90 days. */
async function isNewDevice(q: Db, e: Event): Promise<boolean> {
  if (!e.userId || (e.ip === "" && e.userAgent === "")) return false;
  const { rows } = await q.query<{ signed_before: boolean; seen: boolean }>(
    `select exists (select 1 from audit_events where user_id = $1 and kind = 'signin_ok') as signed_before,
            exists (select 1 from audit_events
                     where user_id = $1 and ip = $2 and user_agent = $3
                       and at > now() - make_interval(days => $4::int)) as seen`,
    [e.userId, e.ip, e.userAgent, NEW_DEVICE_WINDOW_DAYS],
  );
  const r = rows[0];
  return Boolean(r?.signed_before) && !r?.seen;
}

async function alertNewDevice(q: Db, e: Event): Promise<void> {
  const who = e.email || "A person";
  await alertManagers(
    q,
    "security_new_device",
    `New device sign-in for ${who}`.slice(0, 200),
    `${who} signed in from ${e.ip || "an unknown address"} using ${browserOf(e.userAgent)}. They have not used this device in the last ${NEW_DEVICE_WINDOW_DAYS} days. If it was not them, switch their login off in Team.`,
    // one per person and device per day: two sign-ins in the same minute raise it once
    `new_device:${e.userId}:${e.ip}:${e.userAgent}:${new Date().toISOString().slice(0, 10)}`.slice(
      0,
      400,
    ),
  );
}

const failuresFor = async (q: Db, column: "email" | "ip", value: string): Promise<number> => {
  // the column is one of two fixed words, never input, so each has its own statement
  const sql =
    column === "email"
      ? "select count(*)::int as n from audit_events where kind = 'signin_failed' and email = $1 and at > now() - make_interval(mins => $2::int)"
      : "select count(*)::int as n from audit_events where kind = 'signin_failed' and ip = $1 and at > now() - make_interval(mins => $2::int)";
  const { rows } = await q.query<{ n: number }>(sql, [value, FAILED_SIGNIN_WINDOW_MINUTES]);
  return rows[0]?.n ?? 0;
};

const failuresInLastHour = async (q: Db): Promise<number> => {
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from audit_events where kind = 'signin_failed' and at > now() - interval '1 hour'",
  );
  return rows[0]?.n ?? 0;
};

async function recordFailedSignIn(access: DbAccess, e: Event): Promise<void> {
  const counts = await access.withSystem(async (q) => {
    // the flood guard: an address that has already filled the window is not written down again (an unreadable address
    // is one address here: all of them share the empty string), and past the cap for all addresses in an hour nothing is
    if ((await failuresFor(q, "ip", e.ip)) >= FAILED_SIGNIN_LOG_CAP) return null;
    if ((await failuresInLastHour(q)) >= FAILED_SIGNIN_GLOBAL_CAP) return null;
    await insertEvent(q, e);
    return {
      byEmail: e.email === "" ? 0 : await failuresFor(q, "email", e.email),
      byIp: e.ip === "" ? 0 : await failuresFor(q, "ip", e.ip),
    };
  });
  if (!counts) return;
  const hot = [
    { n: counts.byEmail, label: `the email ${e.email}` },
    { n: counts.byIp, label: `the address ${e.ip}` },
  ].filter((s) => s.n >= FAILED_SIGNIN_ALERT_AT);
  if (hot.length === 0) return;
  const hour = new Date().toISOString().slice(0, 13);
  // one alert however many of the two crossed the line together, and at most one an hour in total: the key has no
  // subject in it, so a stream of different emails and addresses cannot fill the managers' feed (the lines are all in
  // the log; the alert says where to look)
  await raise(access, "failed sign-ins", (q) =>
    alertManagers(
      q,
      "security_failed_signins",
      "Repeated failed sign-ins",
      `${hot.map((s) => `${s.n} for ${s.label}`).join("; ")} in the last ${FAILED_SIGNIN_WINDOW_MINUTES} minutes.`,
      `failed_signins:${hour}`,
    ),
  );
}

// ---------- exports ----------

export interface ExportLimit {
  blocked: boolean;
  /** seconds until the oldest of the person's recent exports ages out of the hour */
  retryAfterSeconds: number;
}

const exportWindow = async (q: Db, userId: string): Promise<ExportLimit> => {
  const { rows } = await q.query<{ n: number; retry: number | null }>(
    `select count(*)::int as n,
            ceil(extract(epoch from (min(at) + interval '1 hour' - now())))::int as retry
       from audit_events where user_id = $1 and kind = 'export_download' and at > now() - interval '1 hour'`,
    [userId],
  );
  const r = rows[0];
  const blocked = (r?.n ?? 0) >= EXPORT_HOURLY_LIMIT;
  return { blocked, retryAfterSeconds: blocked ? Math.max(1, r?.retry ?? 60) : 0 };
};

/** The 429 a person over the limit gets, in plain words. */
export function tooManyExports(retryAfterSeconds: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return new Response(
    `You have already made ${EXPORT_HOURLY_LIMIT} exports in the last hour. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(Math.max(1, retryAfterSeconds)),
        "cache-control": "no-store",
      },
    },
  );
}

interface ExportWho {
  userId: string;
  email: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Before the export is built: a person who has made 20 in the last hour gets the 429 at once (and the refusal is
 * logged, at most once in ten minutes). Null means go ahead. If the log cannot be read the export goes ahead: the
 * database that answers the export is the same one, and a broken log must not lock the managers out.
 */
export async function refuseIfOverExportLimit(
  who: ExportWho,
  access: DbAccess = defaultDb,
): Promise<Response | null> {
  try {
    const limit = await access.withSystem(async (q) => {
      const l = await exportWindow(q, who.userId);
      if (l.blocked) {
        await q.query(
          `insert into audit_events (user_id, email, kind, ip, user_agent, detail)
           select $1, $2, 'export_blocked', $3, $4, $5::jsonb
            where not exists (select 1 from audit_events
                               where user_id = $1 and kind = 'export_blocked' and at > now() - interval '10 minutes')`,
          [
            who.userId,
            clip(who.email, 200).toLowerCase(),
            clip(who.ip, 64),
            clip(who.userAgent, 300),
            JSON.stringify({ limit: EXPORT_HOURLY_LIMIT }),
          ],
        );
      }
      return l;
    });
    return limit.blocked ? tooManyExports(limit.retryAfterSeconds) : null;
  } catch (err) {
    console.error("audit: could not check the export limit:", message(err));
    return null;
  }
}

/**
 * After the export is built: writes the download line, and in the same locked step re-checks the limit so two
 * downloads started together cannot both slip under it. Returns the 429 when the limit was reached in the meantime
 * (the file is then not sent), null otherwise. Also runs the export alerts. Never throws.
 */
export async function recordExportDownload(
  who: ExportWho & { what: string; rows: number },
  access: DbAccess = defaultDb,
): Promise<Response | null> {
  try {
    const e = normalise({
      kind: "export_download",
      userId: who.userId,
      email: who.email,
      ip: who.ip,
      userAgent: who.userAgent,
      detail: { export: who.what, rows: who.rows },
    });
    const limit = await access.withSystem(async (q) => {
      await q.query("select pg_advisory_xact_lock(hashtext($1))", [`audit-export:${who.userId}`]);
      const l = await exportWindow(q, who.userId);
      if (!l.blocked) await insertEvent(q, e);
      return l;
    });
    if (limit.blocked) return tooManyExports(limit.retryAfterSeconds);
    await exportAlerts(access, e);
    return null;
  } catch (err) {
    console.error("audit: could not record the export:", message(err));
    return null;
  }
}

async function exportAlerts(access: DbAccess, e: Event): Promise<void> {
  if (!e.userId) return;
  const userId = e.userId;
  const detail = JSON.parse(e.detail) as { export?: string; rows?: number };
  const who = e.email || "A person";
  const rows = typeof detail.rows === "number" ? detail.rows : 0;
  const hour = new Date().toISOString().slice(0, 13);
  if (rows > EXPORT_ROWS_ALERT) {
    await raise(access, "large export", (q) =>
      alertManagers(
        q,
        "security_export",
        `Large export by ${who}`.slice(0, 200),
        `${who} downloaded ${rows} rows (the ${detail.export ?? ""} export). Exports of more than ${EXPORT_ROWS_ALERT} rows are flagged.`,
        `export_large:${userId}:${new Date().toISOString().slice(0, 16)}:${rows}`,
      ),
    );
  }
  await raise(access, "many exports", async (q) => {
    const { rows: c } = await q.query<{ n: number }>(
      "select count(*)::int as n from audit_events where user_id = $1 and kind = 'export_download' and at > now() - interval '1 hour'",
      [userId],
    );
    const n = c[0]?.n ?? 0;
    if (n <= EXPORT_BURST_ALERT) return;
    await alertManagers(
      q,
      "security_export",
      `Many exports by ${who}`.slice(0, 200),
      `${who} has made ${n} export downloads in the last hour. More than ${EXPORT_BURST_ALERT} in an hour is flagged.`,
      `export_many:${userId}:${hour}`,
    );
  });
}

// ---------- the request-scoped shortcut ----------

/** Records an event for the request being served: the address and browser come from its headers. Never throws. */
export async function recordAuditHere(
  input: Omit<AuditInput, "ip" | "userAgent">,
  h?: Headers,
): Promise<void> {
  await recordAudit({ ...input, ...(await requestMeta(h)) });
}

// ---------- retention ----------

/** Deletes lines older than the retention (180 days). Returns how many went. Run by the hourly job. */
export async function sweepAuditEvents(
  access: DbAccess = defaultDb,
  days: number = AUDIT_RETENTION_DAYS,
): Promise<number> {
  return access.withSystem(async (q) => {
    const res = await q.query(
      "delete from audit_events where at < now() - make_interval(days => $1::int)",
      [days],
    );
    return res.rowCount ?? 0;
  });
}
