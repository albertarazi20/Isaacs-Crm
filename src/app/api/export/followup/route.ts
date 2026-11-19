import { CAN, getSession } from "@/lib/auth/server";
import { listAllMembersCapped, listBucketMembers } from "@/lib/buckets/queries";
import { isUuid } from "@/lib/data/schemas";
import { db } from "@/lib/db";
import { fileSlug, followupCsv } from "@/lib/export/followup";
import { recordExportDownload, refuseIfOverExportLimit, requestMeta } from "@/lib/system/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One bucket (?bucket=<id>) or every bucket (?bucket=all) as a spreadsheet for a sheet and a text blast. Runs as the
 * signed-in manager, so row-level security applies; do-not-contact merchants are left out (their number is in the
 * x-left-out header). An all-buckets file that hit the cap says so in x-truncated. Each download is written to the
 * audit log (who, how many rows); 20 an hour per person is the most.
 */
export async function GET(req: Request) {
  return download(req, new URL(req.url).searchParams.get("bucket") ?? "all", null);
}

/**
 * The page's own filtered view of one bucket (the checked or shown rows): the browser sends the bucket and the
 * merchant ids it is showing, and the file is built here so the same manager check, audit line and hourly limit apply
 * as for the plain download. Ids that are not in the bucket (or not visible to the manager) add nothing.
 */
export async function POST(req: Request) {
  // who and what role come before reading the body: a stranger cannot make the server parse a large upload
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Send the bucket and the ids to download", { status: 400 });
  }
  const bucket = form.get("bucket");
  const raw = form.get("ids");
  if (
    typeof bucket !== "string" ||
    (bucket !== "all" && !isUuid(bucket)) ||
    typeof raw !== "string"
  )
    return new Response("Send the bucket and the ids to download", { status: 400 });
  const ids = raw.split(",").filter(Boolean);
  if (ids.length > 5000) return new Response("Too many merchants in one download", { status: 413 });
  return download(req, bucket, new Set(ids));
}

async function download(req: Request, which: string, only: Set<string> | null) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  if (!CAN.exportData(session.role))
    return new Response("Exports are for managers", { status: 403 });
  if (which !== "all" && !isUuid(which)) return new Response("Unknown bucket", { status: 400 });

  const who = { userId: session.userId, email: session.email, ...(await requestMeta(req.headers)) };
  const refused = await refuseIfOverExportLimit(who);
  if (refused) return refused;
  const found = await db.withUser(session.userId, async (q) => {
    if (which === "all") {
      const all = await listAllMembersCapped(q);
      return { name: "all-buckets", members: all.members, truncated: all.truncated };
    }
    const named = await q.query<{ name: string }>("select name from buckets where id = $1", [
      which,
    ]);
    if (!named.rows[0]) return null;
    return {
      name: fileSlug(named.rows[0].name),
      members: await listBucketMembers(q, which),
      truncated: false,
    };
  });
  if (!found) return new Response("Unknown bucket", { status: 404 });

  const members = only ? found.members.filter((m) => only.has(m.client_id)) : found.members;
  const { csv, left } = followupCsv(members);
  const over = await recordExportDownload({
    ...who,
    what: which === "all" ? "follow-up (all buckets)" : "follow-up (one bucket)",
    rows: members.length - left,
  });
  if (over) return over;
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="selective-${found.name}-${day}.csv"`,
      "cache-control": "no-store",
      "x-left-out": String(left),
      // the file stopped at the most the all-buckets list holds: more people exist than it has
      "x-truncated": found.truncated ? "1" : "0",
    },
  });
}
