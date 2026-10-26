import { NextResponse, type NextRequest } from "next/server";
import { sessionCookie } from "@/lib/auth/server";
import { devLoginEnabled, env } from "@/lib/env";
import { upsertLoginUser } from "@/lib/system/users";

export const dynamic = "force-dynamic";

/** Local development only: skips Google. devLoginEnabled() is false whenever NODE_ENV is production. */
export async function GET(req: NextRequest) {
  if (!devLoginEnabled()) return new NextResponse("Not found", { status: 404 });
  const email = (req.nextUrl.searchParams.get("email") ?? "isaac@example.com").toLowerCase();
  const user = await upsertLoginUser(email, email.split("@")[0] ?? "");
  const res = NextResponse.redirect(`${env().APP_URL}/`);
  res.cookies.set(
    await sessionCookie({ userId: user.id, email: user.email, epoch: user.session_epoch }),
  );
  return res;
}
