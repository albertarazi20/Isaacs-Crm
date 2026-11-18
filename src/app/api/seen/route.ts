import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { recordLinkOpen } from "@/lib/system/linkSignals";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";

export const dynamic = "force-dynamic";

const body = z.object({ kind: z.enum(["upload", "apply"]), token: z.string().max(100) });

/** A malformed Origin ("null", junk) is not our site; it must be a 403, not a crash. */
function sameHost(origin: string, host: string | null): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The public pages' "a person is looking at this" beacon. Same site only; it always answers 204, so it says nothing
 * about whether a token is real. A signed-in member of staff checking a merchant's link is not the merchant: their
 * look records nothing (no hot signal, no timeline line, no nudge email).
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !sameHost(origin, req.headers.get("host")))
    return new Response(null, { status: 403 });
  // Shares its bucket with the offer page's own beacon: both are the same "a person is looking" signal.
  const over = await limitByIp("seen", req.headers, LIMITS.seenIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter, "text");
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (parsed.success) {
    try {
      if (await getSession()) return new Response(null, { status: 204 });
      await recordLinkOpen(db, parsed.data.kind, parsed.data.token);
    } catch (e) {
      console.error("link open not recorded:", e);
    }
  }
  return new Response(null, { status: 204 });
}
