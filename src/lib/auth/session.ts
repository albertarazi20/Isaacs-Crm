import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "isaac_session";
export const SESSION_DAYS = 14;

export interface SessionClaims {
  userId: string;
  email: string;
  /** Which "log out everywhere" generation this token belongs to. Tokens issued before it existed count as 0. */
  epoch?: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(
  claims: SessionClaims,
  secret: string,
  now = new Date(),
): Promise<string> {
  return new SignJWT({ email: claims.email, ep: claims.epoch ?? 0 })
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
    return { userId: payload.sub, email: payload.email, epoch: ep };
  } catch {
    return null;
  }
}
