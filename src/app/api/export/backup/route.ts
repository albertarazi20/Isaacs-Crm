import { CAN, getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { recordExport } from "@/lib/system/notify";
import { buildBackup } from "@/lib/export/backup";
import { textStream } from "@/lib/export/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Everything Isaac has put in — merchants, advances, offers, notes, timers — as one JSON file he can keep. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  // plan §14: exports are manager-only, logged, and the managers are told
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  await recordExport(db, {
    userId: session.userId,
    email: session.email,
    kind: "backup",
    detail: "the full backup (JSON)",
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    userAgent: req.headers.get("user-agent") ?? "",
  });
  const backup = await db.withUser(session.userId, (q) => buildBackup(q));
  const day = backup.exportedAt.slice(0, 10);
  // Compact and streamed: pretty-printing only makes the file bigger, and a buffered response is capped on Vercel.
  return new Response(textStream(JSON.stringify(backup)), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-backup-${day}.json"`,
      "cache-control": "no-store",
    },
  });
}
