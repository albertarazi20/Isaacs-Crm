import { createHash } from "node:crypto";
import { db as defaultDb, type DbAccess } from "../db";
import { clientIp } from "../docs/clientIp";

/**
 * Fixed-window rate limits for the public token pages, kept in Postgres (0574) so every serverless instance counts
 * together. One atomic upsert per request: the hit is counted and the verdict read in the same statement, so a burst of
 * parallel requests cannot all pass a check made before any of them counted.
 */

export interface Verdict {
  /** false: this request is over the limit and must be refused */
  allowed: boolean;
  /** Seconds until the window ends and counting starts again; 0 while allowed. */
  retryAfter: number;
  /** Hits in this window including this one. */
  hits: number;
}

interface Opts {
  db?: DbAccess;
  /** The clock. The database's own time unless a test moves it. */
  now?: Date;
}

/**
 * Counts one hit against `key` in the current fixed window (windows are aligned to the epoch, `windowSeconds` long)
 * and says whether it is within `limit`. Hits over the limit are still counted but never extend the window.
 */
export async function hit(
  key: string,
  limit: number,
  windowSeconds: number,
  { db = defaultDb, now }: Opts = {},
): Promise<Verdict> {
  const { rows } = await db.withSystem((q) =>
    q.query<{ hits: number; left_seconds: number }>(
      `with c as (select coalesce($3::timestamptz, now()) as t)
       insert into rate_limits as r (key, window_start, hits)
       select $1, to_timestamp(floor(extract(epoch from c.t) / $2::int) * $2::int), 1 from c
       on conflict (key, window_start) do update set hits = least(r.hits + 1, 1000000)
       returning r.hits,
         extract(epoch from (r.window_start + make_interval(secs => $2::int) - (select t from c)))::float8 as left_seconds`,
      [key, windowSeconds, now ?? null],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("rate limit counter returned nothing");
  const allowed = row.hits <= limit;
  return {
    allowed,
    retryAfter: allowed ? 0 : Math.max(1, Math.ceil(row.left_seconds)),
    hits: row.hits,
  };
}

/** One rule: how many hits a key may make in a window. */
export interface Rule {
  limit: number;
  windowSeconds: number;
}

const TEN_MINUTES = 600;

/**
 * The limits. Each is far above what a person does: the offer page sends one file per document (six) and asks after
 * each, the upload page sends a whole batch in one request. They exist to stop a script, not to meter a merchant.
 *
 * The per-address numbers are generous on purpose, because one address is often many people (an office, a carrier's
 * shared address). And they are counted only for a link that exists: a guess at a link that does not exist is counted
 * in the much smaller `invalidLinkIp` bucket instead, so strangers' guessing neither uses up the room real merchants
 * share on their address nor gets a counter of its own per guess.
 */
export const LIMITS = {
  /** Upload posts to a real link, per client address. Per link (below) is what protects each link. */
  uploadIp: { limit: 200, windowSeconds: TEN_MINUTES },
  /** Upload posts, per link. A merchant can retry a few files; a script guessing at one link cannot. */
  uploadToken: { limit: 15, windowSeconds: TEN_MINUTES },
  /** Upload page's "what is still wanted" reads of a real link, per address. */
  uploadInfoIp: { limit: 300, windowSeconds: TEN_MINUTES },
  /** Requests naming a link that does not exist (upload, apply, offer), per address: a real person fails a few times at most. */
  invalidLinkIp: { limit: 20, windowSeconds: TEN_MINUTES },
  /** Application signatures on a real link, per address. */
  applyIp: { limit: 60, windowSeconds: TEN_MINUTES },
  /** Offer page reads and accepts on a real link, per address. */
  offerIp: { limit: 300, windowSeconds: TEN_MINUTES },
  seenIp: { limit: 300, windowSeconds: TEN_MINUTES },
  unsubscribeIp: { limit: 30, windowSeconds: TEN_MINUTES },
  /** Google sign-in round trips (/api/auth/google and /api/auth/callback), per address. */
  authIp: { limit: 30, windowSeconds: TEN_MINUTES },
} as const satisfies Record<string, Rule>;

/**
 * With no readable client address everyone shares one bucket per route, so its limit is this many times higher: a
 * missing header must not lock every merchant out, while a script is still bounded. (Behind Netlify the platform
 * header is always present, so this is the off-platform case. Same idea as passcodeKey in users.ts.)
 */
export const NO_ADDRESS_FACTOR = 10;

const MAX_ADDRESS_CHARS = 64;

/** The key for a request: route name plus client address, or the route's shared no-address bucket. */
export const ipKey = (route: string, address: string): string =>
  address ? `${route}:ip:${address.slice(0, MAX_ADDRESS_CHARS)}` : `${route}:no-address`;

/** The key for a link's token. Hashed, so a working token is never written down in the counter table. */
export const tokenKey = (route: string, token: string): string =>
  `${route}:tok:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;

/** A broken counter must not take the public pages down with it: log it and let the request through. */
async function failOpen(count: () => Promise<Verdict>): Promise<Verdict> {
  try {
    return await count();
  } catch (e) {
    console.error("rate limit not counted:", e);
    return { allowed: true, retryAfter: 0, hits: 0 };
  }
}

/** Counts this request against its client address for `route`. */
export function limitByIp(
  route: string,
  headers: Headers,
  rule: Rule,
  opts: Opts = {},
): Promise<Verdict> {
  const address = clientIp(headers);
  const limit = address ? rule.limit : rule.limit * NO_ADDRESS_FACTOR;
  return failOpen(() => hit(ipKey(route, address), limit, rule.windowSeconds, opts));
}

/** Counts this request against one link's token for `route`. */
export function limitByToken(
  route: string,
  token: string,
  rule: Rule,
  opts: Opts = {},
): Promise<Verdict> {
  return failOpen(() => hit(tokenKey(route, token), rule.limit, rule.windowSeconds, opts));
}

/** Plain words for how long to wait. */
function waitPhrase(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

/** The refusal: 429, a Retry-After header, and a plain friendly message. `json` for pages' scripts, `text` otherwise. */
export function tooManyRequests(retryAfter: number, kind: "json" | "text" = "json"): Response {
  const message = `Too many requests from your connection. Please wait ${waitPhrase(retryAfter)} and try again.`;
  const headers = { "retry-after": String(Math.max(1, retryAfter)), "cache-control": "no-store" };
  return kind === "json"
    ? Response.json({ error: message }, { status: 429, headers })
    : new Response(message, {
        status: 429,
        headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
      });
}

export { waitPhrase };

/** Deletes counters from windows that ended more than a day ago. Returns how many rows went. */
export async function sweepRateLimits(db: DbAccess = defaultDb): Promise<number> {
  const { rowCount } = await db.withSystem((q) =>
    q.query("delete from rate_limits where window_start < now() - interval '1 day'"),
  );
  return rowCount ?? 0;
}
