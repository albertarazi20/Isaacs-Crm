import { Meter, cn } from "@/components/ui";
import type { BucketScore } from "@/lib/buckets/queries";

/** 0.1 → "10%"; a whole number stays whole, anything under a tenth of a percent shows one decimal. */
export const pct = (rate: number): string => {
  const p = rate * 100;
  return `${p >= 1 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
};

function Stat({
  label,
  value,
  sub,
  rate,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  /** A fraction 0..1 drawn as a thin bar under the figure. */
  rate?: number;
  tone?: "brand" | "good" | "bad" | "warn";
}) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 text-[17px] leading-none font-semibold tracking-tight tabular-nums">
        {value}
        {sub ? (
          <>
            {" "}
            <span className="ml-0.5 text-xs font-medium text-muted">{sub}</span>
          </>
        ) : null}
      </dd>
      {rate !== undefined ? (
        <Meter value={rate} max={1} tone={tone ?? "brand"} className="mt-2 h-1 max-w-24" />
      ) : null}
    </div>
  );
}

/**
 * What this bucket's emails actually do (S1-7, `bucketScores`): sends in the window, and the replies, documents,
 * bounces and unsubscribes credited to them within 14 days. Sits in the bucket's header panel.
 */
export function BucketScoreStrip({
  score,
  days,
  className,
}: {
  score: BucketScore | undefined;
  days: number;
  className?: string;
}) {
  if (!score || score.sent === 0)
    return (
      <p className={cn("text-xs text-muted", className)} data-testid="bucket-scores">
        No emails have gone out from this bucket in the last {days} days, so there is no score yet.
      </p>
    );
  return (
    <dl
      className={cn("grid grid-cols-3 gap-x-5 gap-y-4 sm:grid-cols-6", className)}
      data-testid="bucket-scores"
      title={`Last ${days} days. Replies and documents count within 14 days of a send.`}
    >
      <Stat label="Sent" value={String(score.sent)} />
      <Stat
        label="Replies"
        value={String(score.replies)}
        sub={pct(score.reply_rate)}
        rate={score.reply_rate}
      />
      <Stat
        label="Docs in"
        value={String(score.docs_in)}
        sub={pct(score.docs_rate)}
        rate={score.docs_rate}
        tone="good"
      />
      <Stat
        label="Days to docs"
        value={score.avg_days_to_docs === null ? "-" : String(score.avg_days_to_docs)}
      />
      <Stat
        label="Bounced"
        value={String(score.bounces)}
        sub={pct(score.bounce_rate)}
        rate={score.bounce_rate}
        tone="bad"
      />
      <Stat
        label="Unsubscribed"
        value={String(score.unsubscribes)}
        sub={pct(score.unsubscribe_rate)}
        rate={score.unsubscribe_rate}
        tone="warn"
      />
    </dl>
  );
}
