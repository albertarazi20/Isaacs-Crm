import { pageAllowed } from "@/lib/nav";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { env } from "../env";
import { startSession, touchSession } from "../system/sessions";
import { currentSessionEpoch } from "../system/users";
import { resolveSessionOutcome, type Refusal, type SessionOutcome } from "./resolve";
import { CAN, type Role } from "./roles";
import { SESSION_COOKIE, SESSION_DAYS, signSession, type SessionClaims } from "./session";

/** Cached per request: the layout, the page and any action all ask, and the epoch and idle checks are database work. */
const sessionOutcome = cache(async (): Promise<SessionOutcome> => {
  const store = await cookies();
  return resolveSessionOutcome(store.get(SESSION_COOKIE)?.value, {
    secret: env().SESSION_SECRET,
    // Accounts are the allowlist now: a disabled or deleted account has no epoch, so its sessions end at once.
    allowed: () => true,
    // "Log out everywhere" (and a disabled or deleted user) must end the session now too.
    currentEpoch: currentSessionEpoch,
    // A session nobody has used for 12 hours ends, whatever the cookie says; use rolls the window forward.
    touch: (sid, userId, now) => touchSession(sid, userId, now),
  });
});

export const getSession = cache(async (): Promise<SessionClaims | null> => {
  return (await sessionOutcome()).claims;
});

/** Where a refused cookie sends the person: the sign-in page, saying so in plain words when it was the timeout. */
export function loginPathFor(reason: Refusal): string {
  if (reason === "idle") return "/login?reason=idle";
  if (reason === "expired") return "/login?error=session_expired";
  return "/login";
}

export async function requireSession(): Promise<SessionClaims> {
  const outcome = await sessionOutcome();
  if (!outcome.claims) redirect(loginPathFor(outcome.reason));
  return outcome.claims;
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

/** A fresh sign-in: records it for the idle timeout, then signs the cookie that carries its id. */
export async function sessionCookie(claims: SessionClaims) {
  const now = new Date();
  const sid = randomUUID();
  await startSession(sid, claims.userId, now);
  return {
    name: SESSION_COOKIE,
    value: await signSession({ ...claims, sid }, env().SESSION_SECRET, now),
    ...cookieOptions(SESSION_DAYS * 86_400),
  };
}

/**
 * A page outside the nav sends the user home with a one-line notice instead of rendering an empty shell
 * (anyone opening a page that no longer exists). Row security still guards the data; this guards the door.
 */
export async function requirePage(href: string): Promise<SessionClaims> {
  const session = await requireSession();
  if (!pageAllowed(href)) redirect(`/?denied=${encodeURIComponent(href.slice(1))}`);
  return session;
}
