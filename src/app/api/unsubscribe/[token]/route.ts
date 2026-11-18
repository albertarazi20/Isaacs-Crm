import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";
import { unsubscribeByToken } from "@/lib/system/replies";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** The List-Unsubscribe-Post target (mail clients POST here) and the page's own button. */
export async function POST(req: Request, { params }: Params) {
  const over = await limitByIp("unsubscribe", req.headers, LIMITS.unsubscribeIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter, "text");
  const { token } = await params;
  const oneClick =
    (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded") &&
    (await req.text().catch(() => "")).includes("List-Unsubscribe=One-Click");
  const ok = await unsubscribeByToken(db, token, oneClick ? "one_click" : "page");
  if (oneClick)
    return new Response(ok ? "Unsubscribed" : "Unknown link", { status: ok ? 200 : 404 });
  return NextResponse.redirect(
    `${env().APP_URL}/u/${encodeURIComponent(token)}?done=${ok ? "1" : "0"}`,
    303,
  );
}

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  return NextResponse.redirect(`${env().APP_URL}/u/${encodeURIComponent(token)}`, 303);
}
