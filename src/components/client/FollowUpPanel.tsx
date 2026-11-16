"use client";

import { useState } from "react";
import { cancelCallAction, scheduleCallAction, setFollowUpAction } from "@/app/actions";
import type { ClientDetail } from "@/lib/data/types";
import type { MerchantApplication } from "@/lib/leads/application";
import { callbackAt, callbackLabel, CALLBACK_HOURS, slotAt } from "@/lib/mca/callback";
import {
  CHANNEL_LABEL,
  REMINDER_CHANNELS,
  reminderText,
  type ReminderChannel,
} from "@/lib/mca/reminder";
import type { ISODate } from "@/lib/mca/dates";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatDate, formatDateTime, relativeDay } from "@/lib/format";
import { useApp } from "../app-context";
import { TimeSelect } from "../TimeSelect";
import { TimerPicker } from "../TimerPicker";
import { Badge, Button, cn, Field, Input } from "../ui";
import { AddToCalendar } from "../winback/AddToCalendar";
import { dateInTz, dueTone } from "./logic";
import { ReminderTag } from "@/components/ReminderTag";
import { Muted, Panel, useRun } from "./parts";

export function FollowUpPanel({
  detail,
  application,
  className,
}: {
  detail: ClientDetail;
  /** Whether the merchant has signed their application (S1: the application page, 0530). */
  application?: MerchantApplication | null;
  className?: string;
}) {
  const { card, timers } = detail;
  const { today, timezone } = useApp();
  const signed = application?.latest ?? null;
  return (
    <Panel title="Next follow-up" className={className}>
      {application ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Application</p>
            <p className="text-xs text-muted wrap-anywhere">
              {signed
                ? `Signed ${formatDate(dateInTz(signed.signed_at, timezone), today)} by ${signed.signer_name}`
                : "Waiting on the merchant — send the link from the Application card"}
            </p>
          </div>
          <Badge tone={signed ? "good" : "neutral"}>
            {signed ? "Application signed" : "Not signed yet"}
          </Badge>
        </div>
      ) : null}
      {timers.length === 0 ? (
        <p className="rounded-lg border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
          No follow-up date is set. Pick one below so this client doesn&apos;t go quiet.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {timers.map((t) => {
            const tone = dueTone(t.due_on, today);
            return (
              <li
                key={t.id}
                className={cn(
                  "flex items-start justify-between gap-3 px-3 py-2",
                  tone === "overdue" ? "bg-bad-soft" : "bg-surface-2",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{TIMER_LABELS[t.kind]}</p>
                  {t.note ? <p className="text-xs text-muted">{t.note}</p> : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular-nums">{formatDate(t.due_on, today)}</p>
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
        current={timers.find((t) => t.kind === "follow_up")?.due_on ?? null}
      />
      <hr className="my-4 border-border" />
      <ScheduleCall clientId={card.id} />
      {card.scheduled_call_at ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <ReminderTag
            text={reminderText(card.scheduled_call_at, card.reminder_channel, timezone, today)}
          />
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

/**
 * Starts with nothing picked, on purpose: a tap on "Set follow-up" must never move him a week he did
 * not choose (I-18). After a save the date he picked stays lit — it is now the current follow-up — and
 * the button rests until he picks a different one.
 */
function SetFollowUp({
  clientId,
  today,
  current,
}: {
  clientId: string;
  today: ISODate;
  /** The date of the follow-up already set, if any. */
  current: ISODate | null;
}) {
  const run = useRun();
  const [dueOn, setDueOn] = useState<ISODate | "">("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const nothingToChange = dueOn === "" || (dueOn === current && time === "");

  async function save() {
    if (!dueOn) return;
    setBusy(true);
    const ok =
      dueOn === current ||
      (await run(
        setFollowUpAction({ clientId, dueOn }),
        `Follow-up set for ${formatDate(dueOn, today)}`,
      ));
    // A time of day books the reminder too, so the card shows it and the app nudges at that time.
    if (ok && time) {
      await run(
        scheduleCallAction({
          clientId,
          at: slotAt(dueOn, time),
          note: "Follow up",
          channel: "call",
        }),
        "Reminder set",
      );
      setTime("");
    }
    setBusy(false);
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-[12px] font-medium text-text-2">Change the follow-up date</p>
      <TimerPicker
        value={dueOn}
        onChange={(d) => {
          setDueOn(d);
          setTime("");
        }}
        today={today}
      />
      {dueOn ? (
        <TimeSelect value={time} onChange={setTime} date={dueOn} none="No set time" />
      ) : null}
      <Button
        variant="secondary"
        disabled={busy || nothingToChange}
        title={
          dueOn === ""
            ? "Pick a time or a date first"
            : dueOn === current
              ? "That is already the follow-up date"
              : undefined
        }
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Set follow-up"}
      </Button>
      <Muted>
        This replaces the current follow-up. A booked call stays until you log it or cancel it.
      </Muted>
    </div>
  );
}

function ScheduleCall({ clientId }: { clientId: string }) {
  const { timezone, today } = useApp();
  const run = useRun();
  const [channel, setChannel] = useState<ReminderChannel>("call");
  const [date, setDate] = useState<ISODate>(today);
  const [time, setTime] = useState("");
  const at = time ? slotAt(date, time) : "";
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function book() {
    if (!at) return;
    setBusy(true);
    const ok = await run(
      scheduleCallAction({ clientId, at, note, channel }),
      `${CHANNEL_LABEL[channel]} reminder set`,
    );
    setBusy(false);
    if (ok) {
      setTime("");
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
      <p className="text-[12px] font-medium text-text-2">Set a reminder</p>
      <div
        className="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
        role="group"
        aria-label="Remind me to"
      >
        {REMINDER_CHANNELS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === channel}
            onClick={() => setChannel(c)}
            className={cn(
              "h-10 rounded-md px-3 text-[13px] font-medium transition sm:h-7",
              c === channel ? "bg-text text-bg" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Remind me in">
        {CALLBACK_HOURS.map((h) => (
          <Button
            key={h}
            size="sm"
            className="rounded-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await run(
                scheduleCallAction({
                  clientId,
                  at: callbackAt(timezone, h, Date.now()),
                  note: note || `${CHANNEL_LABEL[channel]} back`,
                  channel,
                }),
                `${CHANNEL_LABEL[channel]} reminder in ${callbackLabel(h)}`,
              );
              setBusy(false);
            }}
          >
            In {callbackLabel(h)}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Day (${timezone.replace("_", " ")})`}>
          <Input
            type="date"
            value={date}
            min={today}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              setTime("");
            }}
            required
          />
        </Field>
        <Field label="Time of day">
          <TimeSelect value={time} onChange={setTime} date={date} />
        </Field>
      </div>
      <Field label="What it's about">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Review offers, get statements…"
        />
      </Field>
      <Button type="submit" disabled={busy || !at}>
        {busy ? "Booking…" : `Set ${CHANNEL_LABEL[channel].toLowerCase()} reminder`}
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
