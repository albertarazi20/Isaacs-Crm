import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { env } from "../env";
import { currentSessionEpoch } from "../system/users";
import { resolveSession } from "./resolve";
import { CAN, type Role } from "./roles";
import { SESSION_COOKIE, SESSION_DAYS, signSession, type SessionClaims } from "./session";

/** Cached per request: the layout, the page and any action all ask, and the epoch check is a database read. */
export const getSession = cache(async (): Promise<SessionClaims | null> => {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value, {
    secret: env().SESSION_SECRET,
    // Accounts are the allowlist now: a disabled or deleted account has no epoch, so its sessions end at once.
    allowed: () => true,
    // "Log out everywhere" (and a disabled or deleted user) must end the session now too.
    currentEpoch: currentSessionEpoch,
  });
});

export async function requireSession(): Promise<SessionClaims> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** A page or action only some roles may use. Sends everyone else home rather than erroring. */
export async function requireRole(check: (r: Role) => boolean): Promise<SessionClaims> {
  const session = await requireSession();
  if (!check(session.role)) redirect("/");
  return session;
}

export { CAN };

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
