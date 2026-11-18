import { NextResponse } from "next/server";
import { toActionError } from "@/lib/data/errors";
import { db } from "@/lib/db";
import { openApplicationPage, signApplication } from "@/lib/docs/apply";
import { exactClientIp } from "@/lib/docs/clientIp";
import { documentStore } from "@/lib/docs/storage";
import { env } from "@/lib/env";
import { todayIn } from "@/lib/mca/dates";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ token: string }> };

/** The merchant's signed application, as JSON from the form. The token is the key; there is no sign-in. */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  // A link that does not exist counts in the small invalid-link bucket; only a real one uses the address's roomy bucket.
  if (!(await openApplicationPage(db, token))) {
    const bad = await limitByIp("apply-invalid", req.headers, LIMITS.invalidLinkIp);
    if (!bad.allowed) return tooManyRequests(bad.retryAfter);
    return NextResponse.json({ error: "This link isn't valid any more" }, { status: 400 });
  }
  const over = await limitByIp("apply", req.headers, LIMITS.applyIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter);
  let fields: unknown;
  try {
    fields = await req.json();
  } catch {
    return NextResponse.json({ error: "Send the form as JSON" }, { status: 400 });
  }
  if (!fields || typeof fields !== "object")
    return NextResponse.json({ error: "Send the form as JSON" }, { status: 400 });
  try {
    const out = await signApplication(db, documentStore(env()), {
      token,
      fields: fields as Parameters<typeof signApplication>[2]["fields"],
      ip: exactClientIp(req.headers),
      userAgent: req.headers.get("user-agent") ?? "",
      today: todayIn("America/New_York"),
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: toActionError(e) }, { status: 400 });
  }
}
