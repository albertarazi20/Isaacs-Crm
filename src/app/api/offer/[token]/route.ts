import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { exactClientIp } from "@/lib/docs/clientIp";
import { toActionError } from "@/lib/data/errors";
import { acceptOffer, offerDocs, offerState } from "@/lib/system/offers";
import { LIMITS, limitByIp, tooManyRequests } from "@/lib/system/ratelimit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** Which of the offer's documents are on file: the page asks after each upload. */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  const docs = await offerDocs(token);
  if (!docs) {
    const bad = await limitByIp("offer-invalid", req.headers, LIMITS.invalidLinkIp);
    if (!bad.allowed) return tooManyRequests(bad.retryAfter);
    return NextResponse.json({ error: "This link is not valid" }, { status: 404 });
  }
  const over = await limitByIp("offer", req.headers, LIMITS.offerIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter);
  return NextResponse.json({ docs }, { headers: { "cache-control": "no-store" } });
}

const body = z.object({
  name: z.string().trim().max(160).default(""),
  email: z
    .string()
    .trim()
    .max(254)
    .refine(
      (s) => s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
      "That email doesn't look right",
    )
    .default(""),
});

/** The merchant accepts the offer. */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  if ((await offerState(token).catch(() => null)) === null) {
    const bad = await limitByIp("offer-invalid", req.headers, LIMITS.invalidLinkIp);
    if (!bad.allowed) return tooManyRequests(bad.retryAfter);
    return NextResponse.json({ error: "This link is not valid", state: null }, { status: 409 });
  }
  const over = await limitByIp("offer", req.headers, LIMITS.offerIp);
  if (!over.allowed) return tooManyRequests(over.retryAfter);
  // a rep previewing the page is not the merchant
  if (await getSession().catch(() => null))
    return NextResponse.json(
      { error: "You're signed in to the CRM: accepting is for the merchant" },
      { status: 403 },
    );
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "That doesn't look right" },
      { status: 400 },
    );
  try {
    const ip = exactClientIp(req.headers);
    const r = await acceptOffer(token, { ...parsed.data, ip });
    // the rep hears at once (an alert); their copy with the documents goes from the outbox job, after the scan
    return NextResponse.json({ acceptedAt: r.acceptedAt });
  } catch (e) {
    // the page hides its form when the offer was withdrawn or ran out while it was open
    const state = await offerState(token).catch(() => null);
    return NextResponse.json({ error: toActionError(e), state }, { status: 409 });
  }
}
