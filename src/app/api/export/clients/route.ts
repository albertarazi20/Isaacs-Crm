import { CAN, getSession } from "@/lib/auth/server";
import { listCards } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { clientRows, CLIENT_HEADER, toCsv } from "@/lib/export/csv";
import { recordExportDownload, refuseIfOverExportLimit, requestMeta } from "@/lib/system/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every client the signed-in user owns, as a spreadsheet. Runs as the user, so row-level security applies. Each
 * download is written to the audit log (who, how many rows); 20 an hour per person is the most.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  // exports are manager-only
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  const who = { userId: session.userId, email: session.email, ...(await requestMeta()) };
  const refused = await refuseIfOverExportLimit(who);
  if (refused) return refused;
  const cards = await db.withUser(session.userId, (q) => listCards(q));
  const over = await recordExportDownload({ ...who, what: "clients", rows: cards.length });
  if (over) return over;
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(CLIENT_HEADER, clientRows(cards)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="isaac-clients-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
