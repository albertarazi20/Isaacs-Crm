import { z } from "zod";
import { db } from "@/lib/db";
import { recordLinkOpen } from "@/lib/system/linkSignals";

export const dynamic = "force-dynamic";

const body = z.object({ kind: z.enum(["upload", "apply"]), token: z.string().max(100) });

/**
 * The public pages' "a person is looking at this" beacon. Same site only; it always answers 204, so it says nothing
 * about whether a token is real.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return new Response(null, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (parsed.success) {
    try {
      await recordLinkOpen(db, parsed.data.kind, parsed.data.token);
    } catch (e) {
      console.error("link open not recorded:", e);
    }
  }
  return new Response(null, { status: 204 });
}
