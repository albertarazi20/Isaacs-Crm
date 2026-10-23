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
  // A run in which any email failed to send (a wrong RESEND_FROM, a dead key) is not a healthy run: leave the
  // heartbeat alone so the banner fires, and answer 502 so the external scheduler alerts too. The failed sends
  // rolled their claims back, so the next hourly run retries them.
  if (digest.failed > 0 || calls.failed > 0) {
    return NextResponse.json(
      { ...digest, calls, error: "some reminder emails failed to send" },
      { status: 502 },
    );
  }
  // Dead-man's switch: written after every run that sent cleanly, even when nothing needed sending.
  await recordHeartbeat(undefined, { now });
  return NextResponse.json({ ...digest, calls });
}

export const GET = handle;
export const POST = handle;
