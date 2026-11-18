import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCode,
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE,
  isAllowedEmail,
  OAUTH_COOKIE,
  SHEETS_READ_SCOPE,
  verifyIdToken,
  verifyOAuthState,
} from "@/lib/auth/google";
import { getSession, sessionCookie } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { recordAudit, requestMeta } from "@/lib/system/audit";
import { saveGmailConnection } from "@/lib/system/gmail";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";
import { bootstrapFirstManager, loginUser } from "@/lib/system/users";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Public and cheap to call, and every failed call writes an audit line: counted per address before anything else
  // happens, so it cannot be used to flood the log. A person signing in makes one call.
  const over = await limitByIp("auth-callback", req.headers, LIMITS.authIp);
  if (!over.allowed) {
    // a NextResponse like every other answer here (callers read its cookies)
    const refused = tooManyRequests(over.retryAfter, "text");
    return new NextResponse(refused.body, refused);
  }
  const e = env();
  const base = e.APP_URL;
  const meta = await requestMeta(req.headers);
  // a sign-in attempt, until the saved state says this round trip was only to connect Gmail or Sheets
  let signingIn = true;
  const fail = async (code: string, to = "/login", email = "") => {
    if (signingIn && code !== "google_not_configured")
      await recordAudit({
        kind: "signin_failed",
        email,
        ...meta,
        detail: { method: "google", reason: code },
      });
    const res = NextResponse.redirect(`${base}${to}?error=${code}`);
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  };
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return fail("google_not_configured");

  const params = req.nextUrl.searchParams;
  if (params.get("error"))
    return fail(params.get("error") === "access_denied" ? "access_denied" : "google_error");

  const saved = verifyOAuthState(req.cookies.get(OAUTH_COOKIE)?.value, e.SESSION_SECRET);
  const code = params.get("code");
  if (!saved || !code || params.get("state") !== saved.state) return fail("bad_state");
  signingIn = saved.purpose === "login";

  try {
    const tokens = await exchangeCode({
      code,
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      redirectUri: `${base}/api/auth/callback`,
    });
    const who = await verifyIdToken(tokens.id_token, e.GOOGLE_CLIENT_ID);

    if (saved.purpose !== "login") {
      const session = await getSession();
      if (!session) return fail("session_expired");
      if (!tokens.refresh_token || !tokens.scope.includes(GMAIL_SEND_SCOPE))
        return fail("gmail_not_granted", "/settings");
      await saveGmailConnection({
        userId: session.userId,
        googleEmail: who.email,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
        canReadSheets: tokens.scope.includes(SHEETS_READ_SCOPE),
        canReadMail: tokens.scope.includes(GMAIL_READ_SCOPE),
      });
      await recordAudit({
        kind: "gmail_connected",
        userId: session.userId,
        email: session.email,
        ...meta,
        detail: { google_email: who.email, purpose: saved.purpose },
      });
      const res = NextResponse.redirect(`${base}/settings?gmail=connected`);
      res.cookies.delete(OAUTH_COOKIE);
      return res;
    }

    if (!who.emailVerified) return fail("not_allowed", "/login", who.email);
    // Accounts are created by a manager in Settings → Team. The only exception is a fresh install: the first
    // person to sign in (restricted to ALLOWED_EMAILS when that is set) becomes the first manager.
    const user =
      (await loginUser(who.email, who.name)) ??
      (!e.ALLOWED_EMAILS || isAllowedEmail(who.email, e.ALLOWED_EMAILS)
        ? await bootstrapFirstManager(who.email, who.name)
        : null);
    if (!user) return fail("not_allowed", "/login", who.email);
    await recordAudit({
      kind: "signin_ok",
      userId: user.id,
      email: user.email,
      ...meta,
      detail: { method: "google" },
    });
    const res = NextResponse.redirect(`${base}/`);
    res.cookies.set(
      await sessionCookie({
        userId: user.id,
        email: user.email,
        epoch: user.session_epoch,
        role: user.role,
      }),
    );
    res.cookies.delete(OAUTH_COOKIE);
    return res;
  } catch (err) {
    console.error("google callback failed:", err instanceof Error ? err.message : err);
    return fail("google_error");
  }
}
