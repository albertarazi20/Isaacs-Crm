import Link from "next/link";
import { BucketMembers } from "@/components/followup/BucketMembers";
import { BucketScoreStrip } from "@/components/followup/BucketScoreStrip";
import { NewBucket } from "@/components/followup/NewBucket";
import { Card, EmptyState, buttonClass, cn } from "@/components/ui";
import { requirePage } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  bucketScores,
  listBucketMembers,
  listBucketSteps,
  listBuckets,
  listTemplates,
} from "@/lib/buckets/queries";
import { db } from "@/lib/db";
import { loadMemberMeta } from "@/lib/messaging/memberMeta";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;
const SCORE_DAYS = 90;

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
    const meta = await loadMemberMeta(
      q,
      members.map((m) => m.client_id),
    );
    const score = selected
      ? (await bucketScores(q, SCORE_DAYS)).find((x) => x.bucket_id === selected.id)
      : undefined;
    const steps = selected ? await listBucketSteps(q, selected.id) : [];
    const templates = await listTemplates(q);
    const postal =
      (await q.query<{ postal_address: string }>("select postal_address from shop_settings"))
        .rows[0]?.postal_address ?? "";
    return { buckets, selected, members, meta, score, steps, templates, postal };
  });
  const { buckets, selected, members, meta, score, steps, templates, postal } = data;
  const shared = buckets.filter((x) => x.owner_id === null);
  const mine = buckets.filter((x) => x.owner_id !== null);

  // A pill in a scrolling row on a phone; a row of the left rail from lg up.
  const bucketLink = (x: (typeof buckets)[number]) => (
    <Link
      key={x.id}
      href={`/follow-up?b=${x.id}`}
      aria-current={selected?.id === x.id ? "page" : undefined}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-sm whitespace-nowrap transition lg:h-8 lg:w-full lg:justify-between lg:rounded-lg lg:border-transparent lg:px-2.5 lg:text-[13px]",
        selected?.id === x.id
          ? "border-accent/40 bg-accent-soft font-semibold text-accent"
          : "border-border bg-surface text-text-2 hover:border-border-strong hover:bg-surface-3 hover:text-text lg:bg-transparent lg:hover:bg-surface-2",
      )}
    >
      <span className="truncate">{x.name}</span>
      <span
        className={cn("text-xs tabular-nums", selected?.id === x.id ? "opacity-80" : "text-muted")}
      >
        {x.members}
      </span>
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Follow Up</h1>
          <p className="mt-0.5 text-sm text-muted">
            Each bucket emails its people on its own schedule and stops the moment they reply,
            upload or sign. Check names to blast or move them.
          </p>
        </div>
        <Link href="/settings/buckets" className={buttonClass("secondary", "sm")}>
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
      {/* Phone: bucket chips, then the bucket, then the new-bucket form. Wide: the rail holds chips and form, the bucket sits beside it. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start">
        <nav
          aria-label="Buckets"
          className="-mx-4 flex min-w-0 gap-1.5 overflow-x-auto px-4 pb-1 lg:col-start-1 lg:row-start-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0"
        >
          <p className="hidden px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase lg:block">
            Shop
          </p>
          {shared.map(bucketLink)}
          {mine.length > 0 ? (
            <p className="hidden px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase lg:block">
              Mine
            </p>
          ) : null}
          {mine.map(bucketLink)}
        </nav>
        <Card className="order-last p-3 lg:order-none lg:col-start-1 lg:row-start-2">
          <NewBucket canShare={manager} />
        </Card>
        <section className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <h2 className="text-base font-semibold tracking-tight">
                  {selected.name}{" "}
                  <span className="text-sm font-normal text-muted tabular-nums">
                    · {members.length}
                  </span>
                </h2>
                <p className="min-w-0 text-xs text-muted">
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
                    className="font-medium text-accent hover:underline"
                  >
                    edit
                  </Link>
                </p>
              </div>
              <BucketScoreStrip score={score} days={SCORE_DAYS} />
              <BucketMembers
                bucket={selected}
                members={members}
                meta={meta}
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
