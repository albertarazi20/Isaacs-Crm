import type { Streak } from "@/lib/mca/streak";
import { cn } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The follow-up game in one line: business days in a row with nothing left overdue at close. */
export function StreakBadge({ streak, className }: { streak: Streak; className?: string }) {
  if (streak.empty) return null;
  const { current, best, openNow } = streak;
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]", className)}
      title="A day counts when every follow-up due that day or earlier was handled by the end of it. Weekends don't break a streak."
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ring-inset",
          current > 0
            ? "bg-good-soft text-good ring-good/20"
            : "bg-surface-2 text-muted ring-border",
        )}
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
        {current > 0
          ? `${plural(current, "business day")} in a row with nothing overdue at close`
          : "No streak yet"}
      </span>
      {best > current ? <span className="text-muted tabular-nums">Best: {best}</span> : null}
      <span className="text-muted">
        {openNow === 0
          ? "Nothing left today. A clean close is on the table."
          : `${plural(openNow, "follow-up")} left to keep it going.`}
      </span>
    </p>
  );
}
