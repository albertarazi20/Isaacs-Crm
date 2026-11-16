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
      <span className={cn("font-semibold", current > 0 ? "text-good" : "text-muted")}>
        {current > 0
          ? `${plural(current, "business day")} in a row with nothing overdue at close`
          : "No streak yet"}
      </span>
      {best > current ? <span className="text-muted">Best: {best}</span> : null}
      <span className="text-muted">
        {openNow === 0
          ? "Nothing left today — a clean close is on the table."
          : `${plural(openNow, "follow-up")} left to keep it going.`}
      </span>
    </p>
  );
}
