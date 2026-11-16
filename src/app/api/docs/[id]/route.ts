import { getSession } from "@/lib/auth/server";
import { UserError } from "@/lib/data/mutations";
import { db } from "@/lib/db";
import { asBody, documentStore } from "@/lib/docs/storage";
import { openDocument, recordView } from "@/lib/docs/upload";
import { isPdf, watermarkPdf } from "@/lib/docs/watermark";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * A signed-in user opens a document. Row-level security decides whether they may; every open is logged; PDFs carry
 * the viewer's name and the time as a watermark (plan: a leaked file says where it leaked from).
 */
export async function GET(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const download = url.searchParams.get("dl") === "1";
  const meta = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
  };
  try {
    const doc = await db.withUser(session.userId, async (q) => {
      const d = await openDocument(q, id);
      await recordView(q, d.id, download ? "download" : "view", session.userId, meta);
      return d;
    });
    const stored = await documentStore(env()).get(doc.storage_key);
    if (!stored) return new Response("The file is missing from storage", { status: 404 });
    let bytes = stored.bytes;
    if (isPdf(doc.content_type, bytes)) {
      const who = session.email ?? session.userId;
      const when = new Date().toISOString().slice(0, 16).replace("T", " ");
      bytes = await watermarkPdf(bytes, `${who} · ${when} UTC · ${doc.business_name}`).catch(
        () => bytes,
      );
    }
    return new Response(asBody(bytes), {
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
