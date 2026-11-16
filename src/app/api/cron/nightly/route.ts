import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runBucketSteps } from "@/lib/buckets/engine";
import { db } from "@/lib/db";
import { runDealClocks } from "@/lib/deals/clocks";
import { purgeDeadDocuments } from "@/lib/docs/retention";
import { documentStore } from "@/lib/docs/storage";
import { env } from "@/lib/env";
import { runRenewals } from "@/lib/money/renewals";
import { claudeOpenerDrafter, runRescueNudges, runWinback } from "@/lib/money/winback";
import { recordHeartbeat } from "@/lib/system/heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Hourly: bucket steps and win-back steps queue what is due (the outbox worker sends inside each merchant's window);
 * the money clocks roll (clawback windows clear, renewal warm-ups and eligibility become tasks); the deal clocks roll
 * (approvals past their date expire, the month's new statement joins each open deal's checklist); the renewal and
 * rescue emails go; dead deals' paperwork past the retention period is purged.
 */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const buckets = await runBucketSteps({ db, appUrl: e.APP_URL });
  // Claude drafts the step-1 opener per merchant when the key is set (auto or review mode, a shop setting)
  const winback = await runWinback({
    db,
    appUrl: e.APP_URL,
    drafter: e.ANTHROPIC_API_KEY ? claudeOpenerDrafter : undefined,
  });
  const clocks = await db.withSystem(
    async (q) => (await q.query("select * from roll_funding_clocks()")).rows[0],
  );
  const deals = await db.withSystem((q) => runDealClocks(q));
  const renewals = await runRenewals({ db, appUrl: e.APP_URL });
  const rescue = await runRescueNudges({ db, appUrl: e.APP_URL });
  const retention = await purgeDeadDocuments({ db, store: documentStore(e) });
  await recordHeartbeat("nightly");
  return NextResponse.json({ buckets, winback, clocks, deals, renewals, rescue, retention });
}

export const GET = handle;
export const POST = handle;
