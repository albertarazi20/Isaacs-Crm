import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { devLoginEnabled, env } from "../env";
import { isAllowedEmail } from "./google";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  signSession,
  verifySession,
  type SessionClaims,
} from "./session";

export async function getSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value, env().SESSION_SECRET);
  if (!claims) return null;
  // Removing someone from ALLOWED_EMAILS must end their session now, not in 14 days. (Dev login has no allowlist.)
  if (!devLoginEnabled() && !isAllowedEmail(claims.email, env().ALLOWED_EMAILS)) return null;
  return claims;
}

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
