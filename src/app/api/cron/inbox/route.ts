import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processInbox } from "@/lib/inbox/process";
import { productionMailTokenFor, syncInbox } from "@/lib/inbox/sync";
import { sendViaResend } from "@/lib/email/resend";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { sendReplyAlerts } from "@/lib/system/replies";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Every few minutes: pull new lender mail, match it, read it, apply or propose. */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sync = await syncInbox({ db, tokenFor: productionMailTokenFor(db) });
  const processed = e.ANTHROPIC_API_KEY
    ? await processInbox({ db })
    : { skipped: "ANTHROPIC_API_KEY not set" };
  const alerts =
    sync.merchantReplies.length > 0 && e.RESEND_API_KEY && e.RESEND_FROM
      ? await sendReplyAlerts(db, sync.merchantReplies, {
          now: new Date(),
          appUrl: e.APP_URL,
          send: (to, d) =>
            sendViaResend(
              { apiKey: e.RESEND_API_KEY as string, from: e.RESEND_FROM as string },
              { to, ...d },
            ),
        })
      : { sent: 0, skipped: sync.merchantReplies.length, failed: 0 };
  await recordHeartbeat("inbox");
  return NextResponse.json(
    { sync, processed, alerts },
    { status: sync.failed.length > 0 ? 207 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
