"use client";

import { useMemo, useState } from "react";
import type { ISODate } from "@/lib/mca/dates";
import { noteHints } from "@/lib/mca/notehints";
import type { StageKey } from "@/lib/mca/stages";
import { ICON, Icon } from "../settings/primitives";
import { Badge, cn } from "../ui";

/**
 * Follow-up dates read out of a note, as one-tap chips. They are suggestions only: nothing changes until a
 * chip is tapped. `selected` is the date already chosen (shows a check); `alreadySet` marks a date that is
 * the current follow-up.
 */
export function HintChips({
  note,
  today,
  stage,
  selected,
  alreadySet,
  busy = false,
  onPick,
  heading = "Set the follow-up to",
}: {
  note: string;
  today: ISODate;
  stage?: StageKey;
  selected?: ISODate | null;
  alreadySet?: ISODate | null;
  busy?: boolean;
  onPick: (dueOn: ISODate) => void | Promise<void>;
  heading?: string;
}) {
  const hints = useMemo(() => noteHints(note, today, { stage }), [note, today, stage]);
  const [focus, setFocus] = useState(0);
  if (!hints.hot && hints.suggestions.length === 0) return null;
  const shown = hints.suggestions[Math.min(focus, hints.suggestions.length - 1)];

  return (
    <div className="space-y-1.5" role="group" aria-label="Suggested follow-up dates">
      <div className="flex flex-wrap items-center gap-1.5">
        {hints.hot ? (
          <Badge tone="warn">
            <Icon d={ICON.flame} className="size-3.5" />
            Sounds hot
          </Badge>
        ) : null}
        {hints.suggestions.length > 0 ? (
          <span className="text-xs text-muted">{heading}</span>
        ) : null}
        {hints.suggestions.map((s, i) => {
          const picked = s.dueOn === selected || s.dueOn === alreadySet;
          return (
            <button
              key={s.dueOn}
              type="button"
              title={s.reason}
              disabled={busy}
              aria-pressed={picked}
              onMouseEnter={() => setFocus(i)}
              onFocus={() => setFocus(i)}
              onClick={() => {
                setFocus(i);
                void onPick(s.dueOn);
              }}
              className={cn(
                "inline-flex h-9 items-center gap-1 rounded-full border px-3 text-[13px] font-medium transition disabled:opacity-60 sm:h-8",
                picked
                  ? "border-good/40 bg-good-soft text-good"
                  : "border-accent/30 bg-accent-soft text-accent hover:border-accent/60",
              )}
            >
              {s.label}
              {picked ? <Icon d={ICON.check} className="size-3.5" /> : null}
            </button>
          );
        })}
      </div>
      {shown ? <p className="text-xs text-muted">{shown.reason}</p> : null}
    </div>
  );
}
