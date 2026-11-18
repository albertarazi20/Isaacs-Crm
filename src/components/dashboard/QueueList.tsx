"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app-context";
import { useAssistant } from "@/components/assistant/Assistant";
import { Glyph, type GlyphName } from "@/components/shell/icons";
import { NewLeadButton } from "@/components/shell/NewLead";
import { cn, EmptyState } from "@/components/ui";
import { queueBrief } from "@/lib/assistant/prompts";
import { PREP_LABEL } from "@/lib/brain/briefs";
import type { PrepRow } from "@/lib/brain/queries";
import { timeAgo } from "@/lib/format";
import type { QueueItem, QueueKind } from "@/lib/followup/overview";

const KIND: Record<QueueKind, { label: string; icon: GlyphName; chip: string; ink: string }> = {
  reply: {
    label: "Replied",
    icon: "reply",
    chip: "bg-accent-soft text-accent ring-accent/25",
    ink: "text-accent",
  },
  opened: {
    label: "Opened link",
    icon: "zap",
    chip: "bg-warn-soft text-warn ring-warn/20",
    ink: "text-warn",
  },
  call_now: {
    label: "Call now",
    icon: "phone",
    chip: "bg-info-soft text-info ring-info/20",
    ink: "text-info",
  },
  ready: {
    label: "Ready",
    icon: "flag",
    chip: "bg-good-soft text-good ring-good/20",
    ink: "text-good",
  },
  upload: {
    label: "Sent docs",
    icon: "file",
    chip: "bg-good-soft text-good ring-good/20",
    ink: "text-good",
  },
  bounced: {
    label: "Bounced",
    icon: "alert",
    chip: "bg-bad-soft text-bad ring-bad/20",
    ink: "text-bad",
  },
  overdue: {
    label: "Overdue",
    icon: "clock",
    chip: "bg-warn-soft text-warn ring-warn/20",
    ink: "text-warn",
  },
};
const ORDER: QueueKind[] = ["reply", "opened", "call_now", "ready", "upload", "bounced", "overdue"];

/** "Do this now": the ranked list of merchants that need a person, with a filter by why they are on it. */
export function QueueList({ items, preps = [] }: { items: QueueItem[]; preps?: PrepRow[] }) {
  const { nowMs } = useApp();
  const ask = useAssistant();
  const [kind, setKind] = useState<QueueKind | "all">("all");
  const counts = new Map<QueueKind, number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  const present = ORDER.filter((k) => counts.has(k));
  const shown = kind === "all" ? items : items.filter((it) => it.kind === kind);
  const now = new Date(nowMs);
  // what the assistant already prepared for a merchant on this list (the newest one, unread)
  const prepared = new Map<string, PrepRow>();
  for (const p of preps) if (p.clientId && !prepared.has(p.clientId)) prepared.set(p.clientId, p);

  if (items.length === 0)
    return (
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        <EmptyState title="Nothing is waiting on you" action={<NewLeadButton />}>
          No replies to answer, no follow-ups past due. Add the next lead and the bucket takes it
          from there.
        </EmptyState>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {present.length > 1 ? (
        <div
          role="group"
          aria-label="Filter by reason"
          className="flex gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5"
        >
          {(["all", ...present] as const).map((k) => {
            const active = kind === k;
            const n = k === "all" ? items.length : (counts.get(k) ?? 0);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => setKind(k)}
                className={cn(
                  "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition duration-150 active:scale-[0.97] sm:h-8",
                  active
                    ? "border-accent/40 bg-accent-soft text-text"
                    : "border-border bg-surface-3/60 text-muted hover:border-border-strong hover:text-text",
                )}
              >
                {k === "all" ? "Everything" : KIND[k].label}
                <span className={cn("tabular-nums", active ? "text-accent" : "text-muted")}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <ul className="max-h-[540px] min-h-0 flex-1 divide-y divide-border overflow-y-auto border-t border-border xl:max-h-none">
        {shown.map((it) => {
          const k = KIND[it.kind];
          const brief = queueBrief(it.kind, it.businessName || it.contactName, it.clientId);
          const prep = prepared.get(it.clientId);
          return (
            <li
              key={`${it.kind}-${it.clientId}`}
              className="flex items-center transition duration-150 hover:bg-surface-2/50"
            >
              <Link
                href={`/clients/${it.clientId}`}
                className="group flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 sm:pl-5"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
                    k.chip,
                  )}
                >
                  <Glyph name={k.icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13.5px] font-semibold">
                      {it.businessName || it.contactName || "Unnamed merchant"}
                    </span>
                    {it.contactName && it.businessName ? (
                      <span className="hidden truncate text-xs text-muted sm:inline">
                        {it.contactName}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[12.5px] text-muted">
                    <span className={cn("font-medium", k.ink)}>{k.label}</span>
                    <span aria-hidden> · </span>
                    {it.detail}
                  </span>
                  {prep ? (
                    <span className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-accent">
                      <Glyph name="sparkles" className="size-3" />
                      {PREP_LABEL[prep.kind]}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs text-muted tabular-nums">
                    {timeAgo(it.at, now)}
                  </span>
                  {it.ownerName ? (
                    <span className="block text-[11.5px] text-muted">{it.ownerName}</span>
                  ) : null}
                </span>
                <Glyph
                  name="arrowRight"
                  className="size-4 shrink-0 -translate-x-1 text-muted opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100 max-sm:hidden"
                />
              </Link>
              <button
                type="button"
                onClick={() =>
                  prep ? ask({ prepId: prep.id }) : ask({ ...brief, send: true, fresh: true })
                }
                aria-label={prep ? `Review what was prepared: ${it.businessName}` : brief.label}
                title={prep ? "Review what the assistant prepared" : brief.label}
                className="mx-2 flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition duration-150 hover:bg-brand-soft hover:text-accent active:scale-[0.95] sm:mr-3"
              >
                <Glyph name="sparkles" className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
