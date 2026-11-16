import { Badge } from "@/components/ui";
import { Icon } from "@/components/deals/primitives";
import { cn } from "@/components/ui";
import type { StateBadge as StateBadgeData } from "@/lib/funders/states";

const TONE = { none: "neutral", ok: "good", watch: "warn", stop: "bad" } as const;

/** The merchant's state and where the shop stands there: "TX · registered", "FL · fee rule", "No state on file". */
export function StateBadgePill({ badge }: { badge: StateBadgeData }) {
  return (
    <span data-state-badge={badge.tone} className="inline-flex">
      <Badge tone={TONE[badge.tone]}>{badge.label}</Badge>
    </span>
  );
}

/** What to say or do before this file goes to lenders or funds, worst first. Nothing when the state has no rule. */
export function StateWarnings({ badge }: { badge: StateBadgeData }) {
  if (badge.warnings.length === 0) return null;
  return (
    <ul
      aria-label="State rules"
      className="space-y-1 border-t border-border px-4 py-3 text-sm sm:px-5"
    >
      {badge.warnings.map((w) => (
        <li
          key={w}
          className={cn(
            "flex items-start gap-2",
            badge.tone === "stop"
              ? "text-bad"
              : badge.tone === "watch"
                ? "text-warn"
                : "text-muted",
          )}
        >
          <Icon name="alert" className="mt-0.5" />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}
