import Link from "next/link";
import { BucketMembers } from "@/components/followup/BucketMembers";
import { NewBucket } from "@/components/followup/NewBucket";
import { Card, EmptyState, cn } from "@/components/ui";
import { requirePage } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  listBucketMembers,
  listBucketSteps,
  listBuckets,
  listTemplates,
} from "@/lib/buckets/queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;

export default async function FollowUpPage({
  searchParams,
}: {
  searchParams: Promise<{ b?: string }>;
}) {
  const { b } = await searchParams;
  const session = await requirePage("/follow-up");
  const manager = CAN.manageTeam(session.role);
  const data = await db.withUser(session.userId, async (q) => {
    const buckets = await listBuckets(q);
    const selected =
      (b && UUID.test(b) ? buckets.find((x) => x.id === b) : null) ??
      buckets.find((x) => x.members > 0) ??
      buckets[0] ??
      null;
    const members = selected ? await listBucketMembers(q, selected.id) : [];
    const steps = selected ? await listBucketSteps(q, selected.id) : [];
    const templates = await listTemplates(q);
    const postal =
      (await q.query<{ postal_address: string }>("select postal_address from shop_settings"))
        .rows[0]?.postal_address ?? "";
    return { buckets, selected, members, steps, templates, postal };
  });
  const { buckets, selected, members, steps, templates, postal } = data;
  const shared = buckets.filter((x) => x.owner_id === null);
  const mine = buckets.filter((x) => x.owner_id !== null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Follow Up</h1>
          <p className="text-sm text-muted">
            Each bucket emails its people on its own schedule and stops the moment they reply,
            upload or sign. Check names to blast or move them.
          </p>
        </div>
        <Link
          href="/settings/buckets"
          className="text-sm font-semibold text-accent hover:underline"
        >
          Sequences & templates →
        </Link>
      </div>
      {postal.trim() === "" ? (
        <p
          role="status"
          className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          Sequences and blasts are on hold until the shop&apos;s postal address is set
          {manager ? (
            <>
              {" "}
              in{" "}
              <Link href="/settings/email" className="font-semibold underline">
                Settings → Email
              </Link>
            </>
          ) : (
            " (a manager does that in Settings → Email)"
          )}
          . Welcome emails and replies still go out.
        </p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <nav aria-label="Buckets" className="space-y-1">
            <p className="px-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
              Shop
            </p>
            {shared.map((x) => (
              <Link
                key={x.id}
                href={`/follow-up?b=${x.id}`}
                aria-current={selected?.id === x.id ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm",
                  selected?.id === x.id
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                <span className="truncate">{x.name}</span>
                <span className="tabular-nums">{x.members}</span>
              </Link>
            ))}
            {mine.length > 0 ? (
              <p className="px-2 pt-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
                Mine
              </p>
            ) : null}
            {mine.map((x) => (
              <Link
                key={x.id}
                href={`/follow-up?b=${x.id}`}
                aria-current={selected?.id === x.id ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm",
                  selected?.id === x.id
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                <span className="truncate">{x.name}</span>
                <span className="tabular-nums">{x.members}</span>
              </Link>
            ))}
          </nav>
          <Card className="p-3">
            <NewBucket canShare={manager} />
          </Card>
        </aside>
        <section className="space-y-4">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  {selected.name}{" "}
                  <span className="text-sm font-normal text-muted">· {members.length}</span>
                </h2>
                <p className="text-xs text-muted">
                  {steps.length === 0
                    ? "No sequence yet — nothing goes out on its own."
                    : steps
                        .map((s) =>
                          s.action === "email"
                            ? `day ${s.day_offset}: ${s.template_name ?? "no template"}${s.template_approved === false ? " (unapproved)" : ""}`
                            : `day ${s.day_offset}: ${s.action.replace(/_/g, " ")}`,
                        )
                        .join(" → ")}
                  {" · "}
                  <Link
                    href={`/settings/buckets?b=${selected.id}`}
                    className="text-accent hover:underline"
                  >
                    edit
                  </Link>
                </p>
              </div>
              <BucketMembers
                bucket={selected}
                members={members}
                buckets={buckets}
                templates={templates}
              />
            </>
          ) : (
            <EmptyState title="No buckets yet">Make one on the left.</EmptyState>
          )}
        </section>
      </div>
    </div>
  );
}
