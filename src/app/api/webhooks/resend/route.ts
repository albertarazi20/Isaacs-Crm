import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { svixHeaders, verifySvix } from "@/lib/email/svix";
import { env } from "@/lib/env";
import { handleResendEvent, type ResendEvent } from "@/lib/system/replies";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Resend → us: delivered, bounced, complained, and inbound mail on the automation domain. Signed by Svix. */
export async function POST(req: Request) {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json({ error: "RESEND_WEBHOOK_SECRET is not set" }, { status: 503 });
  const body = await req.text();
  const h = svixHeaders(req.headers);
  if (!verifySvix(secret, h, body))
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  let evt: ResendEvent;
  try {
    evt = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "not JSON" }, { status: 400 });
  }
  if (!evt || typeof evt.type !== "string")
    return NextResponse.json({ error: "no type" }, { status: 400 });
  const { result } = await handleResendEvent(db, h.id as string, {
    ...evt,
    data: (evt.data ?? {}) as Record<string, unknown>,
  });
  return NextResponse.json({ result });
}
