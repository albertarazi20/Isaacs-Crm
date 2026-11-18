import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthUrl, OAUTH_COOKIE, signOAuthState, type OAuthPurpose } from "@/lib/auth/google";
import { cookieOptions, getSession } from "@/lib/auth/server";
import { env, googleConfigured } from "@/lib/env";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const over = await limitByIp("auth-google", req.headers, LIMITS.authIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter, "text");
  const e = env();
  const base = e.APP_URL;
  if (!googleConfigured(e) || !e.GOOGLE_CLIENT_ID)
    return NextResponse.redirect(`${base}/login?error=google_not_configured`);
  const wanted = req.nextUrl.searchParams.get("purpose");
  const purpose: OAuthPurpose =
    wanted === "gmail" || wanted === "sheets" || wanted === "mail" ? wanted : "login";
  const session = await getSession();
  if (purpose !== "login" && !session) return NextResponse.redirect(`${base}/login`);

  const state = randomBytes(24).toString("base64url");
  const url = buildAuthUrl({
    clientId: e.GOOGLE_CLIENT_ID,
    redirectUri: `${base}/api/auth/callback`,
    state,
    purpose,
    loginHint: purpose !== "login" ? session?.email : undefined,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(
    OAUTH_COOKIE,
    signOAuthState({ state, purpose }, e.SESSION_SECRET),
    cookieOptions(600),
  );
  return res;
}
