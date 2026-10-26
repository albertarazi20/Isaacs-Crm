import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { devLoginEnabled, env } from "../env";
import { currentSessionEpoch } from "../system/users";
import { resolveSession } from "./resolve";
import { isAllowedEmail } from "./google";
import { SESSION_COOKIE, SESSION_DAYS, signSession, type SessionClaims } from "./session";

/** Cached per request: the layout, the page and any action all ask, and the epoch check is a database read. */
export const getSession = cache(async (): Promise<SessionClaims | null> => {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value, {
    secret: env().SESSION_SECRET,
    // Removing someone from ALLOWED_EMAILS must end their session now, not in 14 days. (Dev login has no allowlist.)
    allowed: (email) => devLoginEnabled() || isAllowedEmail(email, env().ALLOWED_EMAILS),
    // "Log out everywhere" (and a deleted user) must end the session now too.
    currentEpoch: currentSessionEpoch,
  });
});

export async function requireSession(): Promise<SessionClaims> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: maxAgeSeconds,
});

export async function sessionCookie(claims: SessionClaims) {
  return {
    name: SESSION_COOKIE,
    value: await signSession(claims, env().SESSION_SECRET),
    ...cookieOptions(SESSION_DAYS * 86_400),
  };
}
