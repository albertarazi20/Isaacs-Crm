import { jwtVerify, SignJWT } from "jose";
import { isRole, type Role } from "./roles";

export const SESSION_COOKIE = "isaac_session";
export const SESSION_DAYS = 14;

export interface SessionClaims {
  userId: string;
  email: string;
  /** Which "log out everywhere" generation this token belongs to. Tokens issued before it existed count as 0. */
  epoch?: number;
  /** The role at sign-in. Pages read it for layout; the database enforces it on every query regardless. */
  role: Role;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(
  claims: SessionClaims,
  secret: string,
  now = new Date(),
): Promise<string> {
  return new SignJWT({ email: claims.email, ep: claims.epoch ?? 0, role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + SESSION_DAYS * 86_400)
    .sign(key(secret));
}

/** Null for anything that is not a valid, unexpired token signed with our secret. */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    const ep = typeof payload.ep === "number" && Number.isInteger(payload.ep) ? payload.ep : 0;
    // A token minted before roles existed belonged to the single owner; treat it as a rep and let sign-in refresh it.
    const role = isRole(payload.role) ? payload.role : "rep";
    return { userId: payload.sub, email: payload.email, epoch: ep, role };
  } catch {
    return null;
  }
}
