"use client";

import Link from "next/link";
import type { CardMeta } from "@/lib/data/cardMeta";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { useApp } from "./app-context";
import { Glyph } from "./shell/icons";
import { StageBadge } from "./StageBadge";
import { Avatar, Badge, cn } from "./ui";

/** When the next follow-up is: a dot and plain words. Late ones glow warm instead of shouting. */
export function DueText({ card }: { card: ClientCard }) {
  const { today } = useApp();
  const due = card.next_due_on;
  if (!due) return <span className="text-muted">None set</span>;
  const overdue = due < today;
  const isToday = due === today;
  return (
    <span
      title={formatDate(due, today)}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap",
        overdue ? "font-medium text-warn" : isToday ? "font-medium text-accent" : "text-text-2",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          overdue ? "bg-warn" : isToday ? "bg-accent" : "bg-border-strong",
        )}
      />
      <span className="truncate">{relativeDay(due, today)}</span>
    </span>
  );
}

/**
 * The Merchants list on a phone (under 768px): one stacked row per merchant with the name, the stage and when
 * he is due, so nothing needs a sideways swipe (I-14). Wider screens use the grid instead.
 */
export function ClientCards({
  rows,
  meta,
}: {
  rows: readonly ClientCard[];
  meta: Record<string, CardMeta>;
}) {
  const { nowMs } = useApp();
  return (
    <ul
      className="divide-y divide-border rounded-2xl border border-border bg-surface md:hidden"
      aria-label="Merchants"
    >
      {rows.map((c) => {
        const m = meta[c.id];
        const who = [c.contact_name, c.phone ? formatUS(c.phone) : ""].filter(Boolean).join(" · ");
        return (
          <li key={c.id}>
            <Link
              href={`/clients/${c.id}`}
              className="flex min-h-14 items-start gap-3 px-3.5 py-3 transition duration-150 first:rounded-t-2xl last:rounded-b-2xl active:bg-surface-2"
            >
              <Avatar name={c.business_name} size={36} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-sm font-semibold tracking-tight break-words">
                    {c.business_name}
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs">
                    <DueText card={c} />
                  </span>
                </div>
                {who ? <p className="mt-0.5 truncate text-xs text-muted">{who}</p> : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StageBadge stage={c.stage} />
                  {m?.brought_in_at ? (
                    <Badge tone="good">
                      <Glyph name="check" className="size-3" strokeWidth={2.4} />
                      Brought in
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted">
                    {m?.bucket_name ? `${m.bucket_name} · ` : ""}
                    {c.last_touch_at
                      ? `touched ${timeAgo(c.last_touch_at, new Date(nowMs))}`
                      : "never contacted"}
                  </span>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
