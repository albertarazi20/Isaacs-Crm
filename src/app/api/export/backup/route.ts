import { CAN, getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { buildBackup } from "@/lib/export/backup";
import {
  encryptBackup,
  ENCRYPTED_BACKUP_EXTENSION,
  passphraseProblem,
} from "@/lib/export/backupCrypto";
import { textStream } from "@/lib/export/stream";
import { recordExportDownload, refuseIfOverExportLimit, requestMeta } from "@/lib/system/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Who = { userId: string; email: string; ip: string; userAgent: string };

/** The signed-in manager, or the response that refuses. Exports are manager-only. */
async function manager(): Promise<Who | Response> {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  return { userId: session.userId, email: session.email, ...(await requestMeta()) };
}

/**
 * The backup as compact JSON text (pretty-printing only makes the file bigger) and the day it was taken. Counted in
 * the audit log with the other exports (who, how many rows) and held to the same 20 an hour; a refusal is answered
 * before anything is built.
 */
async function takeBackup(who: Who): Promise<{ json: string; day: string } | Response> {
  const refused = await refuseIfOverExportLimit(who);
  if (refused) return refused;
  const backup = await db.withUser(who.userId, (q) => buildBackup(q));
  const rows = Object.values(backup.counts).reduce((n, c) => n + c, 0);
  const over = await recordExportDownload({ ...who, what: "backup", rows });
  if (over) return over;
  return { json: JSON.stringify(backup), day: backup.exportedAt.slice(0, 10) };
}

const HEADERS = { "cache-control": "no-store" } as const;

/**
 * Everything Isaac has put in — merchants, notes, timers, stips — as one JSON file he can keep, NOT encrypted. The
 * settings panel offers it as the "download without encryption" choice; the encrypted download is the POST below.
 */
export async function GET() {
  const who = await manager();
  if (who instanceof Response) return who;
  const taken = await takeBackup(who);
  if (taken instanceof Response) return taken;
  // Streamed: a buffered response is capped on Vercel.
  return new Response(textStream(taken.json), {
    headers: {
      ...HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-backup-${taken.day}.json"`,
    },
  });
}

/**
 * The same backup, encrypted with the passphrase in the JSON body ({ "passphrase": "..." }). The passphrase travels in
 * the body, never the URL (URLs end up in logs), is checked before anything is read from the database, and is never
 * stored or logged: lose it and the file cannot be opened by anyone.
 */
export async function POST(req: Request) {
  // Signed out or not a manager is answered first, so a stranger learns nothing about the passphrase rules.
  const who = await manager();
  if (who instanceof Response) return who;
  const body: unknown = await req.json().catch(() => null);
  const passphrase =
    body && typeof body === "object" ? (body as { passphrase?: unknown }).passphrase : undefined;
  const problem = passphraseProblem(passphrase);
  if (problem !== null || typeof passphrase !== "string")
    return new Response(problem ?? "Type a passphrase", { status: 400 });
  const taken = await takeBackup(who);
  if (taken instanceof Response) return taken;
  const file = await encryptBackup(taken.json, passphrase);
  return new Response(textStream(file), {
    headers: {
      ...HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-backup-${taken.day}${ENCRYPTED_BACKUP_EXTENSION}"`,
    },
  });
}
