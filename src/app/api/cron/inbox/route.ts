import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processInbox } from "@/lib/inbox/process";
import { productionMailTokenFor, syncInbox } from "@/lib/inbox/sync";
import { recordHeartbeat } from "@/lib/system/heartbeat";

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
  await recordHeartbeat("inbox");
  return NextResponse.json({ sync, processed }, { status: sync.failed.length > 0 ? 207 : 200 });
}

export const GET = handle;
export const POST = handle;
