"use client";

import { addMonths, dueFromPreset, FOLLOW_UP_PRESETS, type ISODate } from "@/lib/mca/dates";
import { relativeDay } from "@/lib/format";
import { cn, Input } from "./ui";

/**
 * Presets from 1 week to 36 months plus any custom date. The one place Isaac sets a timer.
 * `value` may be "" (nothing picked yet): then no preset looks pressed and no date is shown.
 */
export function TimerPicker({
  value,
  onChange,
  today,
}: {
  value: ISODate | "";
  onChange: (v: ISODate) => void;
  today: ISODate;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Follow-up in">
        {FOLLOW_UP_PRESETS.map((p) => {
          const date = dueFromPreset(p.key, today);
          const selected = value !== "" && value === date;
          return (
            <button
              key={p.key}
              type="button"
              title={p.label}
              aria-pressed={selected}
              onClick={() => onChange(date)}
              className={cn(
                "h-10 min-w-11 rounded-full border px-2.5 text-sm font-medium tabular-nums transition sm:h-8 sm:text-[13px]",
                selected
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-surface text-text-2 hover:border-border-strong hover:bg-surface-3 hover:text-text",
              )}
            >
              {p.key}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Input
          type="date"
          aria-label="Follow-up date"
          className="w-44"
          min={today}
          max={addMonths(today, 36)}
          value={value}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
        {value ? <span className="text-xs text-muted">{relativeDay(value, today)}</span> : null}
      </div>
    </div>
  );
}
