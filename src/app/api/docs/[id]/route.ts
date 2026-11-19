import { getSession } from "@/lib/auth/server";
import { UserError } from "@/lib/data/mutations";
import { isUuid } from "@/lib/data/schemas";
import { db } from "@/lib/db";
import { clientIp } from "@/lib/docs/clientIp";
import { asBody, documentStore } from "@/lib/docs/storage";
import { openDocument } from "@/lib/docs/upload";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * A signed-in user opens a document. Row-level security decides whether they may: the merchant's rep and the managers
 * get the file exactly as it was filed. Every open is written to document_views (who, when, from where): the audit
 * trail for the most sensitive files in the system, the offboarding report's "documents opened" count, and what clears
 * the "uploaded, not opened yet" line on Follow Up.
 */
export async function GET(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const download = url.searchParams.get("dl") === "1";
  try {
    const doc = await db.withUser(session.userId, async (q) => {
      const d = await openDocument(q, id);
      await q.query(
        `insert into document_views (document_id, action, viewer_user_id, ip, user_agent)
         values ($1, $2, $3, $4, $5)`,
        [
          d.id,
          download ? "download" : "view",
          session.userId,
          clientIp(req.headers),
          (req.headers.get("user-agent") ?? "").slice(0, 300),
        ],
      );
      return d;
    });
    const stored = await documentStore(env()).get(doc.storage_key);
    if (!stored) return new Response("The file is missing from storage", { status: 404 });
    return new Response(asBody(stored.bytes), {
      headers: {
        "content-type": doc.content_type,
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${doc.filename.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof UserError) return new Response(e.message, { status: 409 });
    throw e;
  }
}
