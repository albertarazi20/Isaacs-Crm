import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runApprovalEmails } from "@/lib/system/approvals";
import { db } from "@/lib/db";
import { documentStore } from "@/lib/docs/storage";
import { scanPending } from "@/lib/docs/upload";
import { env } from "@/lib/env";
import { productionDeliverer } from "@/lib/send/deliver";
import { drainOutbox } from "@/lib/send/worker";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { productionNoticeSenders, retryOfferNotices } from "@/lib/system/offerNotice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Every few minutes: send whatever is due on the outbox. Safe to overlap (rows are claimed skip-locked). */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // the approval emails that are due go on the outbox first, so this same run sends them. Whatever happens there, the
  // send below still runs: intake, replies and sequences never wait on the approvals.
  const approvals = await runApprovalEmails({ db, appUrl: e.APP_URL }).catch((err: unknown) => {
    console.error("approval emails:", err);
    return { checked: 0, queued: 0, stopped: 0, finished: 0, errors: 1, deferred: 0 };
  });
  const summary = await drainOutbox({
    db,
    deliver: productionDeliverer(),
    appUrl: e.APP_URL,
    max: 150,
  });
  // merchant uploads wait here until checked; nothing opens before that
  // a failed scan (storage down) must not skip the offer notices and the heartbeat below
  const scan = await scanPending(db, documentStore(e)).catch((err: unknown) => {
    console.error("document scan:", err);
    return { scanned: 0, clean: 0, rejected: 0, errors: 1 };
  });
  // a rep's copy of an accepted offer that did not go when it was accepted
  const offerNotices = await retryOfferNotices({
    store: documentStore(e),
    senders: productionNoticeSenders(),
    appUrl: e.APP_URL,
  }).catch((err: unknown) => {
    console.error("offer notices:", err);
    return { tried: 0, sent: 0 };
  });
  await recordHeartbeat("outbox");
  return NextResponse.json(
    { ...summary, scan, approvals, offerNotices },
    { status: summary.failed > 0 || approvals.errors > 0 ? 502 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
