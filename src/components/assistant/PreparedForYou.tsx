"use client";

import { Glyph } from "@/components/shell/icons";
import { cn } from "@/components/ui";
import { PREP_LABEL } from "@/lib/brain/briefs";
import type { PrepRow } from "@/lib/brain/queries";
import { timeAgo } from "@/lib/format";
import { useApp } from "@/components/app-context";
import { useAssistant } from "./Assistant";

/**
 * "Prepared for you": the work the assistant did in the background (a reply drafted, a nudge written, a file checked).
 * One click opens it with its buttons; nothing has been sent or changed.
 */
export function PreparedForYou({ items }: { items: PrepRow[] }) {
  const ask = useAssistant();
  const { nowMs } = useApp();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="prepared-heading" className="animate-rise space-y-3">
      <div>
        <h2 id="prepared-heading" className="text-[15px] font-semibold tracking-tight">
          Prepared for you
        </h2>
        <p className="text-[12.5px] text-muted">
          The assistant already did the thinking. Open one, read it, and click what you agree with.
          Nothing has been sent.
        </p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        {items.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => ask({ prepId: p.id })}
              className={cn(
                "group flex w-full items-start gap-3 px-4 py-3 text-left transition duration-150 hover:bg-surface-2/60 active:scale-[0.998] sm:px-5",
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-accent ring-1 ring-accent/25 ring-inset"
              >
                <Glyph name="sparkles" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-semibold">
                    {p.kind === "plan" ? "Your plan for today" : p.businessName || "A merchant"}
                  </span>
                  <span className="shrink-0 text-[12px] font-medium text-accent">
                    {PREP_LABEL[p.kind]}
                  </span>
                </span>
                {p.summary ? (
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted">
                    {p.summary}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-xs text-muted tabular-nums">
                  {timeAgo(p.readyAt, new Date(nowMs))}
                </span>
                <span className="mt-1 inline-block rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] font-semibold text-text-2 group-hover:bg-accent group-hover:text-accent-fg">
                  {p.actions > 0 ? `Review · ${p.actions}` : "Read"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
