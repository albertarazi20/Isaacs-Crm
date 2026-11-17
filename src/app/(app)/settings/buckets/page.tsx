import { ScoresCard } from "@/components/settings/ScoresCard";
import { SequenceEditor } from "@/components/settings/SequenceEditor";
import { SettingsCard } from "@/components/settings/primitives";
import { SettingsHeader } from "@/components/settings/SettingsNav";
import { TemplateEditor } from "@/components/settings/TemplateEditor";
import { Badge, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  bucketScores,
  listBucketSteps,
  listBuckets,
  listTemplates,
  templateScores,
} from "@/lib/buckets/queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;
const SCORE_DAYS = 90;

export default async function BucketsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ b?: string }>;
}) {
  const { b } = await searchParams;
  const session = await requireSession();
  const manager = CAN.manageTeam(session.role);
  const data = await db.withUser(session.userId, async (q) => {
    const buckets = await listBuckets(q, true);
    const templates = await listTemplates(q, true);
    const steps = new Map<string, Awaited<ReturnType<typeof listBucketSteps>>>();
    for (const x of buckets) steps.set(x.id, await listBucketSteps(q, x.id));
    const scores = {
      buckets: await bucketScores(q, SCORE_DAYS),
      templates: await templateScores(q, SCORE_DAYS),
    };
    return { buckets, templates, steps, scores };
  });
  const { buckets, templates, steps, scores } = data;
  const focus = b && UUID.test(b) ? b : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <SettingsHeader role={session.role} current="/settings/buckets" />
      <p className="text-sm text-muted">
        A bucket&apos;s sequence sends its templates on the days you set, stops the moment the
        merchant replies, uploads or signs, and the stips rules move people between the shop buckets
        by themselves. Your own buckets are yours to edit; a manager edits the shop&apos;s.
      </p>
      <div className="space-y-4">
        {buckets.map((x) => (
          <SettingsCard
            key={x.id}
            id={x.id}
            title={x.name}
            className={cn(focus === x.id && "ring-2 ring-accent/50")}
            aside={
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <Badge tone={x.owner_id ? "accent" : "neutral"}>
                  {x.owner_id
                    ? "mine"
                    : x.key
                      ? `shop · rule: ${x.rule?.replace(/_/g, " ")}`
                      : "shop"}
                </Badge>
                <span className="tabular-nums">· {x.members} in it</span>
                {!x.active ? <Badge tone="warn">off</Badge> : null}
              </span>
            }
          >
            <SequenceEditor
              bucket={x}
              steps={steps.get(x.id) ?? []}
              templates={templates}
              canEdit={manager || x.owner_id === session.userId}
            />
          </SettingsCard>
        ))}
      </div>
      <TemplateEditor templates={templates} manager={manager} scores={scores.templates} />
      <ScoresCard
        buckets={scores.buckets}
        templates={scores.templates}
        days={SCORE_DAYS}
        manager={manager}
      />
    </div>
  );
}
