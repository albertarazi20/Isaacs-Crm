import { createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const LOGIN_SCOPES = ["openid", "email", "profile"];
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const OAUTH_COOKIE = "isaac_oauth";

export type OAuthPurpose = "login" | "gmail";

export interface OAuthState {
  state: string;
  purpose: OAuthPurpose;
}

/** The state cookie is signed, so only this server can mint one — a forged cookie can't trigger a token exchange. */
export function signOAuthState(p: OAuthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyOAuthState(cookie: string | undefined, secret: string): OAuthState | null {
  const [body, sig] = (cookie ?? "").split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthState>;
    if (typeof p.state !== "string" || (p.purpose !== "login" && p.purpose !== "gmail"))
      return null;
    return { state: p.state, purpose: p.purpose };
  } catch {
    return null;
  }
}

export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  purpose: OAuthPurpose;
  loginHint?: string;
}): string {
  const scopes = args.purpose === "gmail" ? [...LOGIN_SCOPES, GMAIL_SEND_SCOPE] : LOGIN_SCOPES;
  const q = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state: args.state,
    include_granted_scopes: "true",
  });
  if (args.purpose === "gmail") {
    // offline + consent is the only way Google reliably returns a refresh token
    q.set("access_type", "offline");
    q.set("prompt", "consent");
  } else {
    q.set("prompt", "select_account");
  }
  if (args.loginHint) q.set("login_hint", args.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** ALLOWED_EMAILS is a comma list. Empty list allows nobody — fail closed. */
export function isAllowedEmail(email: string, list: string): boolean {
  const allowed = list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  scope: string;
}

type Fetch = typeof fetch;

export async function exchangeCode(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: Fetch = fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  return (await res.json()) as TokenResponse;
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name: string;
}

const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifyIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  if (typeof payload.email !== "string") throw new Error("Google ID token has no email");
  return {
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : "",
  };
}
