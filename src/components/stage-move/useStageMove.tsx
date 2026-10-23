"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { moveClientAction, setFollowUpAction } from "@/app/actions";
import { useApp } from "@/components/app-context";
import { useCall } from "@/components/overlay";
import type { ClientCard } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import { stageDef, type StageKey } from "@/lib/mca/stages";
import {
  ChangeFollowUpDialog,
  CompetitorDialog,
  DefaultDialog,
  FundingDialog,
  type Submit,
} from "./dialogs";
import { isDefaultStage, needsInput, undoInput } from "./forms";
import { MoveToasts, type RecentMove } from "./MoveToasts";

/**
 * CONTRACT shared by the Board and the Client page.
 *
 * Moving a client between stages is ONE flow wherever it starts: instant for most stages, a short
 * dialog when the move needs data (funded → advance terms, lost → competitor, default stages →
 * default date and promise-to-pay), then a toast showing the new follow-up date with Change / Undo.
 */
export interface StageMove {
  /** Resolves with the updated card, or null if the user cancelled or it failed (error already toasted). */
  requestMove(card: ClientCard, stage: StageKey): Promise<ClientCard | null>;
  /** Render this once next to the component that calls requestMove — it holds the dialogs. */
  dialogs: ReactNode;
}

/** True when the move cannot happen instantly (a dialog opens first). Callers skip optimistic UI for these. */
export function stageNeedsInput(card: ClientCard, stage: StageKey): boolean {
  return needsInput(card, stage);
}

type Settle = (card: ClientCard | null) => void;
interface Ask {
  card: ClientCard;
  stage: StageKey;
  settle: Settle;
}

const TOAST_MS = 10_000;

export function useStageMove(): StageMove {
  const { today, timezone } = useApp();
  const call = useCall();
  const [ask, setAsk] = useState<Ask | null>(null);
  const askRef = useRef<Ask | null>(null);
  const [recent, setRecent] = useState<RecentMove[]>([]);
  const [changing, setChanging] = useState<ClientCard | null>(null);
  const nextKey = useRef(1);
  const timeouts = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timeouts.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const dismiss = useCallback((key: number) => {
    setRecent((cur) => cur.filter((r) => r.key !== key));
  }, []);

  const perform = useCallback(
    async (
      card: ClientCard,
      stage: StageKey,
      extra: Record<string, unknown>,
    ): Promise<ClientCard | null> => {
      const updated = await call(moveClientAction({ clientId: card.id, stage, ...extra }));
      if (!updated) return null;
      const key = nextKey.current++;
      const undo = undoInput(card, stage, "funding" in extra || "competitor" in extra, {
        today,
        timezone,
      });
      setRecent((cur) => [
        ...cur.slice(-2),
        { key, from: card, card: updated, canUndo: undo !== null },
      ]);
      timeouts.current.add(setTimeout(() => dismiss(key), TOAST_MS));
      return updated;
    },
    [call, dismiss, today, timezone],
  );

  const requestMove = useCallback(
    (card: ClientCard, stage: StageKey): Promise<ClientCard | null> => {
      if (!stageNeedsInput(card, stage)) {
        if (card.stage === stage) return Promise.resolve(card);
        return perform(card, stage, {});
      }
      return new Promise<ClientCard | null>((resolve) => {
        askRef.current?.settle(null);
        const next: Ask = { card, stage, settle: resolve };
        askRef.current = next;
        setAsk(next);
      });
    },
    [perform],
  );

  const close = useCallback((result: ClientCard | null) => {
    askRef.current?.settle(result);
    askRef.current = null;
    setAsk(null);
  }, []);

  const submit: Submit = async (extra) => {
    if (!ask) return false;
    const updated = await perform(ask.card, ask.stage, extra);
    if (updated) close(updated);
    return updated !== null;
  };

  const undo = useCallback(
    async (r: RecentMove) => {
      dismiss(r.key);
      const input = undoInput(r.from, r.card.stage, false, { today, timezone });
      if (!input) return;
      await call(
        moveClientAction(input),
        `Undone — ${r.from.business_name} is back in ${stageDef(r.from.stage).label}`,
      );
    },
    [call, dismiss, today, timezone],
  );

  const saveFollowUp = async (dueOn: string): Promise<boolean> => {
    if (!changing) return false;
    const done = await call(
      setFollowUpAction({ clientId: changing.id, dueOn }),
      `${changing.business_name} → follow up ${formatDate(dueOn, today)}`,
    );
    if (done) {
      setRecent((cur) => cur.filter((r) => r.card.id !== changing.id));
      setChanging(null);
    }
    return done !== null;
  };

  const dialogs = (
    <>
      {ask?.stage === "funded" ? (
        <FundingDialog
          key="funded"
          card={ask.card}
          onSubmit={submit}
          onCancel={() => close(null)}
        />
      ) : null}
      {ask?.stage === "lost" ? (
        <CompetitorDialog
          key="lost"
          card={ask.card}
          onSubmit={submit}
          onCancel={() => close(null)}
        />
      ) : null}
      {ask && isDefaultStage(ask.stage) ? (
        <DefaultDialog
          key="default"
          card={ask.card}
          stage={ask.stage}
          onSubmit={submit}
          onCancel={() => close(null)}
        />
      ) : null}
      {changing ? (
        <ChangeFollowUpDialog
          card={changing}
          onSave={saveFollowUp}
          onCancel={() => setChanging(null)}
        />
      ) : null}
      <MoveToasts
        items={recent}
        today={today}
        onChange={(r) => {
          dismiss(r.key);
          setChanging(r.card);
        }}
        onUndo={(r) => void undo(r)}
        onDismiss={dismiss}
      />
    </>
  );

  return { requestMove, dialogs };
}
