import Link from "next/link";
import { CountUp } from "@/components/fx";
import { Glyph } from "@/components/shell/icons";
import { Badge, Meter, cn } from "@/components/ui";
import type { BucketRow, BucketScore } from "@/lib/buckets/queries";
import type { BucketPulse, SequenceStep } from "@/lib/followup/bucketBoard";
import { pct } from "./BucketScoreStrip";
import { bucketPurpose, isReadyBucket, sequenceSummary } from "./bucketCopy";

const NO_PULSE: BucketPulse = { due_today: 0, replied: 0, paused: 0 };

/** One dot per step: a filled dot sends an email, a ring is a call task, a grey dot hands over to Cold. */
function StepDots({ steps }: { steps: readonly SequenceStep[] }) {
  if (steps.length === 0) return null;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1">
      {steps.map((s) => (
        <span
          key={s.step_no}
          className={cn(
            "size-1.5 rounded-full",
            s.action === "email"
              ? "bg-accent"
              : s.action === "call"
                ? "ring-1 ring-accent ring-inset"
                : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}

function BucketCard({
  bucket,
  score,
  steps,
  pulse,
  days,
}: {
  bucket: BucketRow;
  score: BucketScore | undefined;
  steps: readonly SequenceStep[];
  pulse: BucketPulse;
  days: number;
}) {
  const ready = isReadyBucket(bucket);
  const sent = score?.sent ?? 0;
  return (
    <Link
      href={`/follow-up?b=${bucket.id}`}
      className={cn(
        "group flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-5 active:scale-[0.99]",
        ready && "ring-brand",
      )}
    >
      <h3 className="truncate text-[15px] font-semibold tracking-tight" title={bucket.name}>
        {bucket.name}
      </h3>
      <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted">
        {bucketPurpose(bucket)}
      </p>

      <div className="mt-4 flex items-end justify-between gap-3">
        <p className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-[40px] leading-none font-semibold tracking-[-0.045em] tabular-nums",
              bucket.members === 0 ? "text-muted/60" : ready ? "text-gradient" : "text-text",
            )}
          >
            {bucket.members}
          </span>
          <span className="text-xs text-muted">
            {bucket.members === 1 ? "merchant" : "merchants"}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {ready && bucket.members > 0 ? <Badge tone="accent">Hand off</Badge> : null}
          {pulse.due_today > 0 ? <Badge tone="accent">{pulse.due_today} due</Badge> : null}
          {pulse.replied > 0 ? <Badge tone="bad">{pulse.replied} replied</Badge> : null}
          {pulse.paused > 0 ? <Badge tone="warn">{pulse.paused} paused</Badge> : null}
          <span
            aria-hidden
            className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-3 text-muted transition duration-200 group-hover:border-accent/40 group-hover:bg-accent-soft group-hover:text-accent"
          >
            <Glyph
              name="arrowRight"
              className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-border pt-3.5">
        <div className="flex items-center gap-2.5 text-xs">
          <StepDots steps={steps} />
          <span className="truncate text-text-2" title={sequenceSummary(steps)}>
            {sequenceSummary(steps)}
          </span>
        </div>
        {sent > 0 && score ? (
          <div
            className="flex items-center gap-2.5 text-xs"
            title={`${score.sent} sent, ${score.replies} replied, ${score.docs_in} brought documents in. Last ${days} days.`}
          >
            <span className="shrink-0 text-muted">Reply rate</span>
            <Meter value={score.reply_rate} max={1} tone="brand" className="h-1" />
            <span className="shrink-0 font-semibold text-text tabular-nums">
              {pct(score.reply_rate)}
            </span>
            <span className="shrink-0 text-muted tabular-nums">of {score.sent}</span>
          </div>
        ) : (
          <p className="text-xs text-muted">No emails sent in {days} days</p>
        )}
      </div>
    </Link>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "accent" | "bad" | "warn";
}) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd
        className={cn(
          "mt-1.5 text-2xl leading-none font-semibold tracking-tight tabular-nums",
          tone === "accent" && "text-accent",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </dd>
      <dd className="mt-1.5 text-xs text-muted">{hint}</dd>
    </div>
  );
}

/** The "All buckets" board: the whole follow-up operation at a glance, every card a door into its bucket. */
export function BucketBoard({
  buckets,
  scores,
  sequences,
  pulse,
  days,
}: {
  buckets: BucketRow[];
  scores: BucketScore[];
  sequences: Record<string, SequenceStep[]>;
  pulse: Record<string, BucketPulse>;
  days: number;
}) {
  const shared = buckets.filter((b) => b.owner_id === null);
  const mine = buckets.filter((b) => b.owner_id !== null);
  const scoreOf = new Map(scores.map((s) => [s.bucket_id, s]));
  const total = buckets.reduce((n, b) => n + b.members, 0);
  const sum = (pick: (p: BucketPulse) => number) =>
    buckets.reduce((n, b) => n + pick(pulse[b.id] ?? NO_PULSE), 0);
  const due = sum((p) => p.due_today);
  const replied = sum((p) => p.replied);
  const paused = sum((p) => p.paused);
  const sent = scores.reduce((n, s) => n + s.sent, 0);
  const replies = scores.reduce((n, s) => n + s.replies, 0);

  const grid = (list: BucketRow[]) => (
    <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {list.map((b) => (
        <BucketCard
          key={b.id}
          bucket={b}
          score={scoreOf.get(b.id)}
          steps={sequences[b.id] ?? []}
          pulse={pulse[b.id] ?? NO_PULSE}
          days={days}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-8">
      <section className="ring-brand rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-x-12 gap-y-6">
          <div>
            <p className="eyebrow flex items-center gap-2">
              <span className="live-dot text-good" /> In follow-up right now
            </p>
            <p className="text-gradient mt-3 text-[56px] leading-none font-semibold tracking-[-0.05em]">
              <CountUp value={total} />
            </p>
            <p className="mt-2 text-xs text-muted">
              {total === 1 ? "merchant" : "merchants"} across {buckets.length}{" "}
              {buckets.length === 1 ? "bucket" : "buckets"}
            </p>
          </div>
          <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
            <Figure
              label="Due today"
              value={String(due)}
              hint="steps ready to go out"
              tone={due > 0 ? "accent" : undefined}
            />
            <Figure
              label="Replies waiting"
              value={String(replied)}
              hint="merchants to answer"
              tone={replied > 0 ? "bad" : undefined}
            />
            <Figure
              label="Paused"
              value={String(paused)}
              hint="nothing goes out"
              tone={paused > 0 ? "warn" : undefined}
            />
            <Figure
              label="Reply rate"
              value={sent > 0 ? pct(replies / sent) : "-"}
              hint={sent > 0 ? `${sent} emails in ${days} days` : `no sends in ${days} days`}
            />
          </dl>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Shop buckets</h2>
          <p className="text-xs text-muted">Everyone works these</p>
        </div>
        {grid(shared)}
      </section>

      {mine.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight">My buckets</h2>
            <p className="text-xs text-muted">Only you see these</p>
          </div>
          {grid(mine)}
        </section>
      ) : null}
    </div>
  );
}
