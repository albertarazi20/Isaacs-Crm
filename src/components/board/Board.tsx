"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { moveToBucketAction, setFollowUpAction } from "@/app/actions";
import { useApp } from "@/components/app-context";
import { useCall, useToast } from "@/components/overlay";
import { stageNeedsInput, useStageMove } from "@/components/stage-move/useStageMove";
import { cn, EmptyState, Input, Select } from "@/components/ui";
import type { ClientCard } from "@/lib/data/types";
import { BUCKET_ORDER } from "@/lib/mca/dates";
import { formatDate } from "@/lib/format";
import {
  CORE_STAGES,
  foldStage,
  isStageKey,
  stageDef,
  TIMER_LABELS,
  type StageKey,
} from "@/lib/mca/stages";
import { DragFace } from "./cards";
import {
  collision,
  columnCoordinates,
  makeAnnouncements,
  makeInstructions,
  MouseAndPenSensor,
} from "./dnd";
import {
  bucketDueDate,
  bucketOf,
  filterCards,
  groupByBucket,
  groupByStage,
  isDropBucket,
  mergeServerCards,
  optimisticDue,
  optimisticMove,
  replaceCard,
  revertCard,
  type BoardView,
  type DropBucket,
} from "./logic";
import { setDraggingId } from "./LazySlot";
import { FollowUpSheet, StageSheet } from "./Sheets";
import { rememberView, useStoredStage } from "./storage";
import { FollowUpView, PipelineView } from "./views";

const A11Y = {
  pipeline: {
    announcements: makeAnnouncements("stage"),
    screenReaderInstructions: makeInstructions("stage"),
  },
  followups: {
    announcements: makeAnnouncements("follow-up time"),
    screenReaderInstructions: makeInstructions("follow-up time"),
  },
} as const;

const AUTO_SCROLL = { threshold: { x: 0.15, y: 0.12 }, acceleration: 7 } as const;

function ViewLink({
  view,
  current,
  children,
}: {
  view: BoardView;
  current: BoardView;
  children: string;
}) {
  const active = view === current;
  return (
    <Link
      href={`/board?view=${view}`}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
      )}
    >
      {children}
    </Link>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: string;
}) {
  return (
    <label className="order-4 inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm select-none has-checked:border-accent has-checked:bg-accent-soft sm:h-10">
      <input
        type="checkbox"
        className="size-4 accent-(--accent)"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

export function Board({ initialCards, view }: { initialCards: ClientCard[]; view: BoardView }) {
  const { today, timezone } = useApp();
  const call = useCall();
  const toast = useToast();
  const { requestMove, dialogs } = useStageMove();

  // Local copy so a drop lands instantly. Fresh server rows replace it, except cards mid-request.
  const [serverCards, setServerCards] = useState(initialCards);
  const [cards, setCards] = useState(initialCards);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  if (serverCards !== initialCards) {
    setServerCards(initialCards);
    setCards(mergeServerCards(cards, initialCards, inFlight));
  }

  const [query, setQuery] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [picked, setPicked] = useStoredStage();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picker, setPicker] = useState<ClientCard | null>(null);

  // The nav link is a bare /board: remember the view so it opens where he left off (I-9).
  useEffect(() => rememberView(view), [view]);

  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(
    () => filterCards(cards, { query: deferredQuery, overdueOnly }, today),
    [cards, deferredQuery, overdueOnly, today],
  );
  const byStage = useMemo(
    () => (view === "pipeline" ? groupByStage(visible) : null),
    [view, visible],
  );
  const byBucket = useMemo(
    () => (view === "followups" ? groupByBucket(visible, today) : null),
    [view, visible, today],
  );
  // Opens on the picked stage, or on the first stage with someone in it.
  const stage: StageKey =
    byStage && picked && CORE_STAGES.some((s) => s.key === picked)
      ? picked
      : (CORE_STAGES.find((s) => byStage?.[s.key].length)?.key ?? "name_in");
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const activeCard = activeId ? (byId.get(activeId) ?? null) : null;

  const track = useCallback((id: string, on: boolean) => {
    setInFlight((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const moveCard = useCallback(
    async (card: ClientCard, stage: StageKey) => {
      const needsDialog = stageNeedsInput(card, stage);
      if (card.stage === stage && !needsDialog) return;
      if (needsDialog) {
        // A dialog comes first, so nothing moves until the details are saved.
        const done = await requestMove(card, stage);
        if (done) setCards((cur) => replaceCard(cur, done));
        return;
      }
      const guess = optimisticMove(card, stage, today);
      setCards((cur) => replaceCard(cur, guess));
      track(card.id, true);
      const done = await requestMove(card, stage);
      track(card.id, false);
      setCards((cur) => (done ? replaceCard(cur, done) : revertCard(cur, card, guess)));
    },
    [requestMove, today, track],
  );

  const followUp = useCallback(
    async (card: ClientCard, bucket: DropBucket) => {
      const dueOn = bucketDueDate(bucket, today);
      const guess = optimisticDue(card, dueOn);
      setCards((cur) => replaceCard(cur, guess));
      track(card.id, true);
      const done = await call(moveToBucketAction({ clientId: card.id, bucket }));
      track(card.id, false);
      setCards((cur) => (done ? replaceCard(cur, done) : revertCard(cur, card, guess)));
      if (!done) return;
      // A drag only moves the follow-up. A booked call, funded check-in or renewal call keeps its own date, and the
      // toast says so (the old date comes back with Undo, which a mis-drop needs).
      const kept =
        done.next_due_on !== null && done.next_due_on < dueOn && done.next_due_kind !== "follow_up"
          ? ` (${TIMER_LABELS[done.next_due_kind ?? "follow_up"].toLowerCase()} stays ${formatDate(done.next_due_on, today)})`
          : "";
      const back = card.next_due_on === null || card.next_due_on < today ? today : card.next_due_on;
      toast({
        tone: "success",
        message: `${card.business_name} → follow up ${formatDate(dueOn, today)}${kept}`,
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              const undone = await call(
                setFollowUpAction({ clientId: card.id, dueOn: back, keepCalls: true }),
              );
              if (undone) {
                setCards((cur) => replaceCard(cur, undone));
                toast({
                  tone: "success",
                  message: `Undone — ${card.business_name} follow up is back to ${formatDate(back, today)}`,
                });
              }
            })();
          },
        },
      });
    },
    [call, toast, today, track],
  );

  const sensors = useSensors(
    useSensor(MouseAndPenSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setDraggingId(String(e.active.id));
  };
  const endDrag = () => {
    setActiveId(null);
    setDraggingId(null);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    endDrag();
    const card = byId.get(String(active.id));
    if (!card || !over) return;
    const [kind, key = ""] = String(over.id).split(":");
    // Dropping a card back on its own column is never a move.
    if (kind === "stage" && isStageKey(key) && key !== foldStage(card.stage))
      void moveCard(card, key);
    if (kind === "bucket") {
      const bucket = BUCKET_ORDER.find((b) => b === key);
      if (bucket && isDropBucket(bucket) && bucketOf(card, today) !== bucket)
        void followUp(card, bucket);
    }
  };

  const openPicker = useCallback((card: ClientCard) => setPicker(card), []);
  const shared = { today, timezone, onOpenPicker: openPicker };

  const total = cards.length;
  const filtering = query.trim() !== "" || overdueOnly;
  const count = filtering
    ? `${visible.length} of ${total} merchants`
    : `${total} ${total === 1 ? "merchant" : "merchants"}`;

  return (
    <div className="flex h-[calc(100dvh-6.75rem)] min-h-[30rem] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Board view" className="order-1 inline-flex rounded-lg bg-surface-2 p-0.5">
          <ViewLink view="pipeline" current={view}>
            Pipeline
          </ViewLink>
          <ViewLink view="followups" current={view}>
            Follow-ups
          </ViewLink>
        </nav>
        <Input
          type="search"
          aria-label="Search merchants"
          placeholder="Search business, merchant, DBA or phone"
          className="order-3 w-full sm:w-80"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {view === "pipeline" && byStage ? (
          <Select
            aria-label="Stage"
            className="order-4 w-full sm:w-56"
            value={stage}
            onChange={(e) => setPicked(e.target.value as StageKey)}
          >
            {CORE_STAGES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} ({byStage[s.key].length})
              </option>
            ))}
          </Select>
        ) : null}
        <Toggle checked={overdueOnly} onChange={setOverdueOnly}>
          Overdue only
        </Toggle>
        <p className="order-2 ml-auto text-sm text-muted sm:order-5" aria-live="polite">
          {count}
        </p>
      </div>

      {total === 0 ? (
        <EmptyState title="No merchants yet">
          Press “+ Add client” at the top to add your first one. Every merchant gets a follow-up
          date the moment you add them.
        </EmptyState>
      ) : (
        <DndContext
          id="board-dnd"
          sensors={sensors}
          collisionDetection={collision}
          autoScroll={AUTO_SCROLL}
          accessibility={A11Y[view]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          {visible.length === 0 ? (
            <EmptyState title="No merchants match">
              Clear the search or turn off “Overdue only” to see everyone.
            </EmptyState>
          ) : byStage ? (
            <PipelineView
              byStage={byStage}
              stage={stage}
              dragging={activeId !== null}
              {...shared}
            />
          ) : byBucket ? (
            <FollowUpView byBucket={byBucket} dragging={activeId !== null} {...shared} />
          ) : null}
          <DragOverlay dropAnimation={null}>
            {activeCard ? (
              <DragFace
                card={activeCard}
                detail={
                  view === "pipeline"
                    ? `Now in ${stageDef(activeCard.stage).label} — drop on a stage`
                    : "Drop on a follow-up time"
                }
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {picker && view === "pipeline" ? (
        <StageSheet
          card={picker}
          onClose={() => setPicker(null)}
          onPick={(stage) => {
            setPicker(null);
            void moveCard(picker, stage);
          }}
        />
      ) : null}
      {picker && view === "followups" ? (
        <FollowUpSheet
          card={picker}
          onClose={() => setPicker(null)}
          onPick={(bucket) => {
            setPicker(null);
            void followUp(picker, bucket);
          }}
        />
      ) : null}
      {dialogs}
    </div>
  );
}
