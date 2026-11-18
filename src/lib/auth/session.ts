import { errors, jwtVerify, SignJWT } from "jose";
import { isRole, type Role } from "./roles";

export const SESSION_COOKIE = "isaac_session";
/** The absolute lifetime: a session ends this long after sign-in, however busy the person has been. */
export const SESSION_DAYS = 7;
/** The idle timeout: a session with no use for this long ends, however much of its lifetime is left. */
export const SESSION_IDLE_SECONDS = 12 * 3600;
/** Use rolls the idle window forward, but writes at most this often so a page load is not a database write. */
export const SESSION_ROLL_SECONDS = 5 * 60;

export interface SessionClaims {
  userId: string;
  email: string;
  /** Which "log out everywhere" generation this token belongs to. Tokens issued before it existed count as 0. */
  epoch?: number;
  /** The role at sign-in. Pages read it for layout; the database enforces it on every query regardless. */
  role: Role;
  /**
   * This sign-in's own id, the key of its idle-timeout row (src/lib/system/sessions.ts). Tokens issued before idle
   * timeouts existed have none; they are held to the absolute lifetime only, which ends them within a week.
   */
  sid?: string;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(
  claims: SessionClaims,
  secret: string,
  now = new Date(),
): Promise<string> {
  return new SignJWT({
    email: claims.email,
    ep: claims.epoch ?? 0,
    role: claims.role,
    ...(claims.sid ? { sid: claims.sid } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + SESSION_DAYS * 86_400)
    .sign(key(secret));
}

export type SessionRead =
  | { ok: true; claims: SessionClaims; issuedAt: number }
  | { ok: false; reason: "invalid" | "expired" };

/**
 * The token's signature, its own expiry and the absolute lifetime, all against `now` (a clock the tests can move).
 * The lifetime is checked against the signed issue time as well as the signed expiry, so a token minted when sessions
 * lasted longer cannot outlive today's limit. "expired" means it was genuine but too old.
 */
export async function readSession(
  token: string | undefined,
  secret: string,
  now = new Date(),
): Promise<SessionRead> {
  if (!token) return { ok: false, reason: "invalid" };
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      currentDate: now,
    });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string")
      return { ok: false, reason: "invalid" };
    if (typeof payload.iat !== "number") return { ok: false, reason: "invalid" };
    if (payload.iat + SESSION_DAYS * 86_400 <= Math.floor(now.getTime() / 1000))
      return { ok: false, reason: "expired" };
    const ep = typeof payload.ep === "number" && Number.isInteger(payload.ep) ? payload.ep : 0;
    // A token minted before roles existed belonged to the single owner; treat it as a rep and let sign-in refresh it.
    const role = isRole(payload.role) ? payload.role : "rep";
    const sid = typeof payload.sid === "string" && payload.sid ? payload.sid : undefined;
    return {
      ok: true,
      claims: {
        userId: payload.sub,
        email: payload.email,
        epoch: ep,
        role,
        ...(sid ? { sid } : {}),
      },
      issuedAt: payload.iat,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof errors.JWTExpired ? "expired" : "invalid" };
  }
}

/** Null for anything that is not a valid, unexpired token signed with our secret. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now = new Date(),
): Promise<SessionClaims | null> {
  const r = await readSession(token, secret, now);
  return r.ok ? r.claims : null;
}
