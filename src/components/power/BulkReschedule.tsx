"use client";

import { useMemo, useState } from "react";
import { bulkRescheduleAction } from "@/app/power-actions";
import { BULK_DAY_CHOICES, planBulk, priorityOf } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import { addDays, parseISODate } from "@/lib/mca/dates";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "../app-context";
import { Dialog, useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Button, cn } from "../ui";
import { useHotIds } from "./prefs";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today", "Tomorrow", "Mon Oct 26". */
function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return `${WEEKDAY[parseISODate(date).getUTCDay()]} ${formatDate(date)}`;
}

/** The "Reschedule all…" button in the Overdue header, and its dialog. */
export function BulkReschedule({ overdue }: { overdue: ClientCard[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Glyph name="clock" className="size-3.5 text-muted" />
        Reschedule all
      </Button>
      {open ? <BulkDialog overdue={overdue} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BulkDialog({ overdue, onClose }: { overdue: ClientCard[]; onClose: () => void }) {
  const { today, timezone } = useApp();
  const call = useCall();
  const toast = useToast();
  const hot = useHotIds();
  const [days, setDays] = useState<number>(5);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);

  const ctx = useMemo(() => ({ today, timezone, hotIds: hot }), [today, timezone, hot]);
  const plan = useMemo(
    () => planBulk(overdue, ctx, { days, keepApplicationIn: keep }),
    [overdue, ctx, days, keep],
  );
  const n = plan.ordered.length;
  const lead = plan.ordered.slice(0, 3);
  const peak = Math.max(1, ...plan.perDay.map((d) => d.count));

  async function submit() {
    setBusy(true);
    const res = await call(
      bulkRescheduleAction({
        days,
        keepApplicationIn: keep,
        hotIds: [...hot].slice(0, 1000),
      }),
    );
    setBusy(false);
    if (!res) return;
    const first = res.perDay[0];
    toast({
      message:
        res.moved === 0
          ? "Nothing needed moving"
          : `Rescheduled ${res.moved} merchant${res.moved === 1 ? "" : "s"} over ${res.perDay.length} day${res.perDay.length === 1 ? "" : "s"}` +
            (first
              ? `: ${first.count} ${first.date === today ? "today" : `on ${dayLabel(first.date, today)}`}`
              : ""),
      tone: "success",
    });
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reschedule ${overdue.length} overdue`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || n === 0} onClick={() => void submit()}>
            {busy ? "Rescheduling…" : `Reschedule ${n} merchant${n === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p id="bulk-days-label" className="text-[12px] font-medium text-text-2">
            Spread them over this many business days
          </p>
          <div className="mt-2 flex gap-2" role="group" aria-labelledby="bulk-days-label">
            {BULK_DAY_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                aria-label={`${d} business days`}
                onClick={() => setDays(d)}
                className={cn(
                  "h-10 flex-1 rounded-full border text-sm font-semibold tabular-nums transition duration-150 active:scale-[0.97] sm:h-9",
                  days === d
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-border bg-surface-3 text-text-2 hover:border-border-strong hover:text-text",
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
          />
          <span>
            Keep merchants with the application in overdue. They need a call.
            <span className="block text-xs text-muted">
              Merchants in Application in are left alone ({plan.keptApplicationIn.length} right
              now).
            </span>
          </span>
        </label>

        <div className="rounded-2xl border border-border bg-surface-3/60 p-4" aria-live="polite">
          {n === 0 ? (
            <p className="text-sm">Nothing to move with these settings.</p>
          ) : (
            <>
              <p className="eyebrow">
                {n} client{n === 1 ? "" : "s"}, biggest asks first
              </p>
              <ul className="mt-3 space-y-2 text-[13px]" aria-label="How many land on each day">
                {plan.perDay.map((d) => (
                  <li key={d.date}>
                    <div className="flex justify-between gap-3">
                      <span className="text-text-2">
                        {dayLabel(d.date, today)}
                        {d.date === today ? "" : ` · ${relativeDay(d.date, today)}`}
                      </span>
                      <span className="font-semibold tabular-nums">{d.count}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                      <div
                        className="bg-brand h-full rounded-full"
                        style={{ width: `${Math.round((d.count / peak) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              {lead.length > 0 ? (
                <p className="mt-2 text-xs text-muted">
                  First up:{" "}
                  {lead
                    .map(
                      (c) =>
                        `${c.business_name} (${formatMoneyCompact(priorityOf(c, ctx).atStakeCents)})`,
                    )
                    .join(", ")}
                  .
                </p>
              ) : null}
            </>
          )}
        </div>

        {plan.needHands.length > 0 ? (
          <p className="rounded-xl bg-warn-soft p-3 text-[13px] text-warn">
            {plan.needHands.length} booked call{plan.needHands.length === 1 ? "" : "s"} can&apos;t
            be moved here. They stay overdue until you log or cancel them.
          </p>
        ) : null}
        {plan.overCap > 0 ? (
          <p className="rounded-xl bg-warn-soft p-3 text-[13px] text-warn">
            One go moves at most 200. The other {plan.overCap} stay overdue. Run it again after.
          </p>
        ) : null}
        <p className="text-xs text-muted">
          Each merchant gets a new follow-up date and the note “Rescheduled in bulk”. All of them
          move, or none do.
        </p>
      </div>
    </Dialog>
  );
}
