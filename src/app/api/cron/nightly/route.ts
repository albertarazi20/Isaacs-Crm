import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runBucketSteps } from "@/lib/buckets/engine";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { recordHeartbeat } from "@/lib/system/heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Hourly: the bucket steps queue what is due (the outbox worker sends inside each merchant's local window). */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const buckets = await runBucketSteps({ db, appUrl: e.APP_URL });
  await recordHeartbeat("nightly");
  return NextResponse.json({ buckets });
}

export const GET = handle;
export const POST = handle;
