import type { Metadata } from "next";
import { ruleLabel } from "@/components/followup/bucketCopy";
import { ScoresCard } from "@/components/settings/ScoresCard";
import { SequenceEditor } from "@/components/settings/SequenceEditor";
import { SettingsCard } from "@/components/settings/primitives";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { TemplateEditor } from "@/components/settings/TemplateEditor";
import { Badge, buttonClass } from "@/components/ui";
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

export const metadata: Metadata = { title: "Buckets & templates" };

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
    <SettingsPage
      role={session.role}
      current="/settings/buckets"
      title="Buckets & templates"
      description="A bucket's sequence sends its templates on the days you set and stops the moment the merchant replies, uploads or signs. The stips rules move people between the shop buckets by themselves."
      actions={
        <>
          <a href="#templates" className={buttonClass("secondary", "sm")}>
            Templates
          </a>
          <a href="#scores" className={buttonClass("secondary", "sm")}>
            Scores
          </a>
        </>
      }
    >
      {buckets.map((x) => {
        const mine = x.owner_id === session.userId;
        const own = steps.get(x.id) ?? [];
        const last = own.length ? Math.max(...own.map((s) => s.day_offset)) : 0;
        return (
          <SettingsCard
            key={x.id}
            id={x.id}
            title={x.name}
            panelClassName={focus === x.id ? "ring-2 ring-accent/50" : undefined}
            description={
              <>
                <span className="tabular-nums">{x.members}</span> in it ·{" "}
                {own.length === 0
                  ? "no steps"
                  : `${own.length} step${own.length === 1 ? "" : "s"} over ${last} day${last === 1 ? "" : "s"}`}
                {x.owner_id
                  ? mine
                    ? ". Yours to edit."
                    : ". A rep's own bucket."
                  : ". A manager edits the shop's."}
              </>
            }
            aside={
              <>
                <Badge tone={x.owner_id ? "accent" : "neutral"}>
                  {x.owner_id ? "mine" : "shop"}
                </Badge>
                {!x.owner_id && x.key && x.rule ? (
                  <Badge tone="info">{ruleLabel(x.rule)}</Badge>
                ) : null}
                {!x.active ? <Badge tone="warn">off</Badge> : null}
              </>
            }
          >
            <SequenceEditor
              bucket={x}
              steps={own}
              templates={templates}
              canEdit={manager || mine}
            />
          </SettingsCard>
        );
      })}
      <TemplateEditor templates={templates} manager={manager} scores={scores.templates} />
      <ScoresCard
        buckets={scores.buckets}
        templates={scores.templates}
        days={SCORE_DAYS}
        manager={manager}
      />
    </SettingsPage>
  );
}
