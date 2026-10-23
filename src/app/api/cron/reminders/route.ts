import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendViaResend } from "@/lib/email/resend";
import { env } from "@/lib/env";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { runCallReminders, runReminders } from "@/lib/system/reminders";

export const dynamic = "force-dynamic";

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Called hourly by an external scheduler. GET and POST both work (Vercel Cron sends GET). */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!e.RESEND_API_KEY || !e.RESEND_FROM) {
    return NextResponse.json(
      { error: "RESEND_API_KEY / RESEND_FROM not configured" },
      { status: 503 },
    );
  }
  const cfg = { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM };
  const now = new Date();
  const send = (to: string, d: { subject: string; text: string; html: string }) =>
    sendViaResend(cfg, { to, ...d });
  const digest = await runReminders({ db, now, appUrl: e.APP_URL, send });
  const calls = await runCallReminders({ db, now, appUrl: e.APP_URL, send });
  // Dead-man's switch: written after every run that completes, even when nothing needed sending.
  await recordHeartbeat(undefined, { now });
  return NextResponse.json({ ...digest, calls });
}

export const GET = handle;
export const POST = handle;
