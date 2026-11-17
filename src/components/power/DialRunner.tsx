"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Priority } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { formatDateTime, relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { timerLabel, type TimerKind } from "@/lib/mca/stages";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { useApp } from "../app-context";
import { bookedToday } from "@/lib/mca/booked";
import { ContactActions } from "../ContactActions";
import { useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { StageBadge } from "../StageBadge";
import { Avatar, Badge, buttonClass, cn, IconButton, Kbd, Meter } from "../ui";
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

/** One fact about the merchant on the card: a small label over the value. */
function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm break-words text-text-2">{children}</dd>
    </div>
  );
}

/** Calls booked for today first (they are appointments), then starred clients, then the ranked order. */
function arrange(
  items: DialItem[],
  hot: ReadonlySet<string>,
  today: string,
  timezone: string,
): DialItem[] {
  const booked = (i: DialItem) => bookedToday(i.card, today, timezone);
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
      timezone,
    );
    const back = skipped.flatMap((id) => byId.get(id) ?? []);
    return [...front, ...back];
  }, [items, skipped, hot, today, timezone]);

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

  // where the merchant on screen sits in today's line: the handled ones first, then the queue in order, so N and P
  // move it and a skip sends it to the end
  const position = Math.min(done + idx + 1, Math.max(total, 1));
  const skip = () => {
    if (current) setSkipped((s) => [...s.filter((id) => id !== current.card.id), current.card.id]);
  };

  return (
    <div
      role="region"
      aria-label="Power dial"
      className="fixed inset-0 z-[45] flex flex-col overflow-hidden bg-bg text-text"
    >
      {/* the room's light, kept low so the one card is all there is to look at */}
      <div
        aria-hidden
        className="bg-brand pointer-events-none absolute -top-48 left-1/2 size-[640px] -translate-x-1/2 rounded-full opacity-[0.09] blur-3xl"
      />

      <header className="glass relative z-10 border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <span
            aria-hidden
            className="bg-brand flex size-9 shrink-0 items-center justify-center rounded-full text-white shadow-glow"
          >
            <Glyph name="zap" className="size-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow whitespace-nowrap">Power dial</p>
            <p className="text-sm font-semibold whitespace-nowrap tabular-nums" aria-live="polite">
              {n === 0
                ? total === 0
                  ? "No calls due"
                  : `${done} of ${total} done`
                : `${position} of ${total}`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Keyboard shortcuts"
            aria-expanded={help}
            onClick={() => setHelp((v) => !v)}
            className={buttonClass("ghost", "md", "gap-2 max-sm:hidden")}
          >
            Shortcuts <Kbd>?</Kbd>
          </button>
          <Link href="/" className={buttonClass("secondary", "md")}>
            Done for today
          </Link>
        </div>
        <div role="group" aria-label="Progress through today's calls">
          <Meter
            label="Calls done today"
            value={total === 0 ? 1 : done}
            max={total === 0 ? 1 : total}
            tone="brand"
            className="h-[3px] rounded-none bg-transparent"
          />
        </div>
      </header>

      {help ? (
        <div
          role="note"
          className="glass relative z-10 animate-fade border-b border-border px-4 py-3 text-[13px]"
        >
          <ul className="mx-auto grid max-w-2xl gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {SHORTCUTS.map(([k, v]) => (
              <li key={k} className="flex items-center gap-3">
                <Kbd className="h-6 min-w-6">{k}</Kbd>
                <span className="text-text-2">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
          {current ? (
            <DialCard key={current.card.id} item={current} timezone={timezone} cardRef={cardRef} />
          ) : (
            <div className="glass ring-brand animate-pop rounded-3xl border border-border px-6 py-14 text-center shadow-pop">
              <span
                aria-hidden
                className="bg-brand mx-auto flex size-14 items-center justify-center rounded-full text-white shadow-glow"
              >
                <Glyph name="check" className="size-7" strokeWidth={2.2} />
              </span>
              <h1 className="mt-5 text-3xl font-semibold tracking-[-0.03em]">You&apos;re done</h1>
              <p className="mt-2 text-sm text-muted tabular-nums">
                {total === 0 ? "Nothing is due to call right now." : `${done} of ${total} handled.`}
              </p>
              <Link href="/" className={buttonClass("primary", "lg", "mt-7")}>
                Back to Today
              </Link>
            </div>
          )}
        </div>
      </div>

      {current ? (
        <footer className="glass relative z-10 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            <button
              type="button"
              onClick={() => n > 0 && setCursor((idx - 1 + n) % n)}
              disabled={n < 2}
              aria-label="Previous client"
              title="Previous client"
              className={buttonClass("ghost", "lg", "w-12 px-0")}
            >
              <Glyph name="chevron" className="size-5 rotate-180" />
            </button>
            <button
              type="button"
              onClick={skip}
              className={buttonClass("secondary", "lg", "flex-1")}
            >
              Skip <Kbd className="max-sm:hidden">S</Kbd>
            </button>
            <button
              type="button"
              onClick={() => n > 0 && setCursor((idx + 1) % n)}
              disabled={n < 2}
              className={buttonClass("secondary", "lg", "flex-1")}
            >
              Next <Kbd className="max-sm:hidden">N</Kbd>
            </button>
          </div>
          <p className="mx-auto mt-2.5 hidden max-w-2xl items-center justify-center gap-x-4 text-xs text-muted sm:flex">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>C</Kbd> Call
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>S</Kbd> Skip to the end
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>N</Kbd> Next
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>P</Kbd> Previous
            </span>
          </p>
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
  const toast = useToast();
  const { card, reason, priority } = item;
  const due = card.next_due_on;
  const overdue = due !== null && due < today;
  const kind = card.next_due_kind as TimerKind | null;

  const wants = card.wanted_amount_cents ? formatMoney(card.wanted_amount_cents) : "";
  const phone = card.phone ? formatUS(card.phone) : "";

  async function copyPhone() {
    try {
      await navigator.clipboard.writeText(phone);
      toast({ message: `Copied ${phone}`, tone: "success" });
    } catch {
      toast({ message: "Couldn't copy. Select the number and copy it by hand.", tone: "error" });
    }
  }

  return (
    <div ref={cardRef} className="animate-rise space-y-5">
      <article
        aria-label={card.business_name}
        className="glass ring-brand rounded-3xl border border-border p-5 shadow-pop sm:p-8"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <StageBadge stage={card.stage} />
          {due ? (
            <Badge tone={overdue ? "warn" : due === today ? "accent" : "neutral"}>
              {kind ? `${timerLabel(kind)} · ` : ""}
              {relativeDay(due, today)}
            </Badge>
          ) : null}
          {card.scheduled_call_at &&
          (kind === "scheduled_call" || bookedToday(card, today, timezone)) ? (
            <Badge tone="accent">Booked {formatDateTime(card.scheduled_call_at, timezone)}</Badge>
          ) : null}
        </div>

        <div className="mt-5 flex items-start gap-4">
          <Avatar name={card.business_name} size={52} className="max-sm:hidden" />
          <div className="min-w-0">
            <h1 className="text-[26px] leading-[1.1] font-semibold tracking-[-0.03em] break-words sm:text-[32px]">
              {card.business_name}
            </h1>
            <p className="mt-1.5 text-sm text-muted">
              {[
                card.contact_name,
                card.dba && card.dba !== card.business_name ? `dba ${card.dba}` : "",
              ]
                .filter(Boolean)
                .join(" · ") || "No merchant name"}
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <p
            className={cn(
              "leading-none font-semibold tracking-[-0.035em] tabular-nums",
              phone ? "text-[34px] sm:text-[46px]" : "text-2xl text-muted",
            )}
          >
            {phone || "No phone number"}
          </p>
          {phone ? (
            <IconButton label="Copy the phone number" onClick={() => void copyPhone()}>
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="size-[18px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="11" height="11" rx="2.5" />
                <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
              </svg>
            </IconButton>
          ) : null}
        </div>

        <div
          className={cn(
            "mt-6 [&_button]:h-12 [&_button]:flex-1 [&_button]:text-base [&>div]:w-full [&>div]:gap-2",
          )}
        >
          <ContactActions client={card} size="md" />
        </div>

        <dl className="mt-7 grid gap-x-8 gap-y-5 border-t border-border pt-6 sm:grid-cols-2">
          <Fact label="Why now" wide>
            <span className="font-medium text-text">{timerLabel(kind)}</span>
            {reason ? <span className="text-muted"> · {reason}</span> : null}
          </Fact>
          <Fact label="Last call" wide>
            {card.last_call_at ? (
              <>
                {timeAgo(card.last_call_at, new Date(nowMs))}
                {card.last_call_note ? (
                  <span className="mt-1 block italic">“{card.last_call_note}”</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted">Never called</span>
            )}
          </Fact>
          <Fact label="Wants">{wants || <span className="text-muted">Not recorded</span>}</Fact>
          {card.stips_required > 0 ? (
            <Fact label="Stips">
              <span className="tabular-nums">
                {card.stips_received} of {card.stips_required} received
              </span>
              <Meter
                label="Documents received"
                value={card.stips_received}
                max={card.stips_required}
                tone="brand"
                className="mt-2 h-1 max-w-40"
              />
            </Fact>
          ) : null}
          <Fact label="At stake" wide={card.stips_required > 0}>
            <span className="font-medium text-text tabular-nums">
              {priority.basis === "unknown"
                ? "No amount on file"
                : `${formatMoneyCompact(priority.atStakeCents)} (what they want)`}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{priority.summary}</span>
          </Fact>
        </dl>
      </article>

      <section aria-label="Snooze this client" className="space-y-3 px-1">
        <h2 className="eyebrow">Not now</h2>
        <SnoozeButtons key={card.id} card={card} />
      </section>
    </div>
  );
}
