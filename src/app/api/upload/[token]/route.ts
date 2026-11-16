import { NextResponse } from "next/server";
import { toActionError } from "@/lib/data/errors";
import { db } from "@/lib/db";
import { documentStore } from "@/lib/docs/storage";
import { acceptUpload, openUploadPage } from "@/lib/docs/upload";
import { env } from "@/lib/env";
import { todayIn } from "@/lib/mca/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILES_PER_REQUEST = 10;

type Params = { params: Promise<{ token: string }> };

/** What this link is asking for, for the upload page's script. */
export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  const s = await openUploadPage(db, token, todayIn("America/New_York"));
  if (!s) return NextResponse.json({ error: "This link is not valid" }, { status: 404 });
  return NextResponse.json({
    token: s.token,
    business_name: s.business_name,
    wanted: s.wanted,
    expires_at: s.expires_at,
    files_received: s.files_received,
    max_files: s.max_files,
  });
}

/** The merchant's files, as multipart form data under `file`. One result per file, in order. */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the files as form data" }, { status: 400 });
  }
  const files = form
    .getAll("file")
    .filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  if (files.length === 0) return NextResponse.json({ error: "No file attached" }, { status: 400 });
  if (files.length > MAX_FILES_PER_REQUEST)
    return NextResponse.json(
      { error: `Send at most ${MAX_FILES_PER_REQUEST} files at a time` },
      { status: 400 },
    );
  const store = documentStore(env());
  const today = todayIn("America/New_York");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const results = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await acceptUpload(db, store, {
        token,
        filename: f.name,
        contentType: f.type,
        bytes,
        today,
        ip,
      });
      results.push({ filename: f.name, ok: true, ...r });
    } catch (e) {
      results.push({ filename: f.name, ok: false, error: toActionError(e) });
    }
  }
  const status = results.some((r) => r.ok) ? 200 : 400;
  return NextResponse.json({ results }, { status });
}
