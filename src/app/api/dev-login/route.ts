import { NextResponse, type NextRequest } from "next/server";
import { sessionCookie } from "@/lib/auth/server";
import { devLoginEnabled, env } from "@/lib/env";
import { isRole } from "@/lib/auth/roles";
import { upsertDevUser } from "@/lib/system/users";

export const dynamic = "force-dynamic";

/** Local development only: skips Google. devLoginEnabled() is false whenever NODE_ENV is production. */
export async function GET(req: NextRequest) {
  if (!devLoginEnabled()) return new NextResponse("Not found", { status: 404 });
  const email = (req.nextUrl.searchParams.get("email") ?? "demo@example.com").toLowerCase();
  const wanted = req.nextUrl.searchParams.get("role");
  const user = await upsertDevUser(
    email,
    email.split("@")[0] ?? "",
    // no ?role= keeps a seeded user's role (browser tests seed reps); a brand-new dev user starts as a manager
    isRole(wanted) ? wanted : null,
  );
  const res = NextResponse.redirect(`${env().APP_URL}/`);
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
