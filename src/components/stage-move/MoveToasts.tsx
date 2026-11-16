"use client";

import type { ClientCard } from "@/lib/data/types";
import { formatDate } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { Icon } from "../client/icons";

export interface RecentMove {
  key: number;
  /** The card as it was before the move — Undo puts it back. */
  from: ClientCard;
  /** The card the server returned. */
  card: ClientCard;
  canUndo: boolean;
}

const ACTION =
  "rounded-md px-2 py-1 font-semibold text-accent underline-offset-2 hover:bg-accent-soft hover:underline";

/**
 * The toast API holds one action button, and a move needs two (Change, Undo), so moves get their
 * own small stack above the shared toasts.
 */
export function MoveToasts({
  items,
  today,
  onChange,
  onUndo,
  onDismiss,
}: {
  items: readonly RecentMove[];
  today: ISODate;
  onChange: (r: RecentMove) => void;
  onUndo: (r: RecentMove) => void;
  onDismiss: (key: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4"
    >
      {items.map((r) => (
        <div
          key={r.key}
          className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-surface px-4 py-2 text-sm shadow-pop"
        >
          <span>
            <strong className="font-semibold">{r.card.business_name}</strong> →{" "}
            {stageDef(r.card.stage).label}
            {r.card.next_due_on ? ` · follow up ${formatDate(r.card.next_due_on, today)}` : ""}
          </span>
          <span className="flex items-center gap-1">
            <button type="button" className={ACTION} onClick={() => onChange(r)}>
              Change
            </button>
            {r.canUndo ? (
              <button type="button" className={ACTION} onClick={() => onUndo(r)}>
                Undo
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted transition hover:bg-surface-2 hover:text-text"
              onClick={() => onDismiss(r.key)}
            >
              <Icon name="x" />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
