import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runBucketSteps } from "@/lib/buckets/engine";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sweepAuditEvents } from "@/lib/system/audit";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { runOpenNudges } from "@/lib/system/openNudge";
import { sweepRateLimits } from "@/lib/system/ratelimit";
import { sweepSessions } from "@/lib/system/sessions";
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
 * inside each merchant's local window), then the audit log's retention sweep (lines older than 180 days go).
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
  // the audit log keeps 180 days; older lines go
  const auditSwept = await attempt("audit sweep", () => sweepAuditEvents(db));
  // Housekeeping: stale rate-limit windows and sign-in records past their lifetime. Logged, never a failed run:
  // a table that is a little too full for an hour is not an unhealthy nightly job.
  const swept = await Promise.all([sweepRateLimits(db), sweepSessions(new Date(), db)]).then(
    ([rateLimits, sessions]) => ({ rateLimits, sessions }),
    (err: unknown) => {
      console.error("cron nightly: sweeps failed:", err);
      return null;
    },
  );
  // a run with a failed job is not healthy: no heartbeat, and a 500 so the scheduler shows it
  if (errors.length > 0)
    return NextResponse.json(
      { statements, buckets, nudges, swept, auditSwept, failed: errors },
      { status: 500 },
    );
  await recordHeartbeat("nightly");
  return NextResponse.json({ statements, buckets, nudges, swept, auditSwept });
}

export const GET = handle;
export const POST = handle;
