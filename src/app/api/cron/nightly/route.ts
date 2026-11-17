import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runBucketSteps } from "@/lib/buckets/engine";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { runOpenNudges } from "@/lib/system/openNudge";
import { runStatementClock } from "@/lib/system/statements";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Hourly: the statement clock asks for a month that has become due (and re-buckets), then the bucket steps queue
 * what is due, then the "opened but did not finish" nudges when they are switched on (the outbox worker sends
 * inside each merchant's local window).
 */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const statements = await runStatementClock(db);
  const buckets = await runBucketSteps({ db, appUrl: e.APP_URL });
  const nudges = await runOpenNudges({ db, appUrl: e.APP_URL });
  await recordHeartbeat("nightly");
  return NextResponse.json({ statements, buckets, nudges });
}

export const GET = handle;
export const POST = handle;
