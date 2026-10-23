import { NextResponse } from "next/server";
import { isAllowedEmail } from "@/lib/auth/google";
import { userContext } from "@/lib/data/queries";
import { toActionError } from "@/lib/data/errors";
import { db } from "@/lib/db";
import { devLoginEnabled, env } from "@/lib/env";
import { ingestLead } from "@/lib/leads/intake";
import { leadSchema } from "@/lib/leads/schema";
import { parseBearer, readLimitedJson } from "@/lib/leads/token";
import { checkLeadToken } from "@/lib/system/leads";

export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status: number, extra: HeadersInit = {}) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...extra } });

/**
 * Add a merchant to the account that owns the bearer token. Server-to-server only: the token must never
 * sit in a web page. Answers are deliberately plain and never reveal anything about other merchants.
 */
export async function POST(req: Request) {
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return json({ error: "Send your lead token as 'Authorization: Bearer …'" }, 401);

  const check = await checkLeadToken(token);
  if (!check.ok) {
    return check.reason === "rate_limited"
      ? json({ error: "Too many leads this minute — slow down" }, 429, { "retry-after": "60" })
      : json({ error: "That lead token isn't valid" }, 401);
  }
  // Taking someone off ALLOWED_EMAILS must switch their token off too, like their session.
  if (!devLoginEnabled() && !isAllowedEmail(check.email, env().ALLOWED_EMAILS))
    return json({ error: "That lead token isn't valid" }, 401);

  const body = await readLimitedJson(req);
  if (!body.ok) return json({ error: body.error }, body.status);
  const parsed = leadSchema.safeParse(body.value);
  if (!parsed.success)
    return json({ error: parsed.error.issues[0]?.message ?? "That lead isn't valid" }, 400);

  try {
    const result = await db.withUser(check.userId, async (q) =>
      ingestLead(q, parsed.data, await userContext(q)),
    );
    return json({ ok: true, ...result }, result.status === "created" ? 201 : 200);
  } catch (e) {
    return json({ error: toActionError(e) }, 400);
  }
}
