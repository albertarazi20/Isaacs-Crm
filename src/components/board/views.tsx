"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { BUCKET_ORDER, type BucketKey, type ISODate } from "@/lib/mca/dates";
import type { StageKey } from "@/lib/mca/stages";
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
        !dragging && "snap-x snap-proximity md:snap-none",
      )}
    >
      <BoardScrollContext.Provider value={el}>{children}</BoardScrollContext.Provider>
    </div>
  );
}

/** One stage at a time, picked from the dropdown in the toolbar. A merchant moves to any stage from its card. */
export function PipelineView({
  byStage,
  stage,
  dragging,
  ...shared
}: Shared & {
  byStage: Record<StageKey, ClientCard[]>;
  stage: StageKey;
  dragging: boolean;
}) {
  return (
    <Scroller label="Pipeline, one stage" dragging={dragging}>
      <StageColumn stage={stage} cards={byStage[stage]} compact={false} wide {...shared} />
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
