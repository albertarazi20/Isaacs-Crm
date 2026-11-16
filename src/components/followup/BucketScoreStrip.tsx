import { Card } from "@/components/ui";
import type { BucketScore } from "@/lib/buckets/queries";

/** 0.1 → "10%"; a whole number stays whole, anything under a tenth of a percent shows one decimal. */
export const pct = (rate: number): string => {
  const p = rate * 100;
  return `${p >= 1 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">
        {value}
        {sub ? (
          <>
            {" "}
            <span className="ml-0.5 text-xs font-normal text-muted">{sub}</span>
          </>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * What this bucket's emails actually do (S1-7, `bucketScores`): sends in the window, and the replies, documents,
 * bounces and unsubscribes credited to them within 14 days. Shown in the bucket header.
 */
export function BucketScoreStrip({
  score,
  days,
}: {
  score: BucketScore | undefined;
  days: number;
}) {
  if (!score || score.sent === 0)
    return (
      <p className="text-xs text-muted" data-testid="bucket-scores">
        No emails have gone out from this bucket in the last {days} days, so there is no score yet.
      </p>
    );
  return (
    <Card className="p-3 sm:px-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[13px] font-semibold whitespace-nowrap">Bucket score</h3>
        <span className="text-xs text-muted">
          Last {days} days · replies and documents within 14 days of a send
        </span>
      </div>
      <dl
        className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-6"
        data-testid="bucket-scores"
      >
        <Stat label="Sent" value={String(score.sent)} />
        <Stat label="Replies" value={String(score.replies)} sub={pct(score.reply_rate)} />
        <Stat label="Docs in" value={String(score.docs_in)} sub={pct(score.docs_rate)} />
        <Stat
          label="Days to docs"
          value={score.avg_days_to_docs === null ? "—" : String(score.avg_days_to_docs)}
        />
        <Stat label="Bounced" value={String(score.bounces)} sub={pct(score.bounce_rate)} />
        <Stat
          label="Unsubscribed"
          value={String(score.unsubscribes)}
          sub={pct(score.unsubscribe_rate)}
        />
      </dl>
    </Card>
  );
}
