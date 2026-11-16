import Link from "next/link";
import { SequenceEditor } from "@/components/settings/SequenceEditor";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { TemplateEditor } from "@/components/settings/TemplateEditor";
import { Card, SectionTitle, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { listBucketSteps, listBuckets, listTemplates } from "@/lib/buckets/queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/;
const POOLS = [
  "Approved, never funded",
  "Declined, now curable",
  "Took another offer",
  "Paid off",
  "Cold leads",
];

export default async function BucketsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ b?: string; tab?: string }>;
}) {
  const { b, tab } = await searchParams;
  const session = await requireSession();
  const manager = CAN.manageTeam(session.role);
  const data = await db.withUser(session.userId, async (q) => {
    const buckets = await listBuckets(q, true);
    const templates = await listTemplates(q, true);
    const steps = new Map<string, Awaited<ReturnType<typeof listBucketSteps>>>();
    for (const x of buckets) steps.set(x.id, await listBucketSteps(q, x.id));
    return { buckets, templates, steps };
  });
  const { buckets, templates, steps } = data;
  const winback = tab === "winback";
  const focus = b && UUID.test(b) ? b : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <SettingsNav role={session.role} current="/settings/buckets" />
      <nav className="flex gap-1.5">
        <Link
          href="/settings/buckets"
          aria-current={!winback ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 text-sm",
            !winback ? "border-accent bg-accent-soft text-accent" : "border-border text-muted",
          )}
        >
          Buckets
        </Link>
        <Link
          href="/settings/buckets?tab=winback"
          aria-current={winback ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 text-sm",
            winback ? "border-accent bg-accent-soft text-accent" : "border-border text-muted",
          )}
        >
          Winback pools
        </Link>
      </nav>
      {winback ? (
        <>
          <Card>
            <SectionTitle>How the pools email</SectionTitle>
            <p className="mt-2 text-sm text-muted">
              Each pool steps down on its own cadence. Write a shared template named exactly{" "}
              <span className="font-mono">Winback — &lt;pool&gt; — step N</span> and it replaces the
              built-in wording for that step. Pools:
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm text-muted">
              {POOLS.map((p) => (
                <li key={p}>
                  <span className="font-mono text-text">Winback — {p} — step 1</span>, step 2, …
                </li>
              ))}
            </ul>
          </Card>
          <TemplateEditor templates={templates} manager={manager} only="winback" />
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            A bucket&apos;s sequence sends its templates on the days you set, stops the moment the
            merchant replies, uploads or signs, and the stips rules move people between the shop
            buckets by themselves. Your own buckets are yours to edit; a manager edits the
            shop&apos;s.
          </p>
          <div className="space-y-3">
            {buckets.map((x) => (
              <Card key={x.id} className={cn(focus === x.id && "ring-2 ring-accent")}>
                <SectionTitle
                  aside={
                    <span className="text-xs text-muted">
                      {x.owner_id
                        ? "mine"
                        : x.key
                          ? `shop · rule: ${x.rule?.replace(/_/g, " ")}`
                          : "shop"}{" "}
                      · {x.members} in it{!x.active ? " · off" : ""}
                    </span>
                  }
                >
                  {x.name}
                </SectionTitle>
                <div className="mt-3">
                  <SequenceEditor
                    bucket={x}
                    steps={steps.get(x.id) ?? []}
                    templates={templates}
                    canEdit={manager || x.owner_id === session.userId}
                  />
                </div>
              </Card>
            ))}
          </div>
          <TemplateEditor templates={templates} manager={manager} only="buckets" />
        </>
      )}
    </div>
  );
}
