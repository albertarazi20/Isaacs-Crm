import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { fileNewSheetRows } from "@/lib/sheets/file";
import { productionTokenFor, syncSheets } from "@/lib/sheets/sync";
import { recordHeartbeat } from "@/lib/system/heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Every few minutes: pull the connected lead sheets, then file whatever is new into its bucket. */
async function handle(req: Request): Promise<NextResponse> {
  const e = env();
  if (!authorised(req, e.CRON_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sync = await syncSheets({ db, tokenFor: productionTokenFor(db) });
  const filed = await fileNewSheetRows({ db, appUrl: e.APP_URL });
  await recordHeartbeat("sheets");
  return NextResponse.json({ sync, filed }, { status: sync.failed.length > 0 ? 207 : 200 });
}

export const GET = handle;
export const POST = handle;
