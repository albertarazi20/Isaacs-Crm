import { CAN, getSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { clientRows, CLIENT_HEADER, toCsv } from "@/lib/export/csv";
import { recordExportDownload, refuseIfOverExportLimit, requestMeta } from "@/lib/system/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Most merchants a filtered download can name: more than any book, so it only stops a runaway request. */
const MAX_IDS = 50_000;

/**
 * Every client the signed-in user owns, as a spreadsheet (GET), or just the ones named in the `ids` form field
 * (POST: the merchants list's current filters, comma-separated). Runs as the user, so row-level security applies.
 * Each download is written to the audit log (who, how many rows); 20 an hour per person is the most.
 */
async function download(only: ReadonlySet<string> | null): Promise<Response> {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  // exports are manager-only
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  const who = { userId: session.userId, email: session.email, ...(await requestMeta()) };
  const refused = await refuseIfOverExportLimit(who);
  if (refused) return refused;
  const all = await db.withUser(session.userId, (q) => listCards(q));
  // an id the user can't see is simply not in `all`, so naming one never reveals or adds a row
  const cards = only ? all.filter((c) => only.has(c.id)) : all;
  const over = await recordExportDownload({ ...who, what: "clients", rows: cards.length });
  if (over) return over;
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(CLIENT_HEADER, clientRows(cards)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-clients${only ? "-filtered" : ""}-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}

export async function GET() {
  return download(null);
}

export async function POST(req: Request) {
  // who and what role come before reading the body: a stranger cannot make the server parse a large upload
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  let raw: unknown;
  try {
    raw = (await req.formData()).get("ids");
  } catch {
    return new Response("Send the merchants to download as the ids field", { status: 400 });
  }
  if (typeof raw !== "string")
    return new Response("Send the merchants to download as the ids field", { status: 400 });
  const ids = raw.split(",").filter(Boolean);
  if (ids.length > MAX_IDS)
    return new Response("Too many merchants in one download", { status: 413 });
  return download(new Set(ids));
}
