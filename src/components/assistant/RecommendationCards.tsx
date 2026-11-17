"use client";

import Link from "next/link";
import { useState } from "react";
import { Glyph, type GlyphName } from "@/components/shell/icons";
import { cn } from "@/components/ui";
import type { Recommendation, RecommendationTone } from "@/lib/assistant/recommendations";

const TONE: Record<RecommendationTone, { chip: string; ink: string }> = {
  accent: { chip: "bg-accent-soft ring-accent/25", ink: "text-accent" },
  warn: { chip: "bg-warn-soft ring-warn/20", ink: "text-warn" },
  good: { chip: "bg-good-soft ring-good/20", ink: "text-good" },
  bad: { chip: "bg-bad-soft ring-bad/20", ink: "text-bad" },
  info: { chip: "bg-info-soft ring-info/20", ink: "text-info" },
};

/**
 * The assistant's suggested workflows as cards. "Plan it" hands the workflow to the assistant (which reads the
 * merchants, writes the steps and sets up the buttons); the arrow does it by hand on the right page.
 */
export function RecommendationCards({
  items,
  onPlan,
  ready,
  compact,
  phoneLimit,
}: {
  items: Recommendation[];
  onPlan: (r: Recommendation) => void;
  /** Whether the assistant can run (key, switch, budget); the cards still link to the pages when it cannot. */
  ready: boolean;
  compact?: boolean;
  /** On a phone, show this many and a "Show more": the list under the cards is what a rep works from. */
  phoneLimit?: number;
}) {
  const [all, setAll] = useState(false);
  const hidden = phoneLimit !== undefined && !all ? Math.max(0, items.length - phoneLimit) : 0;
  return (
    <>
      <ul
        className={cn(
          "grid grid-cols-1 gap-3",
          compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3",
        )}
      >
        {items.map((r, i) => {
          const t = TONE[r.tone];
          return (
            <li
              key={r.id}
              className={cn(
                "lift group flex flex-col rounded-2xl border border-border bg-surface p-4",
                hidden > 0 && i >= phoneLimit! && "max-sm:hidden",
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
                    t.chip,
                    t.ink,
                  )}
                >
                  <Glyph name={r.icon as GlyphName} className="size-[17px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-snug font-semibold tracking-tight">{r.title}</p>
                  <p className="mt-1 text-[12.5px] leading-snug text-muted">{r.why}</p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => onPlan(r)}
                  aria-label={`Plan it: ${r.title}`}
                  disabled={!ready}
                  title={ready ? undefined : "The assistant is not available right now"}
                  className="bg-brand-soft inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold text-text ring-1 ring-accent/30 transition duration-150 ring-inset hover:ring-accent/60 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 sm:h-8"
                >
                  <Glyph name="sparkles" className="size-3.5 text-accent" />
                  Plan it
                </button>
                <Link
                  href={r.href}
                  aria-label={`Open: ${r.title}`}
                  className="inline-flex h-10 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-muted transition duration-150 hover:bg-surface-2 hover:text-text sm:h-8"
                >
                  Open
                  <Glyph name="arrowRight" className="size-3.5" />
                </Link>
                {r.count > 0 ? (
                  <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-semibold text-text-2 tabular-nums">
                    {r.count}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full border border-border text-[13px] font-medium text-text-2 transition duration-150 hover:border-border-strong active:scale-[0.98] sm:hidden"
        >
          Show {hidden} more
          <Glyph name="chevronDown" className="size-3.5" />
        </button>
      ) : null}
    </>
  );
}
