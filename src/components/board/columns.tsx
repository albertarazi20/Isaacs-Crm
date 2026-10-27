"use client";

import { useDroppable } from "@dnd-kit/core";
import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { bucketLabel, type BucketKey, type ISODate } from "@/lib/mca/dates";
import { stageDef, type StageKey } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { FollowUpCard, PipelineCard } from "./cards";
import { LazyColumnBody, LazySlot } from "./LazySlot";
import { bucketDueDate, isDropBucket, sameCards, STAGE_MONEY_LABEL, summarize } from "./logic";

const WIDTH = "w-[17rem] max-sm:w-[82vw] max-sm:max-w-80";

interface ListProps {
  cards: readonly ClientCard[];
  today: ISODate;
  timezone: string;
  onOpenPicker: (card: ClientCard) => void;
}

const sameList = (a: ListProps, b: ListProps) =>
  a.today === b.today &&
  a.timezone === b.timezone &&
  a.onOpenPicker === b.onOpenPicker &&
  sameCards(a.cards, b.cards);

const EAGER = 6;

/** Memoised so a column re-rendering for a hover highlight does not touch its cards. */
const PipelineList = memo(function PipelineList({ cards, ...rest }: ListProps) {
  return cards.map((c, i) => (
    <LazySlot
      key={c.id}
      id={c.id}
      eager={i < EAGER}
      label={`${c.business_name}, ${stageDef(c.stage).label}`}
    >
      <PipelineCard card={c} {...rest} />
    </LazySlot>
  ));
}, sameList);

const FollowUpList = memo(
  function FollowUpList({ cards, label, ...rest }: ListProps & { label: string }) {
    return cards.map((c, i) => (
      <LazySlot key={c.id} id={c.id} eager={i < EAGER} label={`${c.business_name}, ${label}`}>
        <FollowUpCard card={c} bucketLabel={label} {...rest} />
      </LazySlot>
    ));
  },
  (a, b) => a.label === b.label && sameList(a, b),
);

function DropHint({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-24 place-items-center rounded-lg border-2 border-dashed border-border p-3 text-center text-xs text-muted">
      {children}
    </div>
  );
}

function ColumnShell({
  setNodeRef,
  label,
  describedBy,
  className,
  children,
}: {
  setNodeRef: (n: HTMLElement | null) => void;
  label: string;
  describedBy: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        "flex h-full shrink-0 snap-start flex-col rounded-lg border bg-surface-2/60 transition-colors",
        className,
      )}
    >
      {children}
    </section>
  );
}

interface StageColumnProps extends ListProps {
  stage: StageKey;
  /** A hidden-empty stage shown narrow during a drag, so it can still be dropped on. */
  compact: boolean;
  /** The one stage picked in the dropdown fills the screen instead of sitting in a fixed-width column. */
  wide?: boolean;
}

export const StageColumn = memo(
  function StageColumn({ stage, cards, compact, wide, ...rest }: StageColumnProps) {
    const def = stageDef(stage);
    const { setNodeRef, isOver } = useDroppable({
      id: `stage:${stage}`,
      data: { label: def.label },
    });
    const sum = useMemo(() => summarize(cards, def.group), [cards, def.group]);
    const hintId = `hint-${stage}`;
    return (
      <ColumnShell
        setNodeRef={setNodeRef}
        label={`${def.label}, ${cards.length} ${cards.length === 1 ? "merchant" : "merchants"}`}
        describedBy={hintId}
        className={cn(
          compact ? "w-28" : wide ? "w-full max-w-3xl" : WIDTH,
          isOver ? "border-accent bg-accent-soft ring-2 ring-accent" : "border-border",
        )}
      >
        <header className="px-2.5 pt-2 pb-1" title={def.hint}>
          <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold">
            <span className={compact ? "" : "truncate"}>{def.label}</span>
            <span className="rounded-full bg-surface px-1.5 text-xs font-medium text-muted">
              {cards.length}
            </span>
          </h3>
          <p className="flex justify-between gap-2 text-[11px] leading-tight text-muted">
            <span id={hintId} className={compact ? "sr-only" : "truncate"}>
              {def.hint}
            </span>
            {sum.cents > 0 && !compact ? (
              <span className="shrink-0 font-medium" title={`${STAGE_MONEY_LABEL[sum.kind]}`}>
                {formatMoneyCompact(sum.cents)} {sum.kind === "advanced" ? "advanced" : "wanted"}
              </span>
            ) : null}
          </p>
        </header>
        <LazyColumnBody>
          {cards.length > 0 ? (
            <PipelineList cards={cards} {...rest} />
          ) : (
            <DropHint>{compact ? "Drop here" : def.hint}</DropHint>
          )}
        </LazyColumnBody>
      </ColumnShell>
    );
  },
  (a, b) => a.stage === b.stage && a.compact === b.compact && a.wide === b.wide && sameList(a, b),
);

interface BucketColumnProps extends ListProps {
  bucket: BucketKey;
}

const DISABLED_WHY: Partial<Record<BucketKey, string>> = {
  overdue: "Already past due, so you can't drop here. Drag a card out to a new date.",
  later: "Past the 36-month limit, so you can't drop here.",
};

export const BucketColumn = memo(
  function BucketColumn({ bucket, cards, ...rest }: BucketColumnProps) {
    const label = bucketLabel(bucket);
    const drop = isDropBucket(bucket);
    const { setNodeRef, isOver } = useDroppable({
      id: `bucket:${bucket}`,
      disabled: !drop,
      data: { label: bucket === "today" ? "Today" : `follow up in ${label}` },
    });
    const why = DISABLED_WHY[bucket];
    const hintId = `hint-${bucket}`;
    const hint = drop
      ? `Drop to follow up ${bucket === "today" ? "today" : formatDate(bucketDueDate(bucket, rest.today), rest.today)}`
      : (why ?? "");
    return (
      <ColumnShell
        setNodeRef={setNodeRef}
        label={`${label}${drop ? "" : " (not a place to drop)"}, ${cards.length} ${cards.length === 1 ? "merchant" : "merchants"}`}
        describedBy={hintId}
        className={cn(
          WIDTH,
          drop
            ? isOver
              ? "border-accent bg-accent-soft ring-2 ring-accent"
              : "border-border"
            : "border-dashed border-border opacity-80",
        )}
      >
        <header className="px-2.5 pt-2 pb-1" title={why}>
          <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold">
            <span className="truncate">{label}</span>
            <span
              className={cn(
                "rounded-full px-1.5 text-xs font-medium",
                bucket === "overdue" && cards.length > 0
                  ? "bg-bad-soft text-bad"
                  : "bg-surface text-muted",
              )}
            >
              {cards.length}
            </span>
          </h3>
          <p id={hintId} className="truncate text-[11px] leading-tight text-muted">
            {drop
              ? hint
              : `Can't drop here — ${bucket === "overdue" ? "reschedule instead" : "over 36 months"}`}
          </p>
        </header>
        <LazyColumnBody>
          {cards.length > 0 ? (
            <FollowUpList cards={cards} label={label} {...rest} />
          ) : (
            <DropHint>{drop ? hint : "Nothing here"}</DropHint>
          )}
        </LazyColumnBody>
      </ColumnShell>
    );
  },
  (a, b) => a.bucket === b.bucket && sameList(a, b),
);
