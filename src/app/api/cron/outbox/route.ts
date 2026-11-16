import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentStore } from "@/lib/docs/storage";
import { scanPending } from "@/lib/docs/upload";
import { env } from "@/lib/env";
import { productionDeliverer } from "@/lib/send/deliver";
import { drainOutbox } from "@/lib/send/worker";
import { recordHeartbeat } from "@/lib/system/heartbeat";

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
  const summary = await drainOutbox({
    db,
    deliver: productionDeliverer(),
    appUrl: e.APP_URL,
    max: 150,
  });
  // merchant uploads wait here until checked; nothing opens before that
  const scan = await scanPending(db, documentStore(e));
  await recordHeartbeat("outbox");
  return NextResponse.json({ ...summary, scan }, { status: summary.failed > 0 ? 502 : 200 });
}

export const GET = handle;
export const POST = handle;
