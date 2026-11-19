import Link from "next/link";
import { CountUp } from "@/components/fx";
import { Glyph } from "@/components/shell/icons";
import { cn } from "@/components/ui";
import type { BucketRow, BucketScore } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";
import { BucketScoreStrip } from "./BucketScoreStrip";
import { isReadyBucket, sequenceSummary, stepNote, stepTitle } from "./bucketCopy";

/** The sequence as a rail: what goes out, and on which day after a merchant lands in the bucket. */
function SequenceRail({ steps }: { steps: readonly SequenceStep[] }) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Sequence steps"
      className="-mx-1 overflow-x-auto px-1 pb-1 focus-visible:outline-offset-[-2px]"
    >
      <ol className="flex">
        {steps.map((s, i) => (
          <li
            key={s.step_no}
            className="relative w-44 shrink-0 pr-5 sm:w-auto sm:min-w-36 sm:flex-1"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1",
                  s.action === "email"
                    ? "bg-accent-soft text-accent ring-accent/30"
                    : "bg-surface-2 text-text-2 ring-border-strong",
                )}
              >
                {s.step_no}
              </span>
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1 bg-border-strong/70",
                  i === steps.length - 1 && "opacity-0",
                )}
              />
            </div>
            <p className="eyebrow mt-2.5">
              {s.daily ? "Every day but Saturday" : `Day ${s.day_offset}`}
            </p>
            <p className="mt-0.5 truncate text-[13px] font-medium text-text" title={stepTitle(s)}>
              {stepTitle(s)}
            </p>
            <p
              className={cn(
                "truncate text-xs",
                s.action === "email" && (s.template_approved === false || !s.template_name)
                  ? "text-warn"
                  : "text-muted",
              )}
            >
              {stepNote(s)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The top panel of a bucket: how many are in it, what its sequence sends and when, and what that has earned. */
export function BucketBrief({
  bucket,
  count,
  steps,
  score,
  days,
}: {
  bucket: BucketRow;
  count: number;
  steps: readonly SequenceStep[];
  score: BucketScore | undefined;
  days: number;
}) {
  const ready = isReadyBucket(bucket);
  return (
    <section
      className={cn(
        "grid grid-cols-1 rounded-2xl border border-border bg-surface lg:grid-cols-[220px_minmax(0,1fr)]",
        ready && "ring-brand",
      )}
    >
      <div className="flex items-end justify-between gap-4 border-b border-border p-5 lg:flex-col lg:items-start lg:justify-between lg:border-r lg:border-b-0">
        <div>
          <p className="eyebrow">In this bucket</p>
          <p className="text-gradient mt-3 text-[52px] leading-none font-semibold tracking-[-0.05em]">
            <CountUp value={count} />
          </p>
          <p className="mt-2 text-xs text-muted">
            {count === 1 ? "merchant" : "merchants"} {ready ? "ready to hand off" : "being chased"}
          </p>
        </div>
        <Link
          href={`/settings/buckets?b=${bucket.id}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-full text-xs font-medium text-accent transition hover:text-accent-strong max-sm:min-h-10"
        >
          Edit sequence
          <Glyph name="arrowUpRight" className="size-3.5" />
        </Link>
      </div>

      <div className="min-w-0 divide-y divide-border">
        <div className="min-w-0 p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Sequence</h2>
            <p className="text-xs text-muted">
              {steps.length === 0
                ? "Nothing goes out on its own"
                : `${sequenceSummary(steps)}. Stops the moment they reply, upload or sign.`}
            </p>
          </div>
          {steps.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border-strong/70 px-4 py-3 text-[13px] text-muted">
              This bucket has no sequence yet. Add its emails under{" "}
              <Link
                href={`/settings/buckets?b=${bucket.id}`}
                className="font-medium text-accent hover:underline"
              >
                Sequences
              </Link>
              .
            </p>
          ) : (
            <SequenceRail steps={steps} />
          )}
        </div>
        <div className="p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-[13px] font-semibold tracking-tight">Bucket score</h2>
            <p className="text-xs text-muted">
              Last {days} days. Replies and documents count within 14 days of a send.
            </p>
          </div>
          <BucketScoreStrip score={score} days={days} />
        </div>
      </div>
    </section>
  );
}
