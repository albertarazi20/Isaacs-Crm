import { getSession } from "@/lib/auth/server";
import { UserError } from "@/lib/data/mutations";
import { db } from "@/lib/db";
import { asBody, documentStore } from "@/lib/docs/storage";
import { openDocument } from "@/lib/docs/upload";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * A signed-in user opens a document. Row-level security decides whether they may: the merchant's rep and the managers
 * get the file exactly as it was filed.
 */
export async function GET(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const download = url.searchParams.get("dl") === "1";
  try {
    const doc = await db.withUser(session.userId, (q) => openDocument(q, id));
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
