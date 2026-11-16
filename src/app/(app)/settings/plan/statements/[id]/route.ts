import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { id } from "@/lib/data/schemas";
import { db } from "@/lib/db";
import { getShopSettings } from "@/lib/settings/queries";
import { getStatementDoc, statementHtml } from "@/lib/settings/statements";

export const dynamic = "force-dynamic";

/**
 * One commission statement as a plain page that prints: black on white, no app chrome. Runs as the signed-in person,
 * so row-level security decides: a rep opens their own, a manager anyone's, and anything else is a 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const parsed = z.object({ id }).safeParse(await ctx.params);
  if (!parsed.success) return new Response("Not found", { status: 404 });
  const found = await db.withUser(session.userId, async (q) => ({
    doc: await getStatementDoc(q, parsed.data.id),
    shop: (await getShopSettings(q)).shop_name,
  }));
  if (!found.doc) return new Response("Not found", { status: 404 });
  return new Response(statementHtml(found.doc, found.shop), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
