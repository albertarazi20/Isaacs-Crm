import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processInbox } from "@/lib/inbox/process";
import { autoChase } from "@/lib/inbox/submit";
import { productionMailTokenFor, syncInbox } from "@/lib/inbox/sync";
import { tagMerchantReplies } from "@/lib/messaging/replyTags";
import { recordExternalSends } from "@/lib/send/external";
import { sendEmailAsUser } from "@/lib/system/gmail";
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
  const tokenFor = productionMailTokenFor();
  const sync = await syncInbox({ db, tokenFor });
  // mail a rep sent outside the CRM counts toward the mailbox cap (S1-1): each connected mailbox's Sent mail since
  // its watermark lands in the ledger
  const external = await recordExternalSends({ db, tokenFor });
  const processed = e.ANTHROPIC_API_KEY
    ? await processInbox({ db })
    : { skipped: "ANTHROPIC_API_KEY not set" };
  // the merchant replies the sync stored get their tag (S1-6), on the same key and spend cap as the lender reader
  const replyTags = e.ANTHROPIC_API_KEY
    ? await tagMerchantReplies({ db })
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
  // quiet lenders get a nudge on the same thread, from the deal's rep
  const chase = await db.withSystem((q) =>
    autoChase(q, { sendFor: (userId) => (m) => sendEmailAsUser(userId, m) }),
  );
  await recordHeartbeat("inbox");
  return NextResponse.json(
    { sync, external, processed, replyTags, alerts, chase },
    { status: sync.failed.length > 0 || external.failed.length > 0 ? 207 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
