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
import { timerLabel } from "@/lib/mca/stages";
import { formatDate, formatDateTime, relativeDay } from "@/lib/format";
import { useApp } from "../app-context";
import { TimeSelect } from "../TimeSelect";
import { TimerPicker } from "../TimerPicker";
import { Badge, Button, cn, Field, Input } from "../ui";
import { AddToCalendar } from "../messaging/AddToCalendar";
import { dateInTz, dueTone } from "./logic";
import { ReminderTag } from "@/components/ReminderTag";
import { Muted, Panel, useRun } from "./parts";
import { Label } from "./primitives";

const TONE_BOX = {
  overdue: "border-bad/30 bg-bad-soft",
  today: "border-warn/30 bg-warn-soft",
  later: "border-border bg-surface-3/60",
} as const;
const TONE_BADGE = { overdue: "bad", today: "warn", later: "neutral" } as const;

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
  const { card, timers, bringIn } = detail;
  const { today, timezone } = useApp();
  const signed = application?.latest ?? null;
  const [next, ...rest] = timers;
  const nextTone = next ? dueTone(next.due_on, today) : "later";
  return (
    <Panel title="Next follow-up" icon="clock" className={className}>
      {next ? (
        <div className={cn("rounded-2xl border p-4", TONE_BOX[nextTone])}>
          <div className="flex items-start justify-between gap-3">
            <p className="eyebrow">Next step</p>
            <Badge tone={TONE_BADGE[nextTone]}>{relativeDay(next.due_on, today)}</Badge>
          </div>
          <p className="mt-1 text-[26px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
            {formatDate(next.due_on, today)}
          </p>
          <p className="mt-1.5 text-[13px] text-text-2">
            <span className="font-medium text-text">{timerLabel(next.kind)}</span>
            {next.note ? <span> · {next.note}</span> : null}
          </p>
        </div>
      ) : bringIn.brought_in_at ? (
        <p className="rounded-2xl border border-good/30 bg-good-soft p-4 text-sm text-good">
          Handed off. No follow-up is needed unless you undo it.
        </p>
      ) : (
        <p className="rounded-2xl border border-warn/30 bg-warn-soft p-4 text-sm text-warn">
          No follow-up date is set. Pick one below so this merchant doesn&apos;t go quiet.
        </p>
      )}
      {application ? (
        <div className="mt-2.5 flex items-center justify-between gap-3 px-1">
          <p className="min-w-0 truncate text-xs text-muted">
            {signed
              ? `${formatDate(dateInTz(signed.signed_at, timezone), today)} by ${signed.signer_name}`
              : "Application: waiting on the merchant"}
          </p>
          <Badge tone={signed ? "good" : "neutral"}>
            {signed ? "Application signed" : "Not signed yet"}
          </Badge>
        </div>
      ) : null}
      {rest.length > 0 ? (
        <ul className="mt-2 divide-y divide-border">
          {rest.map((t) => {
            const tone = dueTone(t.due_on, today);
            return (
              <li key={t.id} className="flex items-start justify-between gap-3 px-1 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{timerLabel(t.kind)}</p>
                  {t.note ? <p className="truncate text-xs text-muted">{t.note}</p> : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-medium tabular-nums">
                    {formatDate(t.due_on, today)}
                  </p>
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
      ) : null}
      {card.scheduled_call_at ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-3/60 px-3 py-2 text-[13px]">
          <ReminderTag
            text={reminderText(card.scheduled_call_at, card.reminder_channel, timezone, today)}
          />
          <span className="font-medium tabular-nums">
            {formatDateTime(card.scheduled_call_at, timezone)}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-1">
            <AddToCalendar
              card={card}
              topic={timers.find((t) => t.kind === "scheduled_call")?.note || undefined}
            />
            <CancelCall clientId={card.id} />
          </span>
        </div>
      ) : null}
      <SetFollowUp
        clientId={card.id}
        today={today}
        current={timers.find((t) => t.kind === "follow_up")?.due_on ?? null}
      />
      <hr className="my-5 border-border" />
      <ScheduleCall clientId={card.id} />
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
    <div className="mt-5 space-y-2.5">
      <Label>Change the date</Label>
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
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void book();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Set a reminder</Label>
        <div
          className="inline-flex gap-0.5 rounded-full border border-border bg-surface-2/70 p-0.5"
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
                "h-10 rounded-full px-3 text-[13px] font-medium transition duration-150 active:scale-[0.97] sm:h-7",
                c === channel
                  ? "bg-surface text-text shadow-card"
                  : "text-muted hover:bg-surface/60 hover:text-text",
              )}
            >
              {CHANNEL_LABEL[c]}
            </button>
          ))}
        </div>
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
        <Field label="Time of day" group>
          <TimeSelect value={time} onChange={setTime} date={date} />
        </Field>
      </div>
      <Field label="What it's about">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Get statements, go over the application…"
        />
      </Field>
      <Button type="submit" disabled={busy || !at} className="w-full">
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
