"use client";

import { useState } from "react";
import { cancelCallAction, scheduleCallAction, setFollowUpAction } from "@/app/actions";
import type { ClientDetail } from "@/lib/data/types";
import { addDays, type ISODate } from "@/lib/mca/dates";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatDate, formatDateTime, relativeDay } from "@/lib/format";
import { useApp } from "../app-context";
import { TimerPicker } from "../TimerPicker";
import { Badge, Button, cn, Field, Input } from "../ui";
import { AddToCalendar } from "../winback/AddToCalendar";
import { dueTone } from "./logic";
import { Muted, Panel, useNowMs, useRun } from "./parts";

export function FollowUpPanel({ detail, className }: { detail: ClientDetail; className?: string }) {
  const { card, timers } = detail;
  const { today, timezone } = useApp();
  const nowMs = useNowMs();
  return (
    <Panel title="Next follow-up" className={className}>
      {timers.length === 0 ? (
        <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
          No follow-up date is set. Pick one below so this client doesn&apos;t go quiet.
        </p>
      ) : (
        <ul className="space-y-2">
          {timers.map((t) => {
            const tone = dueTone(t.due_on, today);
            return (
              <li
                key={t.id}
                className={cn(
                  "flex items-start justify-between gap-3 rounded-lg border px-3 py-2",
                  tone === "overdue" ? "border-bad bg-bad-soft" : "border-border bg-surface-2",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{TIMER_LABELS[t.kind]}</p>
                  {t.note ? <p className="text-xs text-muted">{t.note}</p> : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium">{formatDate(t.due_on, today)}</p>
                  <p
                    className={cn(
                      "text-xs",
                      tone === "overdue" ? "font-semibold text-bad" : "text-muted",
                    )}
                  >
                    {relativeDay(t.due_on, today)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SetFollowUp
        clientId={card.id}
        today={today}
        initial={
          card.next_due_on && card.next_due_on > today ? card.next_due_on : addDays(today, 7)
        }
      />
      <hr className="my-4 border-border" />
      <ScheduleCall clientId={card.id} />
      {card.scheduled_call_at ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={new Date(card.scheduled_call_at).getTime() < nowMs ? "warn" : "accent"}>
            Call booked
          </Badge>
          <span className="font-medium">{formatDateTime(card.scheduled_call_at, timezone)}</span>
          <CancelCall clientId={card.id} />
          <AddToCalendar
            card={card}
            topic={timers.find((t) => t.kind === "scheduled_call")?.note || undefined}
          />
        </p>
      ) : null}
    </Panel>
  );
}

function SetFollowUp({
  clientId,
  today,
  initial,
}: {
  clientId: string;
  today: ISODate;
  initial: ISODate;
}) {
  const run = useRun();
  const [dueOn, setDueOn] = useState<ISODate>(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await run(
      setFollowUpAction({ clientId, dueOn }),
      `Follow-up set for ${formatDate(dueOn, today)}`,
    );
    setBusy(false);
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-medium text-muted">Change the follow-up date</p>
      <TimerPicker value={dueOn} onChange={setDueOn} today={today} />
      <Button variant="primary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Set follow-up"}
      </Button>
      <Muted>
        This replaces the current follow-up. A booked call stays until you log it or cancel it.
      </Muted>
    </div>
  );
}

function ScheduleCall({ clientId }: { clientId: string }) {
  const { timezone } = useApp();
  const run = useRun();
  const [at, setAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function book() {
    if (!at) return;
    setBusy(true);
    const ok = await run(scheduleCallAction({ clientId, at, note }), "Call booked");
    setBusy(false);
    if (ok) {
      setAt("");
      setNote("");
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void book();
      }}
    >
      <p className="text-xs font-medium text-muted">Schedule a call</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`When (${timezone.replace("_", " ")})`}>
          <Input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            required
          />
        </Field>
        <Field label="What it's about">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Review offers, get statements…"
          />
        </Field>
      </div>
      <Button type="submit" disabled={busy || !at}>
        {busy ? "Booking…" : "Book the call"}
      </Button>
    </form>
  );
}

function CancelCall({ clientId }: { clientId: string }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await run(cancelCallAction({ clientId }), "Call cancelled");
        setBusy(false);
      }}
    >
      Cancel call
    </Button>
  );
}
