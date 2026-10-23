"use client";

import type { ReactNode } from "react";
import { moveClientAction } from "@/app/actions";
import type { ClientCard } from "@/lib/data/types";
import type { StageKey } from "@/lib/mca/stages";
import { useCall, useToast } from "../overlay";

/**
 * CONTRACT shared by the Board and the Client page.
 *
 * Moving a client between stages is ONE flow wherever it starts: instant for most stages, a short
 * dialog when the move needs data (funded → advance terms, lost → competitor, default stages →
 * default date and promise-to-pay), then a toast showing the new follow-up date with Change / Undo.
 *
 * NOTE: this is a minimal placeholder implementation (no dialogs, no undo). The Board builder
 * replaces the body — keep the exported names and signatures exactly.
 */
export interface StageMove {
  /** Resolves with the updated card, or null if the user cancelled or it failed (error already toasted). */
  requestMove(card: ClientCard, stage: StageKey): Promise<ClientCard | null>;
  /** Render this once next to the component that calls requestMove — it holds the dialogs. */
  dialogs: ReactNode;
}

/** True when the move cannot happen instantly (a dialog opens first). Callers skip optimistic UI for these. */
export function stageNeedsInput(card: ClientCard, stage: StageKey): boolean {
  if (stage === "funded" || stage === "lost") return true;
  const isDefaultStage =
    stage === "default_workable" ||
    stage === "default_bad" ||
    stage === "legal_collections" ||
    stage === "written_off";
  return isDefaultStage && card.funding_id !== null;
}

export function useStageMove(): StageMove {
  const call = useCall();
  const toast = useToast();
  return {
    async requestMove(card, stage) {
      if (stageNeedsInput(card, stage)) {
        toast({ message: "This move needs details — not built yet", tone: "error" });
        return null;
      }
      return call(moveClientAction({ clientId: card.id, stage }));
    },
    dialogs: null,
  };
}
