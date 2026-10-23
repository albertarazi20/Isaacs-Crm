"use client";

import { useState } from "react";
import { addNoteAction, setFollowUpAction } from "@/app/actions";
import type { ActivityRow, ClientCard } from "@/lib/data/types";
import { formatDate, timeAgo } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { outcomeLabel } from "@/lib/mca/touch";
import { useApp } from "../app-context";
import { Badge, Button, cn, EmptyState, Textarea } from "../ui";
import { HintChips } from "../winback/HintChips";
import {
  activityBody,
  countByFilter,
  filterActivities,
  fullDateTime,
  lastCallSummary,
  lastTouchOf,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from "./logic";
import { Muted, useNowMs, useRun } from "./parts";

const KIND_META: Record<ActivityRow["kind"], { icon: string; label: string }> = {
  note: { icon: "📝", label: "Note" },
  call: { icon: "📞", label: "Call" },
  text: { icon: "💬", label: "Text" },
  email: { icon: "✉️", label: "Email" },
  stage_change: { icon: "🔀", label: "Stage change" },
  timer: { icon: "⏰", label: "Follow-up" },
  funding: { icon: "💵", label: "Funding" },
  system: { icon: "⚙️", label: "Update" },
};

const OUTCOME_TONE = {
  reached: "good",
  no_answer: "neutral",
  left_message: "warn",
  bad_number: "bad",
} as const;

const PAGE = 40;

export function Timeline({ card, activities }: { card: ClientCard; activities: ActivityRow[] }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const counts = countByFilter(activities);
  const rows = filterActivities(activities, filter);
  const shown = rows.slice(0, limit);

  return (
    <section aria-label="Notes and history" className="space-y-4">
      <LastContact card={card} activities={activities} />
      <NoteComposer card={card} />
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
        {TIMELINE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            title={f.hint}
            aria-pressed={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setLimit(PAGE);
            }}
            className={cn(
              "h-8 rounded-full border px-3 text-sm font-medium transition",
              filter === f.key
                ? "border-accent bg-accent text-accent-fg"
                : "border-border bg-surface hover:bg-surface-2",
            )}
          >
            {f.label} <span className="opacity-70">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        activities.length === 0 ? (
          <EmptyState title="Nothing logged yet">
            Write the first note above — what he wants, who he owes, when to call back.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing here">No entries match this filter.</EmptyState>
        )
      ) : (
        <ol className="space-y-2">
          {shown.map((a) => (
            <Entry key={a.id} a={a} />
          ))}
        </ol>
      )}
      {rows.length > shown.length ? (
        <Button className="w-full" onClick={() => setLimit((n) => n + PAGE)}>
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
    <div className="rounded-xl border border-border bg-surface p-4">
      {last.never ? (
        <p className="font-medium">
          Never called yet
          <span className="font-normal text-muted"> — no call has been logged.</span>
        </p>
      ) : (
        <p>
          <span className="font-semibold" title={fullDateTime(last.atIso, timezone)}>
            Last call {last.ago}
          </span>
          {last.note ? (
            <>
              <span className="text-muted"> — </span>
              <span className="whitespace-pre-wrap break-words">{last.note}</span>
            </>
          ) : (
            <span className="text-muted"> — no note was left.</span>
          )}
        </p>
      )}
      {otherTouch ? (
        <Muted className="mt-1">
          <span title={fullDateTime(otherTouch.atIso, timezone)}>
            Last follow-up: {otherTouch.kind} {timeAgo(otherTouch.atIso, new Date(nowMs))}
          </span>
        </Muted>
      ) : null}
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
      className="rounded-xl border border-accent/40 bg-surface p-3 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="sr-only" htmlFor="new-note">
        New note
      </label>
      <Textarea
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
        placeholder="Write a note — what he said, what he wants, which funders he's with, when to call back…"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <Muted>Ctrl+Enter (⌘+Enter on Mac) saves</Muted>
        <Button type="submit" variant="primary" disabled={busy || !body.trim()}>
          {busy ? "Saving…" : "Save note"}
        </Button>
      </div>
      {hintSource.trim() ? (
        <div className="mt-2 border-t border-border pt-2">
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
    </form>
  );
}

function Entry({ a }: { a: ActivityRow }) {
  const { timezone, today } = useApp();
  const nowMs = useNowMs();
  const meta = KIND_META[a.kind];
  const body = activityBody(a, today);
  const isNote = a.kind === "note";
  const when = (
    <time
      dateTime={a.occurred_at}
      title={fullDateTime(a.occurred_at, timezone)}
      className="shrink-0 text-xs text-muted"
    >
      {timeAgo(a.occurred_at, new Date(nowMs))}
    </time>
  );

  return (
    <li
      className={cn(
        "rounded-xl border p-3",
        isNote ? "border-border bg-surface" : "border-transparent bg-surface-2/60",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 text-base leading-none">
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {a.kind === "stage_change" ? (
                <StageChangeLabel from={a.from_stage} to={a.to_stage} />
              ) : (
                meta.label
              )}
              {a.kind === "call" && a.outcome ? (
                <Badge tone={OUTCOME_TONE[a.outcome]}>{outcomeLabel(a.kind, a.outcome)}</Badge>
              ) : null}
            </div>
            {when}
          </div>
          {body ? (
            <p
              className={cn(
                "mt-1 break-words whitespace-pre-wrap",
                isNote ? "text-[0.95rem]" : "text-sm text-muted",
              )}
            >
              {body}
            </p>
          ) : null}
        </div>
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
