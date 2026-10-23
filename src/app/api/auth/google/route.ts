import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthUrl, OAUTH_COOKIE, type OAuthPurpose } from "@/lib/auth/google";
import { cookieOptions, getSession } from "@/lib/auth/server";
import { env, googleConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const e = env();
  const base = e.APP_URL;
  if (!googleConfigured(e) || !e.GOOGLE_CLIENT_ID)
    return NextResponse.redirect(`${base}/login?error=google_not_configured`);
  const purpose: OAuthPurpose =
    req.nextUrl.searchParams.get("purpose") === "gmail" ? "gmail" : "login";
  const session = await getSession();
  if (purpose === "gmail" && !session) return NextResponse.redirect(`${base}/login`);

  const state = randomBytes(24).toString("base64url");
  const url = buildAuthUrl({
    clientId: e.GOOGLE_CLIENT_ID,
    redirectUri: `${base}/api/auth/callback`,
    state,
    purpose,
    loginHint: purpose === "gmail" ? session?.email : undefined,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, purpose }), cookieOptions(600));
  return res;
}
