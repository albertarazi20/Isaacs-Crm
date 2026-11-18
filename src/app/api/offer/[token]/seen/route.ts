import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { recordOfferView } from "@/lib/system/offers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** The merchant has their offer open. A signed-in rep looking at the page is not the merchant, so it counts nothing. */
export async function POST(_req: Request, { params }: Params) {
  const { token } = await params;
  const session = await getSession().catch(() => null);
  if (!session) await recordOfferView(token);
  return new NextResponse(null, { status: 204 });
}
