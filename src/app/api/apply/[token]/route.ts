import { NextResponse } from "next/server";
import { toActionError } from "@/lib/data/errors";
import { db } from "@/lib/db";
import { signApplication } from "@/lib/docs/apply";
import { clientIp } from "@/lib/docs/clientIp";
import { documentStore } from "@/lib/docs/storage";
import { env } from "@/lib/env";
import { todayIn } from "@/lib/mca/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ token: string }> };

/** The merchant's signed application, as JSON from the form. The token is the key; there is no sign-in. */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
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
      ip: clientIp(req.headers),
      userAgent: req.headers.get("user-agent") ?? "",
      today: todayIn("America/New_York"),
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ error: toActionError(e) }, { status: 400 });
  }
}
