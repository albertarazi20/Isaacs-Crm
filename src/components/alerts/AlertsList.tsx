"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { markAlertsReadAction } from "@/app/alerts-actions";
import { Glyph } from "@/components/shell/icons";
import { cn, IconButton, LinkButton, PageHeader, TONE_TEXT } from "@/components/ui";
import { ALERT_KIND_LABELS, type AlertFeedRow } from "@/lib/alerts/feed";
import { Button, EmptyState, kindLabel, lookOf, TONE_CHIP, useCallSafe } from "./shared";

type Filter = "all" | "unread" | "signed" | "sending";

/** The calendar day an alert landed on, in the person's own timezone, as YYYY-MM-DD. */
function dayOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function timeOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "Today", "Yesterday", or "Mon, Nov 9" (with the year once it is not this one). */
function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  const d = new Date(`${day}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  }).format(d);
}

export function AlertsList({
  rows,
  timezone,
  today,
}: {
  rows: AlertFeedRow[];
  timezone: string;
  today: string;
}) {
  const router = useRouter();
  const call = useCallSafe();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // read here before the server has answered, so the dot goes out under the finger
  const [justRead, setJustRead] = useState<Set<string>>(new Set());
  const isUnread = (r: AlertFeedRow) => r.read_at === null && !justRead.has(r.id);

  const unread = rows.filter(isUnread).length;
  const counts: Record<Filter, number> = {
    all: rows.length,
    unread,
    signed: rows.filter((r) => lookOf(r.kind).group === "signed").length,
    sending: rows.filter((r) => lookOf(r.kind).group === "sending").length,
  };
  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: "Unread" },
    { key: "signed", label: "Signed" },
    { key: "sending", label: "Sending" },
  ];

  const days = useMemo(() => {
    const shown = [...rows]
      .filter((r) =>
        filter === "all"
          ? true
          : filter === "unread"
            ? r.read_at === null && !justRead.has(r.id)
            : lookOf(r.kind).group === filter,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const groups: { day: string; rows: AlertFeedRow[] }[] = [];
    for (const r of shown) {
      const day = dayOf(r.created_at, timezone);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else groups.push({ day, rows: [r] });
    }
    return groups;
  }, [rows, filter, justRead, timezone]);

  const markAll = async () => {
    setBusy(true);
    const ok = await call(markAlertsReadAction({}));
    setBusy(false);
    if (ok !== null) setJustRead(new Set(rows.map((r) => r.id)));
    router.refresh();
  };
  const markOne = async (id: string) => {
    setJustRead((cur) => new Set(cur).add(id));
    await call(markAlertsReadAction({ ids: [id] }));
    router.refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow="Inbox"
        title="Alerts"
        description={
          unread === 0
            ? "Nothing unread. The hourly email carries these too."
            : `${unread} unread. The hourly email carries these too.`
        }
        actions={
          unread > 0 ? (
            <Button onClick={markAll} disabled={busy}>
              <Glyph name="check" className="size-4" strokeWidth={2.2} />
              Mark all read
            </Button>
          ) : null
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No alerts yet"
          action={
            <LinkButton href="/follow-up" variant="primary">
              Open Follow Up
            </LinkButton>
          }
        >
          Signed applications, complete files, paused templates and bounce spikes show up here.
        </EmptyState>
      ) : (
        <>
          <div
            role="group"
            aria-label="Show"
            className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-2/70 p-1"
          >
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition duration-150 active:scale-[0.97] sm:h-8",
                  filter === f.key
                    ? "bg-surface text-text shadow-card"
                    : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                {f.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] tabular-nums",
                    filter === f.key ? "bg-accent-soft text-accent" : "bg-surface-3 text-muted",
                  )}
                >
                  {counts[f.key]}
                </span>
              </button>
            ))}
          </div>

          {days.length === 0 ? (
            <EmptyState
              title={filter === "unread" ? "You're all caught up" : "Nothing here"}
              action={<Button onClick={() => setFilter("all")}>Show all alerts</Button>}
            >
              {filter === "unread"
                ? "Every alert has been read."
                : "No alerts of this kind in your recent feed."}
            </EmptyState>
          ) : (
            <div className="stagger space-y-6">
              {days.map((g) => (
                <section key={g.day} aria-label={dayLabel(g.day, today)}>
                  <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
                    <h2 className="eyebrow">{dayLabel(g.day, today)}</h2>
                    <span className="text-[11px] text-muted tabular-nums">{g.rows.length}</span>
                  </div>
                  <ol className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                    {g.rows.map((r) => {
                      const look = lookOf(r.kind);
                      const fresh = isUnread(r);
                      return (
                        <li
                          key={r.id}
                          className="group relative flex items-stretch transition duration-150 hover:bg-surface-2/50"
                        >
                          <Link
                            href={r.href || "/"}
                            onClick={() => {
                              if (fresh) void markAlertsReadAction({ ids: [r.id] });
                            }}
                            className="flex min-w-0 flex-1 items-start gap-3.5 py-3 pr-2 pl-4"
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
                                TONE_CHIP[look.tone],
                                !fresh && "opacity-70",
                              )}
                            >
                              {look.icon}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  "block text-[13px] max-sm:line-clamp-2 sm:truncate",
                                  fresh ? "font-semibold text-text" : "font-medium text-text-2",
                                )}
                              >
                                {r.title}
                              </span>
                              {r.body ? (
                                <span className="mt-0.5 block text-xs text-muted max-sm:line-clamp-2 sm:truncate">
                                  {r.body}
                                </span>
                              ) : null}
                              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                                <span
                                  className={cn(
                                    "shrink-0 font-semibold whitespace-nowrap",
                                    TONE_TEXT[look.tone],
                                  )}
                                >
                                  {kindLabel(r.kind, ALERT_KIND_LABELS)}
                                </span>
                                {r.business_name ? (
                                  <>
                                    <span aria-hidden>·</span>
                                    <span className="truncate">{r.business_name}</span>
                                  </>
                                ) : null}
                                <span className="shrink-0 whitespace-nowrap tabular-nums sm:hidden">
                                  · {timeOf(r.created_at, timezone)}
                                </span>
                              </span>
                            </span>
                            <span className="mt-0.5 flex shrink-0 items-center gap-2 text-xs text-muted tabular-nums">
                              <span className="max-sm:hidden">
                                {timeOf(r.created_at, timezone)}
                              </span>
                              <span
                                className={cn(
                                  "size-2 rounded-full",
                                  fresh
                                    ? "bg-accent shadow-[0_0_0_3px_var(--accent-soft)]"
                                    : "bg-transparent",
                                )}
                              >
                                {fresh ? <span className="sr-only">Unread</span> : null}
                              </span>
                            </span>
                          </Link>
                          <span className="flex w-11 shrink-0 items-center justify-center sm:w-12">
                            {fresh ? (
                              <IconButton
                                label="Mark read"
                                onClick={() => void markOne(r.id)}
                                className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                              >
                                <Glyph name="check" className="size-4" strokeWidth={2.2} />
                              </IconButton>
                            ) : (
                              <Glyph name="chevron" className="size-4 text-muted/60" />
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
