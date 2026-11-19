import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { userContext } from "@/lib/data/queries";
import { isUuid } from "@/lib/data/schemas";
import { db } from "@/lib/db";
import { DOC_KINDS, type DocKind } from "@/lib/docs/label";
import { documentStore } from "@/lib/docs/storage";
import { addDocument, scanPending } from "@/lib/docs/upload";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Staff drag-and-drop: multipart with clientId, optional kind / period, and one or more `file`s. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send the files as form data" }, { status: 400 });
  const clientId = String(form.get("clientId") ?? "");
  const kindRaw = String(form.get("kind") ?? "");
  const period = String(form.get("period") ?? "") || null;
  if (!isUuid(clientId)) return NextResponse.json({ error: "Bad merchant id" }, { status: 400 });
  const kind =
    kindRaw && (DOC_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as DocKind)
      : undefined;
  const files = form
    .getAll("file")
    .filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  if (files.length === 0) return NextResponse.json({ error: "No file attached" }, { status: 400 });
  const store = documentStore(env());
  const results = await db.withUser(session.userId, async (q) => {
    const { today } = await userContext(q);
    const out = [];
    for (const f of files.slice(0, 10)) {
      try {
        const r = await addDocument(q, store, {
          clientId,
          kind,
          period: period && /^\d{4}-\d{2}-01$/.test(period) ? period : null,
          filename: f.name,
          contentType: f.type,
          bytes: new Uint8Array(await f.arrayBuffer()),
          uploadedBy: session.userId,
          today,
        });
        out.push({ filename: f.name, ok: true as const, ...r });
      } catch (e) {
        out.push({ filename: f.name, ok: false as const, error: toActionError(e) });
      }
    }
    return out;
  });
  // The rows went in 'pending' (a signed-in session cannot insert one as 'clean'). Scan these now, outside the user's
  // transaction, so the file opens at once instead of waiting for the next cron run; a failure leaves them pending for it.
  const ids = results.flatMap((r) => (r.ok ? [r.documentId] : []));
  if (ids.length > 0)
    await scanPending(db, store, undefined, ids.length, ids).catch((err: unknown) =>
      console.error("document scan:", err instanceof Error ? err.message : err),
    );
  return NextResponse.json({ results }, { status: results.some((r) => r.ok) ? 200 : 400 });
}
