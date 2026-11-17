"use client";

import { useState } from "react";
import { addNoteAction, setFollowUpAction } from "@/app/actions";
import type { ActivityRow, ClientCard } from "@/lib/data/types";
import { formatDate, timeAgo } from "@/lib/format";
import { diffDays, type ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { outcomeLabel } from "@/lib/mca/touch";
import { useApp } from "../app-context";
import { Badge, Button, cn, Kbd, type Tone } from "../ui";
import { HintChips } from "../messaging/HintChips";
import { Icon, type IconName } from "./icons";
import { Chip, inkButtonClass } from "./primitives";
import {
  activityBody,
  countByFilter,
  dateInTz,
  filterActivities,
  fullDateTime,
  lastCallSummary,
  lastTouchOf,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from "./logic";
import { useNowMs, useRun } from "./parts";

const KIND_META: Record<ActivityRow["kind"], { icon: IconName; label: string; tone: Tone }> = {
  note: { icon: "note", label: "Note", tone: "accent" },
  call: { icon: "phone", label: "Call", tone: "good" },
  text: { icon: "message", label: "Text", tone: "info" },
  email: { icon: "mail", label: "Email", tone: "info" },
  stage_change: { icon: "shuffle", label: "Stage change", tone: "accent" },
  timer: { icon: "bell", label: "Follow-up", tone: "warn" },
  system: { icon: "info", label: "Update", tone: "neutral" },
};

const OUTCOME_TONE = {
  reached: "good",
  no_answer: "neutral",
  left_message: "warn",
  bad_number: "bad",
} as const;

/** The dot on the line: a soft disc in the entry's tone, ringed in the panel colour so the line stops at it. */
const DOT: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
};

/** What an entry is, in a colour: a reply and a received document are good news, a bad number is not. */
function look(a: ActivityRow): { icon: IconName; label: string; tone: Tone } {
  const meta = KIND_META[a.kind] ?? KIND_META.system;
  if (a.kind === "call" && a.outcome) return { ...meta, tone: OUTCOME_TONE[a.outcome] };
  if (a.kind === "email" && a.body.startsWith("Merchant replied"))
    return { icon: "reply", label: "Reply", tone: "good" };
  if (a.kind === "system") {
    if (/^(Received|Stip received|Document received)/.test(a.body))
      return { icon: "file", label: "Document", tone: "good" };
    if (a.body.startsWith("Handed off")) return { icon: "flag", label: "Hand-off", tone: "good" };
    if (a.body.startsWith("Hand-off undone"))
      return { icon: "undo", label: "Hand-off", tone: "warn" };
    if (a.body.startsWith("Moved to bucket"))
      return { icon: "layers", label: "Bucket", tone: "info" };
  }
  return meta;
}

const PAGE = 40;

/**
 * The last call and the note box. A separate block from the history so a phone can put it right under
 * the header: he is on the phone with the merchant, the note box is what he needs (I-13).
 */
export function NotesPanel({
  card,
  activities,
  className,
}: {
  card: ClientCard;
  activities: ActivityRow[];
  className?: string;
}) {
  return (
    <section
      aria-label="Last call and note box"
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-surface transition duration-200 focus-within:border-accent/60 focus-within:ring-[3px] focus-within:ring-ring",
        className,
      )}
    >
      <LastContact card={card} activities={activities} />
      <NoteComposer card={card} />
    </section>
  );
}

function dayLabel(day: ISODate, today: ISODate): string {
  const ago = diffDays(day, today);
  const date = formatDate(day, today);
  if (ago === 0) return `Today · ${date}`;
  if (ago === 1) return `Yesterday · ${date}`;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
  return `${weekday} · ${date}`;
}

export function Timeline({
  activities,
  className,
}: {
  activities: ActivityRow[];
  className?: string;
}) {
  const { timezone, today } = useApp();
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const counts = countByFilter(activities);
  const rows = filterActivities(activities, filter);
  const shown = rows.slice(0, limit);
  // newest first, so each day's entries are already together
  const days: { day: ISODate; items: ActivityRow[] }[] = [];
  for (const a of shown) {
    const day = dateInTz(a.occurred_at, timezone);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(a);
    else days.push({ day, items: [a] });
  }

  return (
    <section
      aria-label="Notes and history"
      className={cn("rounded-2xl border border-border bg-surface p-4 sm:p-5", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Timeline</h2>
        <div
          className="-mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1"
          role="group"
          aria-label="Show"
        >
          {TIMELINE_FILTERS.map((f) => (
            <Chip
              key={f.key}
              title={f.hint}
              active={filter === f.key}
              count={counts[f.key]}
              onClick={() => {
                setFilter(f.key);
                setLimit(PAGE);
              }}
            >
              {f.label}
            </Chip>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border-strong/70 bg-surface-3/40 px-6 py-10 text-center">
          <p className="text-sm font-semibold">
            {activities.length === 0 ? "Nothing logged yet" : "Nothing here"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            {activities.length === 0
              ? "Write the first note above: what they want, who they owe, when to call back."
              : "No entries match this filter."}
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {days.map((d) => (
            <div key={d.day}>
              <h3 className="eyebrow mb-3 flex items-center gap-3">
                {dayLabel(d.day, today)}
                <span aria-hidden className="h-px flex-1 bg-border" />
              </h3>
              <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-px before:bg-border">
                {d.items.map((a) => (
                  <Entry key={a.id} a={a} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
      {rows.length > shown.length ? (
        <Button className="mt-4 w-full" onClick={() => setLimit((n) => n + PAGE)}>
          Show older ({rows.length - shown.length} more)
        </Button>
      ) : null}
    </section>
  );
}

function LastContact({ card, activities }: { card: ClientCard; activities: ActivityRow[] }) {
  const nowMs = useNowMs();
  const { timezone } = useApp();
  const last = lastCallSummary(card, new Date(nowMs));
  // The last follow-up is shown on its own line only when it was not that call.
  const touch = lastTouchOf(activities);
  const otherTouch =
    touch && (last.never || new Date(touch.atIso).getTime() > new Date(last.atIso).getTime())
      ? touch
      : null;
  return (
    <div className="flex items-start gap-3 border-b border-border bg-surface-3/50 px-4 py-3 sm:px-5">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          last.never ? DOT.neutral : DOT.good,
        )}
      >
        <Icon name="phone" className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {last.never ? (
          <p>
            <span className="font-semibold">Never called yet</span>
            <span className="text-muted"> · no call has been logged.</span>
          </p>
        ) : (
          <p>
            <span className="font-semibold" title={fullDateTime(last.atIso, timezone)}>
              Last call {last.ago}
            </span>
            {last.note ? (
              <>
                <span className="text-muted"> · </span>
                <span className="break-words whitespace-pre-wrap text-text-2">{last.note}</span>
              </>
            ) : (
              <span className="text-muted"> · no note was left.</span>
            )}
          </p>
        )}
        {otherTouch ? (
          <p className="mt-0.5 text-xs text-muted" title={fullDateTime(otherTouch.atIso, timezone)}>
            Last follow-up: {otherTouch.kind} {timeAgo(otherTouch.atIso, new Date(nowMs))}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NoteComposer({ card }: { card: ClientCard }) {
  const clientId = card.id;
  const { today } = useApp();
  const run = useRun();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // The note that was just saved, so its date suggestions stay tappable after the box clears.
  const [savedNote, setSavedNote] = useState("");
  const [applied, setApplied] = useState<ISODate | null>(null);
  const [settingDate, setSettingDate] = useState(false);

  async function save() {
    if (busy || !body.trim()) return;
    setBusy(true);
    const ok = await run(addNoteAction({ clientId, body }), "Note saved");
    setBusy(false);
    if (ok) {
      setSavedNote(body);
      setBody("");
    }
  }

  async function setDate(dueOn: ISODate) {
    setSettingDate(true);
    const ok = await run(
      setFollowUpAction({ clientId, dueOn }),
      `Follow-up set for ${formatDate(dueOn, today)}`,
    );
    setSettingDate(false);
    if (ok) setApplied(dueOn);
  }

  const hintSource = body.trim() ? body : savedNote;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="sr-only" htmlFor="new-note">
        New note
      </label>
      <textarea
        id="new-note"
        rows={3}
        value={body}
        readOnly={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        placeholder="Write a note: what they said, what they want, when to call back…"
        className="block min-h-24 w-full resize-y bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-relaxed text-text placeholder:text-muted/70 focus:outline-none sm:px-5"
      />
      {hintSource.trim() ? (
        <div className="px-4 pb-2 empty:hidden sm:px-5">
          <HintChips
            note={hintSource}
            today={today}
            stage={card.stage}
            selected={applied}
            alreadySet={card.next_due_on}
            busy={settingDate}
            heading={body.trim() ? "Set the follow-up to" : "From the note you just saved:"}
            onPick={setDate}
          />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 px-4 pb-3 sm:px-5">
        <p className="flex items-center gap-1.5 text-xs text-muted max-sm:hidden">
          <Kbd>⌘</Kbd>
          <Kbd>Enter</Kbd>
          <span>saves (Ctrl+Enter on Windows)</span>
        </p>
        <p className="text-xs text-muted tabular-nums sm:hidden">
          {body.length > 0 ? `${body.length} characters` : "Saved to the timeline"}
        </p>
        <button type="submit" disabled={busy || !body.trim()} className={inkButtonClass()}>
          <Icon name="check" className="size-3.5" />
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
    </form>
  );
}

function Entry({ a }: { a: ActivityRow }) {
  const { timezone, today } = useApp();
  const nowMs = useNowMs();
  // older rows can hold a kind the removed features wrote (funding): show it as a plain update
  const meta = look(a);
  const body = activityBody(a, today);
  const isNote = a.kind === "note";

  return (
    <li className="group relative flex gap-3 pb-4 last:pb-0">
      <span
        aria-hidden
        className={cn(
          "relative z-10 flex size-[27px] shrink-0 items-center justify-center rounded-full ring-4 ring-surface",
          DOT[meta.tone],
        )}
      >
        <Icon name={meta.icon} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
            {a.kind === "stage_change" ? (
              <StageChangeLabel from={a.from_stage} to={a.to_stage} />
            ) : (
              meta.label
            )}
            {a.kind === "call" && a.outcome ? (
              <Badge tone={OUTCOME_TONE[a.outcome]}>{outcomeLabel(a.kind, a.outcome)}</Badge>
            ) : null}
          </div>
          <time
            dateTime={a.occurred_at}
            title={fullDateTime(a.occurred_at, timezone)}
            className="shrink-0 text-xs text-muted tabular-nums"
          >
            {timeAgo(a.occurred_at, new Date(nowMs))}
          </time>
        </div>
        {body ? (
          <p
            className={cn(
              "mt-1 break-words whitespace-pre-wrap",
              isNote
                ? "rounded-xl rounded-tl-sm border border-border bg-surface-3/70 px-3 py-2 text-sm text-text"
                : "text-[13px] text-text-2",
            )}
          >
            {body}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function StageChangeLabel({
  from,
  to,
}: {
  from: ActivityRow["from_stage"];
  to: ActivityRow["to_stage"];
}) {
  if (!to) return <>Stage change</>;
  return (
    <>
      {from ? `${stageDef(from).label} → ` : "Moved to "}
      {stageDef(to).label}
    </>
  );
}
