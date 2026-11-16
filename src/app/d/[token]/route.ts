import { db } from "@/lib/db";
import { asBody, documentStore } from "@/lib/docs/storage";
import { resolveDownloadLink } from "@/lib/docs/upload";
import { isPdf, watermarkPdf } from "@/lib/docs/watermark";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ token: string }> };

/** An expiring link, usually for a lender. The PDF they get is stamped with their name and the date. */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  const link = await resolveDownloadLink(db, token, {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
  });
  if (!link)
    return new Response("This link has expired. Ask your contact for a new one.", { status: 410 });
  const stored = await documentStore(env()).get(link.document.storage_key);
  if (!stored) return new Response("The file is missing from storage", { status: 404 });
  let bytes = stored.bytes;
  if (isPdf(link.document.content_type, bytes)) {
    const stamp = `${link.watermark || "Confidential"} · ${new Date().toISOString().slice(0, 10)}`;
    bytes = await watermarkPdf(bytes, stamp).catch(() => bytes);
  }
  return new Response(asBody(bytes), {
    headers: {
      "content-type": link.document.content_type,
      "content-disposition": `attachment; filename="${link.document.filename.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
