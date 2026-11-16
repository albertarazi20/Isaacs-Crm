import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { DOC_KINDS, type DocKind } from "@/lib/docs/label";
import { documentStore } from "@/lib/docs/storage";
import { addDocument } from "@/lib/docs/upload";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f-]{36}$/;

/** Staff drag-and-drop: multipart with clientId, optional dealId / kind / period, and one or more `file`s. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Send the files as form data" }, { status: 400 });
  const clientId = String(form.get("clientId") ?? "");
  const dealId = String(form.get("dealId") ?? "") || null;
  const kindRaw = String(form.get("kind") ?? "");
  const period = String(form.get("period") ?? "") || null;
  if (!UUID.test(clientId) || (dealId && !UUID.test(dealId)))
    return NextResponse.json({ error: "Bad merchant or deal id" }, { status: 400 });
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
          dealId,
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
  return NextResponse.json({ results }, { status: results.some((r) => r.ok) ? 200 : 400 });
}
