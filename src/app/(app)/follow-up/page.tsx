import type { Metadata } from "next";
import { AskButton } from "@/components/assistant/AskButton";
import { ALL_BUCKETS_BRIEF, bucketBrief } from "@/lib/assistant/prompts";
import Link from "next/link";
import { BucketBoard } from "@/components/followup/BucketBoard";
import { AllMembersSearch } from "@/components/followup/AllMembersSearch";
import { BucketBrief } from "@/components/followup/BucketBrief";
import { BucketMembers } from "@/components/followup/BucketMembers";
import { BucketSwitcher } from "@/components/followup/BucketSwitcher";
import { NewBucketButton } from "@/components/followup/NewBucket";
import { bucketPurpose } from "@/components/followup/bucketCopy";
import { Glyph } from "@/components/shell/icons";
import { EmptyState, PageHeader, buttonClass } from "@/components/ui";
import { requirePage, requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  bucketScores,
  listAllMembersCapped,
  listBucketMembers,
  listBuckets,
  listTemplates,
} from "@/lib/buckets/queries";
import { userContext } from "@/lib/data/queries";
import { isUuid } from "@/lib/data/schemas";
import { db } from "@/lib/db";
import { bucketPulse, listSequences } from "@/lib/followup/bucketBoard";
import { loadMemberMeta } from "@/lib/messaging/memberMeta";

export const dynamic = "force-dynamic";

const SCORE_DAYS = 90;

/** Sequences and blasts wait for the shop's postal address; say so wherever they would have gone out. */
function PostalHold({ manager }: { manager: boolean }) {
  return (
    <p
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
    >
      <Glyph name="alert" className="mt-0.5 size-4 shrink-0" />
      <span>
        Sequences and blasts are on hold until the shop&apos;s postal address is set
        {manager ? (
          <>
            {" "}
            in{" "}
            <Link href="/settings/email" className="font-semibold underline underline-offset-2">
              Settings, Email
            </Link>
          </>
        ) : (
          " (a manager does that in Settings, Email)"
        )}
        . Welcome emails and replies still go out.
      </span>
    </p>
  );
}

/** The bucket's own name in the tab when one is open; the overview of every bucket is "Follow Up". */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ b?: string }>;
}): Promise<Metadata> {
  const { b } = await searchParams;
  if (!b || !isUuid(b)) return { title: "Follow Up" };
  const session = await requireSession();
  const name = await db.withUser(session.userId, async (q) => {
    const r = await q.query<{ name: string }>("select name from buckets where id = $1", [b]);
    return r.rows[0]?.name;
  });
  return { title: name ?? "Follow Up" };
}

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
    const selected = (b && isUuid(b) ? buckets.find((x) => x.id === b) : null) ?? null;
    const scores = await bucketScores(q, SCORE_DAYS);
    const sequences = await listSequences(q);
    const postal =
      (await q.query<{ postal_address: string }>("select postal_address from shop_settings"))
        .rows[0]?.postal_address ?? "";
    if (!selected) {
      const { today } = await userContext(q);
      const pulse = await bucketPulse(q, today);
      const everyone = await listAllMembersCapped(q);
      return { buckets, selected, scores, sequences, postal, pulse, everyone };
    }
    const members = await listBucketMembers(q, selected.id);
    const meta = await loadMemberMeta(
      q,
      members.map((m) => m.client_id),
    );
    const templates = await listTemplates(q);
    return { buckets, selected, scores, sequences, postal, members, meta, templates };
  });
  const { buckets, scores, sequences, postal } = data;
  const hold = postal.trim() === "" ? <PostalHold manager={manager} /> : null;
  const sequencesLink = (
    <Link href="/settings/buckets" className={buttonClass("secondary", "md")}>
      Sequences and templates
    </Link>
  );

  // No bucket picked: the board of every bucket.
  if (!data.selected) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Follow Up"
          title="All buckets"
          description="Each bucket emails its people on its own schedule and stops the moment they reply, upload or sign. Open one to work its list."
          actions={
            <>
              <AskButton
                label="Review my buckets"
                text="Review with the assistant"
                prompt={ALL_BUCKETS_BRIEF}
              />
              {sequencesLink}
              <NewBucketButton canShare={manager} variant="primary" />
            </>
          }
        />
        {hold}
        <AllMembersSearch
          members={data.everyone.members}
          truncated={data.everyone.truncated}
          canExport={CAN.exportData(session.role)}
        />
        {buckets.length === 0 ? (
          <EmptyState title="No buckets yet" action={<NewBucketButton canShare={manager} />}>
            A bucket is a follow-up list: the merchants in it, and the emails they get.
          </EmptyState>
        ) : (
          <BucketBoard
            buckets={buckets}
            scores={scores}
            sequences={sequences}
            pulse={data.pulse}
            days={SCORE_DAYS}
          />
        )}
      </div>
    );
  }

  // One bucket: its brief, then its people.
  const { selected, members, meta, templates } = data;
  const steps = sequences[selected.id] ?? [];
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={
          <>
            <Link href="/follow-up" className="transition hover:text-text">
              Follow Up
            </Link>
            <span aria-hidden className="mx-1.5 opacity-50">
              /
            </span>
            {selected.owner_id === null ? "Shop bucket" : "My bucket"}
          </>
        }
        title={
          <>
            <span className="sr-only">Follow Up: </span>
            {selected.name}
          </>
        }
        description={bucketPurpose(selected)}
        actions={
          <>
            <AskButton
              label={`Work the ${data.selected.name} bucket`}
              text="Work it with the assistant"
              prompt={bucketBrief(data.selected.name, data.selected.id)}
            />
            <NewBucketButton canShare={manager} />
          </>
        }
      />
      <BucketSwitcher
        current={selected.id}
        items={buckets.map((x) => ({ id: x.id, name: x.name, members: x.members }))}
      />
      {hold}
      <BucketBrief
        bucket={selected}
        count={members.length}
        steps={steps}
        score={scores.find((x) => x.bucket_id === selected.id)}
        days={SCORE_DAYS}
      />
      <BucketMembers
        bucket={selected}
        members={members}
        meta={meta}
        buckets={buckets}
        templates={templates}
        steps={steps}
        canExport={CAN.exportData(session.role)}
      />
    </div>
  );
}
