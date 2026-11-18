import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClientView } from "@/components/client/ClientView";
import { approvalCadence, approvalForClient } from "@/lib/approvals/queries";
import { requireSession } from "@/lib/auth/server";
import { listBuckets } from "@/lib/buckets/queries";
import { getClientDetail, userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { clientFreshness, listDocuments } from "@/lib/docs/upload";
import { env } from "@/lib/env";
import { merchantApplication } from "@/lib/leads/application";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The clock at request time. The page is dynamic (cookies), so this is never a cached value. */
const requestTimeMs = () => Date.now();

/** The merchant's business name in the tab. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: "Merchant" };
  const session = await requireSession();
  // RLS scopes this to the signed-in user, like the page itself
  const name = await db.withUser(session.userId, async (q) => {
    const r = await q.query<{ business_name: string }>(
      "select business_name from clients where id = $1",
      [id],
    );
    return r.rows[0]?.business_name;
  });
  return { title: name || "Merchant" };
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id would make Postgres throw (500); it is just "no such client".
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  // RLS scopes this to the signed-in user, so another user's id comes back null like a missing one.
  const data = await db.withUser(session.userId, async (q) => {
    const detail = await getClientDetail(q, id);
    if (!detail) return null;
    const { today } = await userContext(q);
    return {
      detail,
      application: await merchantApplication(q, id),
      documents: await listDocuments(q, id),
      freshness: await clientFreshness(q, id, today),
      approval: await approvalForClient(q, id),
      cadence: await approvalCadence(q),
      buckets: (await listBuckets(q)).map((b) => ({ id: b.id, name: b.name })),
      bucketId:
        (
          await q.query<{ bucket_id: string }>(
            "select bucket_id from enrollments where client_id = $1 and stopped_at is null limit 1",
            [id],
          )
        ).rows[0]?.bucket_id ?? null,
      today,
    };
  });
  if (!data) notFound();
  return (
    <ClientView
      detail={data.detail}
      serverNow={requestTimeMs()}
      application={data.application}
      documents={data.documents}
      freshness={data.freshness}
      today={data.today}
      appUrl={env().APP_URL}
      approval={data.approval}
      cadence={data.cadence}
      buckets={data.buckets}
      bucketId={data.bucketId}
    />
  );
}
