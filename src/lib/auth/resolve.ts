import type { SessionClaims } from "./session";
import { verifySession } from "./session";
import { epochMatches } from "./epoch";

export interface ResolveDeps {
  secret: string;
  /** Sign-in is by Google allowlist; local dev login skips it. */
  allowed: (email: string) => boolean;
  /** The epoch a user's sessions must carry now, or null if the user is gone. */
  currentEpoch: (userId: string) => Promise<number | null>;
}

/**
 * Every rule that makes a session cookie count, in one place so each can be tested: a valid signature and
 * lifetime, an address still on the allowlist, and an epoch that "log out everywhere" hasn't moved past.
 */
export async function resolveSession(
  token: string | undefined,
  deps: ResolveDeps,
): Promise<SessionClaims | null> {
  const claims = await verifySession(token, deps.secret);
  if (!claims) return null;
  if (!deps.allowed(claims.email)) return null;
  if (!(await epochMatches(claims, deps.currentEpoch))) return null;
  return claims;
}
