import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendViaResend } from "@/lib/email/resend";
import { isAllowedEmail } from "@/lib/auth/google";
import { devLoginEnabled, env } from "@/lib/env";
import { runMonthEndClose } from "@/lib/money/close";
import { runUserAlerts } from "@/lib/system/alerts";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { runCallReminders, runReminders } from "@/lib/system/reminders";
import { runWeeklyScorecards } from "@/lib/system/weekly";

export const dynamic = "force-dynamic";
// Explicit, so the limit does not depend on the plan or the Fluid default: this job can send several emails.
export const maxDuration = 60;

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
  // The allowlist is the owner's off-switch for a person: off the list means no sign-in AND no more email.
  const allowed = (email: string) => devLoginEnabled() || isAllowedEmail(email, e.ALLOWED_EMAILS);
  const digest = await runReminders({ db, now, appUrl: e.APP_URL, send, allowed });
  const calls = await runCallReminders({ db, now, appUrl: e.APP_URL, send, allowed });
  const weekly = await runWeeklyScorecards({ db, now, appUrl: e.APP_URL, send, allowed });
  // the alert feed, generated then bundled into one email per person at most once an hour
  const alerts = await runUserAlerts({ db, now, appUrl: e.APP_URL, send, allowed });
  // the previous month closes on the first run at or after 12:00 UTC on the 1st; every later run finds it done
  const close = await runMonthEndClose({ db, now, send, allowed });
  // A run in which any email failed to send (a wrong RESEND_FROM, a dead key) is not a healthy run: leave the
  // heartbeat alone so the banner fires, and answer 502 so the external scheduler alerts too. The failed sends
  // rolled their claims back, so the next hourly run retries them.
  if (
    digest.failed > 0 ||
    calls.failed > 0 ||
    weekly.failed > 0 ||
    alerts.failed > 0 ||
    close.failed > 0
  ) {
    return NextResponse.json(
      { ...digest, calls, weekly, alerts, close, error: "some reminder emails failed to send" },
      { status: 502 },
    );
  }
  // Dead-man's switch: written after every run that sent cleanly, even when nothing needed sending.
  await recordHeartbeat(undefined, { now });
  return NextResponse.json({ ...digest, calls, weekly, alerts, close });
}

export const GET = handle;
export const POST = handle;
