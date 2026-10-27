import { NextResponse, type NextRequest } from "next/server";
import { passcodeMatches } from "@/lib/auth/passcode";
import { sessionCookie } from "@/lib/auth/server";
import { env, firstAllowedEmail, passcodeConfigured } from "@/lib/env";
import { upsertLoginUser } from "@/lib/system/users";

export const dynamic = "force-dynamic";

/** Sign-in without Google. Off unless ACCESS_PASSCODE is set; acts as the first ALLOWED_EMAILS address. */
export async function POST(req: NextRequest) {
  const e = env();
  if (!passcodeConfigured(e)) return new NextResponse("Not found", { status: 404 });
  // A form post from another site must not be able to attempt a sign-in.
  if (req.headers.get("origin") !== new URL(e.APP_URL).origin)
    return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const passcode = form.get("passcode");
  const email = firstAllowedEmail(e.ALLOWED_EMAILS);
  if (
    typeof passcode !== "string" ||
    !email ||
    !passcodeMatches(passcode, e.ACCESS_PASSCODE ?? "")
  ) {
    // Slows guessing; the passcode's length is the real defence (no shared rate-limit store here).
    await new Promise((r) => setTimeout(r, 1000));
    return NextResponse.redirect(`${e.APP_URL}/login?error=bad_passcode`, 303);
  }
  const user = await upsertLoginUser(email, email.split("@")[0] ?? "");
  const res = NextResponse.redirect(`${e.APP_URL}/`, 303);
  res.cookies.set(
    await sessionCookie({ userId: user.id, email: user.email, epoch: user.session_epoch }),
  );
  return res;
}
