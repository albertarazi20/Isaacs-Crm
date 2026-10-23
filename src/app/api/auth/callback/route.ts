import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCode,
  GMAIL_SEND_SCOPE,
  isAllowedEmail,
  OAUTH_COOKIE,
  verifyIdToken,
} from "@/lib/auth/google";
import { getSession, sessionCookie } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { saveGmailConnection } from "@/lib/system/gmail";
import { upsertLoginUser } from "@/lib/system/users";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const e = env();
  const base = e.APP_URL;
  const fail = (code: string, to = "/login") => {
    const res = NextResponse.redirect(`${base}${to}?error=${code}`);
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  };
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return fail("google_not_configured");

  const params = req.nextUrl.searchParams;
  if (params.get("error"))
    return fail(params.get("error") === "access_denied" ? "access_denied" : "google_error");

  let saved: { state: string; purpose: "login" | "gmail" } | null = null;
  try {
    saved = JSON.parse(req.cookies.get(OAUTH_COOKIE)?.value ?? "null");
  } catch {
    saved = null;
  }
  const code = params.get("code");
  if (!saved || !code || params.get("state") !== saved.state) return fail("bad_state");

  try {
    const tokens = await exchangeCode({
      code,
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: `${base}/api/auth/callback`,
    });
    const who = await verifyIdToken(tokens.id_token, e.GOOGLE_CLIENT_ID);

    if (saved.purpose === "gmail") {
      const session = await getSession();
      if (!session) return fail("session_expired");
      if (!tokens.refresh_token || !tokens.scope.includes(GMAIL_SEND_SCOPE))
        return fail("gmail_not_granted", "/settings");
      await saveGmailConnection({
        userId: session.userId,
        googleEmail: who.email,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
      });
      const res = NextResponse.redirect(`${base}/settings?gmail=connected`);
      res.cookies.delete(OAUTH_COOKIE);
      return res;
    }

    if (!who.emailVerified || !isAllowedEmail(who.email, e.ALLOWED_EMAILS))
      return fail("not_allowed");
    const user = await upsertLoginUser(who.email, who.name);
    const res = NextResponse.redirect(`${base}/`);
    res.cookies.set(await sessionCookie({ userId: user.id, email: user.email }));
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  } catch (err) {
    console.error("google callback failed:", err instanceof Error ? err.message : err);
    return fail("google_error");
  }
}
