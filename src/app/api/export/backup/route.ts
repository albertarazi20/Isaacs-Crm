import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { buildBackup } from "@/lib/export/backup";
import { textStream } from "@/lib/export/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Everything Isaac has put in — merchants, advances, offers, notes, timers — as one JSON file he can keep. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
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
