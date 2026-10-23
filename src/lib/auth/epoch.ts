import type { SessionClaims } from "./session";

/**
 * A session only counts while its epoch equals the user's current one. "Log out everywhere" bumps the
 * current one; a user who no longer exists has none, so their old tokens die too.
 */
export async function epochMatches(
  claims: SessionClaims,
  lookup: (userId: string) => Promise<number | null>,
): Promise<boolean> {
  const current = await lookup(claims.userId);
  return current !== null && current === (claims.epoch ?? 0);
}
