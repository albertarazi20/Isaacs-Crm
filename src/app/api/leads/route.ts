import { OwnedElsewhereError } from "@/lib/leads/owner";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isAllowedEmail } from "@/lib/auth/google";
import { userContext } from "@/lib/data/queries";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { db } from "@/lib/db";
import { devLoginEnabled, env } from "@/lib/env";
import { ingestLead, LeadCapError } from "@/lib/leads/intake";
import { describeLeadProblem, leadSchema } from "@/lib/leads/schema";
import { parseBearer, readLimitedJson } from "@/lib/leads/token";
import { sendViaResend } from "@/lib/email/resend";
import { checkLeadToken } from "@/lib/system/leads";
import { sendNewLeadAlert } from "@/lib/system/leadAlert";

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
  if (!parsed.success) return json({ error: describeLeadProblem(parsed.error) }, 400);

  try {
    const result = await db.withUser(check.userId, async (q) =>
      ingestLead(q, parsed.data, await userContext(q), check.tokenId),
    );
    // The lead is saved. A failed alert must never turn that into an error for the sender.
    const e = env();
    if (result.status === "created" && e.RESEND_API_KEY && e.RESEND_FROM) {
      const cfg = { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM };
      await sendNewLeadAlert({
        db,
        userId: check.userId,
        clientId: result.clientId,
        now: new Date(),
        appUrl: e.APP_URL,
        send: (to, d) => sendViaResend(cfg, { to, ...d }),
      }).catch((err: unknown) =>
        console.error("new-lead alert failed:", err instanceof Error ? err.message : err),
      );
    }
    return json({ ok: true, ...result }, result.status === "created" ? 201 : 200);
  } catch (e) {
    // The sender's mistake is a 400. A busy database is "try again" (503): a retry will work. Anything else is ours.
    if (e instanceof LeadCapError)
      return json(
        {
          error: `${e.message}. If you didn't send these, turn the connection off in Lead intake.`,
        },
        429,
        { "retry-after": "3600" },
      );
    // another rep already works this merchant: say so without naming anyone to the outside sender
    if (e instanceof OwnedElsewhereError)
      return json({ error: "This merchant is already in the CRM with another rep." }, 409);
    if (e instanceof UserError || e instanceof ZodError)
      return json({ error: toActionError(e) }, 400);
    const code = (e as { code?: string } | null)?.code;
    if (code === "40P01" || code === "40001" || code === "55P03")
      return json({ error: "Busy right now — please send it again" }, 503, { "retry-after": "2" });
    console.error("lead intake failed:", e);
    return json(
      { error: "Something went wrong on our side — your lead was not saved. Send it again." },
      500,
    );
  }
}
