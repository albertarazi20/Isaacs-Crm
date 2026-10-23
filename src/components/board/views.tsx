"use client";

import { useState, type ReactNode } from "react";
import { cn, GROUP_COLOR } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { BUCKET_ORDER, type BucketKey, type ISODate } from "@/lib/mca/dates";
import { STAGE_GROUPS, STAGES, type StageGroup, type StageKey } from "@/lib/mca/stages";
import { BucketColumn, StageColumn } from "./columns";
import { BoardScrollContext } from "./LazySlot";

interface Shared {
  today: ISODate;
  timezone: string;
  onOpenPicker: (card: ClientCard) => void;
}

/** Horizontal board. Snapping helps thumbs on a phone but would fight the auto-scroll while dragging. */
function Scroller({
  label,
  dragging,
  children,
}: {
  label: string;
  dragging: boolean;
  children: ReactNode;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setEl}
      role="region"
      aria-label={label}
      className={cn(
        "flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden pb-2",
        !dragging && "snap-x snap-proximity",
      )}
    >
      <BoardScrollContext.Provider value={el}>{children}</BoardScrollContext.Provider>
    </div>
  );
}

export function PipelineView({
  byStage,
  hideEmpty,
  dragging,
  collapsed,
  onToggleGroup,
  ...shared
}: Shared & {
  byStage: Record<StageKey, ClientCard[]>;
  hideEmpty: boolean;
  dragging: boolean;
  collapsed: ReadonlySet<StageGroup>;
  onToggleGroup: (g: StageGroup) => void;
}) {
  return (
    <Scroller label="Pipeline board, one column per stage" dragging={dragging}>
      {STAGE_GROUPS.map((g) => {
        const stages = STAGES.filter((s) => s.group === g.key);
        const count = stages.reduce((n, s) => n + byStage[s.key].length, 0);
        const shown = stages.filter((s) => !hideEmpty || dragging || byStage[s.key].length > 0);
        if (shown.length === 0) return null;
        const color = GROUP_COLOR[g.key];

        if (collapsed.has(g.key))
          return (
            <section
              key={g.key}
              aria-label={`${g.label}, collapsed, ${count} merchants`}
              className="flex w-11 shrink-0 snap-start flex-col rounded-lg border border-border bg-surface-2/60"
              style={{ borderTopColor: color, borderTopWidth: 4 }}
            >
              <button
                type="button"
                aria-expanded={false}
                aria-label={`Show ${g.label} stages, ${count} merchants`}
                onClick={() => onToggleGroup(g.key)}
                className="flex h-full w-full flex-col items-center gap-2 rounded-lg py-2 text-sm font-semibold [writing-mode:vertical-rl] hover:bg-surface-2"
              >
                <span aria-hidden>▸</span>
                <span>{g.label}</span>
                <span className="rounded-full bg-surface px-1.5 text-xs font-medium text-muted">
                  {count}
                </span>
              </button>
            </section>
          );

        return (
          <section key={g.key} aria-label={`${g.label} stages`} className="flex shrink-0 flex-col">
            <header
              className="rounded-t-lg border-t-4 px-2 py-1"
              style={{
                borderTopColor: color,
                background: `color-mix(in oklab, ${color} 14%, var(--surface))`,
              }}
            >
              <div className="sticky left-2 inline-flex items-center gap-2 text-sm font-semibold">
                <button
                  type="button"
                  aria-expanded
                  aria-label={`Hide ${g.label} stages`}
                  title="Collapse this group"
                  onClick={() => onToggleGroup(g.key)}
                  className="inline-flex items-center gap-1.5 rounded-md px-1 hover:bg-surface"
                >
                  <span aria-hidden>▾</span>
                  {g.label}
                </button>
                <span
                  className="rounded-full bg-surface px-1.5 text-xs font-medium text-muted"
                  title={`${count} merchants in ${g.label}`}
                >
                  {count}
                </span>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 items-stretch gap-3 pt-2">
              {shown.map((s) => (
                <StageColumn
                  key={s.key}
                  stage={s.key}
                  cards={byStage[s.key]}
                  compact={hideEmpty && dragging && byStage[s.key].length === 0}
                  {...shared}
                />
              ))}
            </div>
          </section>
        );
      })}
    </Scroller>
  );
}

export function FollowUpView({
  byBucket,
  dragging,
  ...shared
}: Shared & { byBucket: Record<BucketKey, ClientCard[]>; dragging: boolean }) {
  return (
    <Scroller label="Follow-up board, one column per time" dragging={dragging}>
      {BUCKET_ORDER.map((b) => (
        <BucketColumn key={b} bucket={b} cards={byBucket[b]} {...shared} />
      ))}
    </Scroller>
  );
}
