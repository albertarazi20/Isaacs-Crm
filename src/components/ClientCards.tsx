"use client";

import Link from "next/link";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { StageBadge } from "./StageBadge";
import { Badge } from "./ui";

/**
 * The Clients list on a phone (under 640px): one card per merchant with the name, the stage and the date
 * he is due, so nothing needs a sideways swipe (I-14). Wider screens use the table instead.
 */
export function ClientCards({ rows }: { rows: readonly ClientCard[] }) {
  const { today, nowMs } = useApp();
  return (
    <ul className="space-y-2 sm:hidden" aria-label="Clients">
      {rows.map((c) => {
        const overdue = c.next_due_on !== null && c.next_due_on < today;
        const who = [c.contact_name, c.phone ? formatUS(c.phone) : ""].filter(Boolean).join(" · ");
        return (
          <li key={c.id}>
            <Link
              href={`/clients/${c.id}`}
              className="block rounded-xl border border-border bg-surface p-3.5 active:bg-surface-2"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 font-semibold break-words">{c.business_name}</span>
                <span className="shrink-0 text-right">
                  {c.next_due_on ? (
                    <>
                      <Badge tone={overdue ? "bad" : c.next_due_on === today ? "warn" : "neutral"}>
                        {relativeDay(c.next_due_on, today)}
                      </Badge>
                      <span className="mt-0.5 block text-xs text-muted">
                        {formatDate(c.next_due_on, today)}
                      </span>
                    </>
                  ) : (
                    <Badge tone="bad">No follow-up</Badge>
                  )}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <StageBadge stage={c.stage} />
                {c.wanted_amount_cents !== null ? (
                  <span className="text-xs font-medium">
                    Wants {formatMoneyCompact(c.wanted_amount_cents)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                {who ? `${who} · ` : ""}
                Last contact {c.last_touch_at ? timeAgo(c.last_touch_at, new Date(nowMs)) : "never"}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
