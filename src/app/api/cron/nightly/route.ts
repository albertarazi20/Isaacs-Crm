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
  // each job on its own: one that fails (a lock timeout in the statement clock) must not skip the hour's sequences
  const errors: string[] = [];
  const attempt = async <T>(name: string, job: () => Promise<T>): Promise<T | null> => {
    try {
      return await job();
    } catch (err) {
      console.error(`cron nightly: ${name} failed:`, err);
      errors.push(name);
      return null;
    }
  };
  const statements = await attempt("statements", () => runStatementClock(db));
  const buckets = await attempt("buckets", () => runBucketSteps({ db, appUrl: e.APP_URL }));
  const nudges = await attempt("nudges", () => runOpenNudges({ db, appUrl: e.APP_URL }));
  // a run with a failed job is not healthy: no heartbeat, and a 500 so the scheduler shows it
  if (errors.length > 0)
    return NextResponse.json({ statements, buckets, nudges, failed: errors }, { status: 500 });
  await recordHeartbeat("nightly");
  return NextResponse.json({ statements, buckets, nudges });
}

export const GET = handle;
export const POST = handle;
