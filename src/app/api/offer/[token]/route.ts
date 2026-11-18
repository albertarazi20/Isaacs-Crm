import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { acceptOffer, offerDocs } from "@/lib/system/offers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** Which of the offer's documents are on file: the page asks after each upload. */
export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  const docs = await offerDocs(token);
  if (!docs) return NextResponse.json({ error: "This link is not valid" }, { status: 404 });
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
    // Netlify's own header is the connection's address; x-forwarded-for can be written by the client
    const ip =
      req.headers.get("x-nf-client-connection-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "";
    const r = await acceptOffer(token, { ...parsed.data, ip });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: toActionError(e) }, { status: 409 });
  }
}
