"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Priority } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { cardFundingTerms } from "@/lib/data/views";
import { formatDateTime, relativeDay, timeAgo } from "@/lib/format";
import { balanceCents, paydownPct } from "@/lib/mca/funding";
import { formatUS } from "@/lib/mca/phone";
import { TIMER_LABELS, type TimerKind } from "@/lib/mca/stages";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { useApp } from "../app-context";
import { ContactActions } from "../ContactActions";
import { StageBadge } from "../StageBadge";
import { Badge, cn } from "../ui";
import { useHotIds } from "./prefs";
import { SnoozeButtons } from "./SnoozeMenu";

export interface DialItem {
  card: ClientCard;
  /** Why the follow-up exists: the note on its timer. */
  reason: string;
  priority: Priority;
}

const SHORTCUTS: [string, string][] = [
  ["C", "Call this client (then pick the outcome)"],
  ["S", "Skip: move this client to the end of the line"],
  ["N", "Next client, leaving this one where it is"],
  ["P", "Previous client"],
  ["?", "Show or hide this list"],
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 text-base sm:grid-cols-[9rem_1fr]">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Calls booked for today first (they are appointments), then starred clients, then the ranked order. */
function arrange(items: DialItem[], hot: ReadonlySet<string>, today: string): DialItem[] {
  const booked = (i: DialItem) =>
    i.card.next_due_kind === "scheduled_call" && i.card.next_due_on === today;
  return [
    ...items.filter(booked),
    ...items.filter((i) => !booked(i) && hot.has(i.card.id)),
    ...items.filter((i) => !booked(i) && !hot.has(i.card.id)),
  ];
}

/**
 * One client at a time, biggest first. State lives in memory: the order comes from the server, "skip" is a
 * list of ids sent to the back, and a client that gets logged (or snoozed) simply stops being in the server's
 * list, so the next card appears by itself.
 */
export function DialRunner({ items }: { items: DialItem[] }) {
  const { timezone, today } = useApp();
  const hot = useHotIds();
  const [initialIds] = useState(() => items.map((i) => i.card.id));
  const [skipped, setSkipped] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [help, setHelp] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(() => {
    const byId = new Map(items.map((i) => [i.card.id, i]));
    const skippedSet = new Set(skipped);
    const front = arrange(
      items.filter((i) => !skippedSet.has(i.card.id)),
      hot,
      today,
    );
    const back = skipped.flatMap((id) => byId.get(id) ?? []);
    return [...front, ...back];
  }, [items, skipped, hot, today]);

  const n = ordered.length;
  const idx = n === 0 ? 0 : Math.min(cursor, n - 1);
  const current = ordered[idx];

  const initialSet = useMemo(() => new Set(initialIds), [initialIds]);
  const stillThere = new Set(items.map((i) => i.card.id));
  const done = initialIds.filter((id) => !stillThere.has(id)).length;
  const total = initialIds.length + items.filter((i) => !initialSet.has(i.card.id)).length;

  // Full screen means the app header behind it must not be reachable by Tab or a screen reader.
  useEffect(() => {
    const header = document.querySelector("[data-app-header]");
    header?.setAttribute("inert", "");
    return () => header?.removeAttribute("inert");
  }, []);

  useEffect(() => {
    const skipCurrent = () => {
      if (current)
        setSkipped((s) => [...s.filter((id) => id !== current.card.id), current.card.id]);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      // The outcome prompt, the search palette or a text/email dialog owns the keyboard while open.
      if (document.querySelector("dialog[open]")) return;
      switch (e.key.toLowerCase()) {
        case "c":
          cardRef.current?.querySelector<HTMLButtonElement>('button[aria-label^="Call "]')?.click();
          break;
        case "s":
          skipCurrent();
          break;
        case "n":
          if (n > 0) setCursor((idx + 1) % n);
          break;
        case "p":
          if (n > 0) setCursor((idx - 1 + n) % n);
          break;
        case "?":
          setHelp((v) => !v);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, n, idx]);

  const position = Math.min(done + 1, Math.max(total, 1));

  return (
    <div
      role="region"
      aria-label="Power dial"
      className="fixed inset-0 z-[45] flex flex-col bg-bg text-text"
    >
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tabular-nums" aria-live="polite">
            {n === 0
              ? total === 0
                ? "No calls due"
                : `${done} of ${total} done`
              : `${position} of ${total}`}
          </p>
          <div
            role="progressbar"
            aria-label="Progress through today's calls"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${total === 0 ? 100 : Math.round((done / total) * 100)}%` }}
            />
          </div>
        </div>
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          aria-expanded={help}
          onClick={() => setHelp((v) => !v)}
          className="hidden size-10 rounded-lg border border-border text-base font-semibold hover:bg-surface-2 sm:inline-flex sm:items-center sm:justify-center"
        >
          ?
        </button>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-lg bg-surface-2 px-4 text-sm font-medium hover:bg-border"
        >
          Done for today
        </Link>
      </header>

      {help ? (
        <div role="note" className="border-b border-border bg-surface-2 px-4 py-3 text-sm">
          <ul className="mx-auto max-w-xl space-y-1">
            {SHORTCUTS.map(([k, v]) => (
              <li key={k} className="flex gap-3">
                <kbd className="w-6 shrink-0 rounded border border-border bg-surface text-center font-mono">
                  {k}
                </kbd>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 py-5">
          {current ? (
            <DialCard key={current.card.id} item={current} timezone={timezone} cardRef={cardRef} />
          ) : (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <h1 className="text-3xl font-bold">You&apos;re done</h1>
              <p className="mt-2 text-muted">
                {total === 0 ? "Nothing is due to call right now." : `${done} of ${total} handled.`}
              </p>
              <Link
                href="/"
                className="mt-6 inline-flex h-12 items-center rounded-xl bg-accent px-6 font-semibold text-accent-fg"
              >
                Back to Today
              </Link>
            </div>
          )}
        </div>
      </div>

      {current ? (
        <footer className="border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-xl gap-2">
            <button
              type="button"
              onClick={() =>
                setSkipped((s) => [...s.filter((id) => id !== current.card.id), current.card.id])
              }
              className="h-12 flex-1 rounded-xl border border-border bg-surface text-base font-medium hover:bg-surface-2"
            >
              Skip <span className="text-muted">(S)</span>
            </button>
            <button
              type="button"
              onClick={() => n > 0 && setCursor((idx + 1) % n)}
              disabled={n < 2}
              className="h-12 flex-1 rounded-xl border border-border bg-surface text-base font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Next <span className="text-muted">(N)</span>
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function DialCard({
  item,
  timezone,
  cardRef,
}: {
  item: DialItem;
  timezone: string;
  cardRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { today, nowMs } = useApp();
  const { card, reason, priority } = item;
  const due = card.next_due_on;
  const overdue = due !== null && due < today;
  const kind = card.next_due_kind as TimerKind | null;
  const terms = cardFundingTerms(card);
  const pct = terms && card.funding_status === "active" ? paydownPct(terms, today) : null;

  const wants = [
    card.wanted_amount_cents ? formatMoney(card.wanted_amount_cents) : null,
    card.wanted_terms,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div ref={cardRef} className="space-y-4">
      <article
        aria-label={card.business_name}
        className="space-y-5 rounded-2xl border border-border bg-surface p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StageBadge stage={card.stage} />
          {due ? (
            <Badge tone={overdue ? "bad" : due === today ? "warn" : "neutral"}>
              {kind ? `${TIMER_LABELS[kind]} · ` : ""}
              {relativeDay(due, today)}
            </Badge>
          ) : null}
          {card.scheduled_call_at && kind === "scheduled_call" ? (
            <Badge tone="accent">Booked {formatDateTime(card.scheduled_call_at, timezone)}</Badge>
          ) : null}
        </div>

        <div>
          <h1 className="text-3xl leading-tight font-bold break-words">{card.business_name}</h1>
          <p className="mt-1 text-lg text-muted">
            {[
              card.contact_name,
              card.dba && card.dba !== card.business_name ? `dba ${card.dba}` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "No merchant name"}
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {card.phone ? formatUS(card.phone) : "No phone number"}
          </p>
        </div>

        <dl className="space-y-3">
          <Row label="Wants">{wants || <span className="text-muted">Not recorded</span>}</Row>
          <Row label="Funders would approve">
            {card.est_approval_cents ? (
              <>
                {formatMoney(card.est_approval_cents)}
                {card.est_approval_note ? (
                  <span className="text-muted"> — {card.est_approval_note}</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted">Not recorded</span>
            )}
          </Row>
          <Row label="Other advances">
            {card.position_count > 0 ? (
              `${card.position_count} · ${formatMoneyCompact(card.position_balance_cents)} balance`
            ) : (
              <span className="text-muted">None recorded</span>
            )}
          </Row>
          {pct !== null && terms ? (
            <Row label="This advance">
              {pct}% paid down · {formatMoney(balanceCents(terms, today))} left
            </Row>
          ) : null}
          {card.stips_required > 0 ? (
            <Row label="Stips">
              {card.stips_received} of {card.stips_required} received
            </Row>
          ) : null}
          <Row label="Last call">
            {card.last_call_at ? (
              <>
                {timeAgo(card.last_call_at, new Date(nowMs))}
                {card.last_call_note ? (
                  <span className="italic"> — “{card.last_call_note}”</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted">Never called</span>
            )}
          </Row>
          <Row label="Why now">
            {kind ? TIMER_LABELS[kind] : "Follow up"}
            {reason ? <span className="text-muted"> — {reason}</span> : null}
          </Row>
          <Row label="At stake">
            <span title={priority.explanation}>
              {priority.basis === "unknown"
                ? "No amount on file"
                : formatMoneyCompact(priority.atStakeCents)}
            </span>
            <span className="block text-xs text-muted">{priority.explanation}</span>
          </Row>
        </dl>

        <div
          className={cn(
            "[&>div]:w-full [&>div]:gap-2 [&_button]:h-14 [&_button]:flex-1 [&_button]:text-base",
          )}
        >
          <ContactActions client={card} size="md" />
        </div>
      </article>

      <section aria-label="Snooze this client" className="space-y-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Not now</h2>
        <SnoozeButtons key={card.id} card={card} />
      </section>
    </div>
  );
}
