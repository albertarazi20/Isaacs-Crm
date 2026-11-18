"use client";

import { useEffect, useId, useRef, useState } from "react";
import { clockNow, TIME_SLOTS } from "@/lib/mca/callback";
import { useApp } from "./app-context";
import { Icon } from "./client/icons";
import { listenEscape } from "./overlay";
import { cn } from "./ui";

type Period = "AM" | "PM";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = [0, 30];
const PERIODS: Period[] = ["AM", "PM"];

const slotValue = (hour: number, minute: number, period: Period) =>
  `${String((hour % 12) + (period === "PM" ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const labelOf = (value: string) => TIME_SLOTS.find((s) => s.value === value)?.label ?? "";

function split(value: string): {
  hour: number | null;
  minute: number | null;
  period: Period | null;
} {
  if (!value) return { hour: null, minute: null, period: null };
  const h = Number(value.slice(0, 2));
  return { hour: h % 12 || 12, minute: Number(value.slice(3)), period: h < 12 ? "AM" : "PM" };
}

/**
 * Time of day as three scroll columns (hour, minute, AM/PM), half hours only, in the user's own time
 * zone. On today's date the half hours already gone are greyed out, so a reminder is never booked in
 * the past. Big tap targets: the same picker works with a thumb.
 */
export function TimeSelect({
  value,
  onChange,
  date,
  none,
  label = "Time of day",
  up = false,
}: {
  /** "HH:mm" (24 hour), or "" for none. */
  value: string;
  onChange: (v: string) => void;
  /** The date the time is for, to grey out slots already past today. */
  date: string;
  /** Text shown when nothing is picked. Defaults to "Pick a time". */
  none?: string;
  label?: string;
  /** Open above the field, for one near the bottom of a scrolling dialog. */
  up?: boolean;
}) {
  const { today, timezone, nowMs } = useApp();
  const now = date === today ? clockNow(timezone, nowMs) : "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => split(value));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  // Closes on a click outside or Escape. Escape is kept to this popover, so inside a dialog it does not close the
  // whole sheet and the form with it; focus goes back to the field's button.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    const stopEscape = listenEscape(document, () => {
      setOpen(false);
      trigger.current?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      stopEscape();
    };
  }, [open]);

  const free = (h: number, m: number, p: Period) => slotValue(h, m, p) > now;
  const periodsFor = (p: Period | null) => (p ? [p] : PERIODS);
  const hourOk = (h: number) =>
    periodsFor(draft.period).some((p) => MINUTES.some((m) => free(h, m, p)));
  const minuteOk = (m: number) =>
    draft.hour === null
      ? true
      : periodsFor(draft.period).some((p) => free(draft.hour as number, m, p));
  const periodOk = (p: Period) => HOURS.some((h) => MINUTES.some((m) => free(h, m, p)));

  function pick(next: Partial<typeof draft>) {
    const d = { ...draft, ...next };
    setDraft(d);
    if (d.hour !== null && d.minute !== null && d.period !== null) {
      const v = slotValue(d.hour, d.minute, d.period);
      if (v > now) {
        onChange(v);
        setOpen(false);
        // the button just pressed leaves the page with the popover: keep focus on the field
        trigger.current?.focus();
      }
    }
  }

  const btn = (selected: boolean, disabled: boolean) =>
    cn(
      "h-11 w-full rounded-lg px-3 text-center text-sm font-medium tabular-nums transition sm:h-9",
      selected ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text",
      disabled && "pointer-events-none opacity-30",
    );

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => {
          setDraft(split(value));
          setOpen((o) => !o);
        }}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-sm transition hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none sm:h-9",
          value ? "font-medium text-text" : "text-muted",
        )}
      >
        <span className="truncate">{value ? labelOf(value) : (none ?? "Pick a time")}</span>
        <Icon name="clock" className="text-muted" />
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          // Inside a Field (a <label>) the browser clicks the label's own button again after a click on
          // something that has since left the page. A full pick removes this popover, so without this
          // the picker opened again the moment the time was chosen.
          onClick={(e) => e.preventDefault()}
          className={cn(
            "absolute right-0 z-30 w-56 rounded-xl border border-border bg-surface p-2 shadow-pop",
            up ? "bottom-full mb-1" : "mt-1",
          )}
        >
          <div className="flex gap-1">
            <div
              role="group"
              aria-label="Hour"
              className="max-h-56 flex-1 space-y-1 overflow-y-auto"
            >
              {HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-pressed={draft.hour === h}
                  disabled={!hourOk(h)}
                  onClick={() => pick({ hour: h })}
                  className={btn(draft.hour === h, !hourOk(h))}
                >
                  {h}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Minute" className="flex-1 space-y-1">
              {MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={draft.minute === m}
                  disabled={!minuteOk(m)}
                  onClick={() => pick({ minute: m })}
                  className={btn(draft.minute === m, !minuteOk(m))}
                >
                  {String(m).padStart(2, "0")}
                </button>
              ))}
            </div>
            <div role="group" aria-label="AM or PM" className="flex-1 space-y-1">
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={draft.period === p}
                  disabled={!periodOk(p)}
                  onClick={() => pick({ period: p })}
                  className={btn(draft.period === p, !periodOk(p))}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {value && none !== undefined ? (
            <button
              type="button"
              onClick={() => {
                setDraft(split(""));
                onChange("");
                setOpen(false);
                trigger.current?.focus();
              }}
              className="mt-2 h-10 w-full rounded-lg px-3 text-sm text-muted transition hover:bg-surface-2 hover:text-text sm:h-8"
            >
              {none}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
