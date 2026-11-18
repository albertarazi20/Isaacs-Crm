import type { SessionClaims } from "./session";
import { readSession } from "./session";
import { epochMatches } from "./epoch";

/** What the idle-timeout store says about a session: in use and fine, idle too long, or no record of it. */
export type TouchResult = "ok" | "idle" | "unknown";

export interface ResolveDeps {
  secret: string;
  /** Sign-in is by Google allowlist; local dev login skips it. */
  allowed: (email: string) => boolean;
  /** The epoch a user's sessions must carry now, or null if the user is gone. */
  currentEpoch: (userId: string) => Promise<number | null>;
  /**
   * Checks a session's idle timeout and rolls its window forward when it is due (at most every few minutes).
   * Only asked about sessions that carry an id.
   */
  touch: (sid: string, userId: string, now: Date) => Promise<TouchResult>;
  /** The clock. Real time unless a test moves it. */
  now?: () => Date;
}

/** Why a cookie did not count. "none" is no cookie at all; the rest drive what the sign-in page says. */
export type Refusal = "none" | "invalid" | "expired" | "idle" | "revoked";

export type SessionOutcome = { claims: SessionClaims } | { claims: null; reason: Refusal };

/**
 * Every rule that makes a session cookie count, in one place so each can be tested: a valid signature and
 * absolute lifetime, an address still on the allowlist, an epoch that "log out everywhere" hasn't moved past,
 * and an idle timeout the person hasn't run out. Says why, when it is a no.
 */
export async function resolveSessionOutcome(
  token: string | undefined,
  deps: ResolveDeps,
): Promise<SessionOutcome> {
  if (!token) return { claims: null, reason: "none" };
  const now = (deps.now ?? (() => new Date()))();
  const read = await readSession(token, deps.secret, now);
  if (!read.ok) return { claims: null, reason: read.reason };
  const claims = read.claims;
  if (!deps.allowed(claims.email)) return { claims: null, reason: "revoked" };
  // The epoch comes before the idle check so a disabled or logged-out-everywhere session is "revoked", never touched.
  if (!(await epochMatches(claims, deps.currentEpoch))) return { claims: null, reason: "revoked" };
  if (claims.sid && (await deps.touch(claims.sid, claims.userId, now)) !== "ok")
    return { claims: null, reason: "idle" };
  return { claims };
}

export async function resolveSession(
  token: string | undefined,
  deps: ResolveDeps,
): Promise<SessionClaims | null> {
  return (await resolveSessionOutcome(token, deps)).claims;
}
