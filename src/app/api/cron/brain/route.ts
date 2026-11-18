import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { anthropicCaller } from "@/lib/assistant/run";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { recordHeartbeat } from "@/lib/system/heartbeat";
import { runBrain } from "@/lib/system/brain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Every few minutes: prepare the next step for what is new on each rep's list (the brain, when a manager has it on). */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runBrain({
    db,
    keySet: Boolean(e.ANTHROPIC_API_KEY),
    caller: anthropicCaller(),
  });
  await recordHeartbeat("brain");
  return NextResponse.json(result, { status: result.failed > 0 ? 207 : 200 });
}

export const GET = handle;
export const POST = handle;
