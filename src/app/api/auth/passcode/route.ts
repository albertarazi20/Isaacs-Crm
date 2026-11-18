import { NextResponse, type NextRequest } from "next/server";
import { passcodeMatches } from "@/lib/auth/passcode";
import { sessionCookie } from "@/lib/auth/server";
import { clientIp } from "@/lib/docs/clientIp";
import { env, firstAllowedEmail, passcodeConfigured } from "@/lib/env";
import { recordAudit } from "@/lib/system/audit";
import {
  bootstrapFirstManager,
  claimPasscodeAttempt,
  clearPasscodeAttempts,
  loginUser,
  passcodeKey,
} from "@/lib/system/users";

export const dynamic = "force-dynamic";

/** True when the request came from this app's own address. A malformed Origin ("null", junk) is not. */
function sameOrigin(origin: string | null, appUrl: string): boolean {
  try {
    return origin !== null && new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/** Plain words, in minutes (rounded up), for how long a locked-out person has to wait. */
function waitPhrase(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const tooMany = (seconds: number) => {
  const wait = waitPhrase(seconds);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many sign-in attempts</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>Too many sign-in attempts</h1><p>Sign-in is paused for this connection. Wait <strong>${wait}</strong>, then <a href="/login">go back to the sign-in page</a> and try again. Trying again sooner will not work and does not shorten the wait.</p></body></html>`;
  return new NextResponse(html, {
    status: 429,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": String(Math.max(1, seconds)),
      "cache-control": "no-store",
    },
  });
};

/**
 * Sign-in without Google. Off unless ACCESS_PASSCODE is set; acts as the first ALLOWED_EMAILS address.
 * Guessing is limited per client address and kept in the database (5 tries, then 15 minutes locked), counted before
 * the passcode is compared. With no readable address everyone shares one bucket with a much higher limit (30).
 */
export async function POST(req: NextRequest) {
  const e = env();
  if (!passcodeConfigured(e)) return new NextResponse("Not found", { status: 404 });
  // A form post from another site must not be able to attempt a sign-in.
  if (!sameOrigin(req.headers.get("origin"), e.APP_URL))
    return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return new NextResponse("Send the passcode as a form field", { status: 400 });

  const ip = clientIp(req.headers);
  const meta = { ip, userAgent: req.headers.get("user-agent") ?? "" };
  const key = passcodeKey(ip);
  const claim = await claimPasscodeAttempt(key);
  if (!claim.allowed) return tooMany(claim.retryAfterSeconds);

  const passcode = form.get("passcode");
  const email = firstAllowedEmail(e.ALLOWED_EMAILS);
  if (
    typeof passcode !== "string" ||
    !email ||
    !passcodeMatches(passcode, e.ACCESS_PASSCODE ?? "")
  ) {
    // A refused attempt (above) is not written down: a locked address could otherwise fill the log. This one was a real
    // guess, and it is the one that can trip the alert.
    await recordAudit({
      kind: "signin_failed",
      email: email ?? "",
      ...meta,
      detail: { method: "passcode", reason: "bad_passcode", locked: claim.retryAfterSeconds > 0 },
    });
    // That wrong guess was the one that tripped the lock: say so instead of inviting another.
    if (claim.retryAfterSeconds > 0) return tooMany(claim.retryAfterSeconds);
    return NextResponse.redirect(`${e.APP_URL}/login?error=bad_passcode`, 303);
  }
  await clearPasscodeAttempts(key);
  const name = email.split("@")[0] ?? "";
  const user = (await loginUser(email, name)) ?? (await bootstrapFirstManager(email, name));
  if (!user) {
    await recordAudit({
      kind: "signin_failed",
      email,
      ...meta,
      detail: { method: "passcode", reason: "not_allowed" },
    });
    return NextResponse.redirect(`${e.APP_URL}/login?error=not_allowed`, 303);
  }
  await recordAudit({
    kind: "signin_ok",
    userId: user.id,
    email: user.email,
    ...meta,
    detail: { method: "passcode" },
  });
  const res = NextResponse.redirect(`${e.APP_URL}/`, 303);
  res.cookies.set(
    await sessionCookie({
      userId: user.id,
      email: user.email,
      epoch: user.session_epoch,
      role: user.role,
    }),
  );
  return res;
}
