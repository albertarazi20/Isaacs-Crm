"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { markAlertsReadAction } from "@/app/alerts-actions";
import { Badge, Button, EmptyState, useCallSafe } from "./shared";
import { ALERT_KIND_LABELS, type AlertFeedRow } from "@/lib/alerts/feed";
import { cn } from "@/components/ui";

function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

const TONE: Record<string, "good" | "warn" | "bad" | "accent" | "info" | "neutral"> = {
  approval_landed: "good",
  funding_proposed: "good",
  application_signed: "good",
  renewal_eligible: "good",
  kickback: "bad",
  stale_deal: "warn",
  behind_pace: "warn",
  payout_late: "warn",
  registration_renewal: "warn",
  copy_burst: "bad",
  after_hours_copy: "bad",
  others_lead_copy: "bad",
  canary_touched: "bad",
  chase_draft: "info",
  ask_manager: "accent",
  template_paused: "warn",
};

export function AlertsList({ rows, timezone }: { rows: AlertFeedRow[]; timezone: string }) {
  const router = useRouter();
  const call = useCallSafe();
  const [busy, setBusy] = useState(false);
  const unread = rows.filter((r) => r.read_at === null);
  if (rows.length === 0)
    return (
      <EmptyState title="No alerts yet">
        Approvals that land, files sitting too long, kickbacks and what the trust checks notice show
        up here.
      </EmptyState>
    );
  const markAll = async () => {
    setBusy(true);
    await call(markAlertsReadAction({}));
    setBusy(false);
    router.refresh();
  };
  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">{rows.length} most recent</h2>
        {unread.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={markAll} disabled={busy}>
            Mark all read
          </Button>
        ) : null}
      </header>
      <ol className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className={cn("group", r.read_at === null ? "bg-accent-soft/30" : "")}>
            <Link
              href={r.href || "/"}
              onClick={() => {
                if (r.read_at === null) void markAlertsReadAction({ ids: [r.id] });
              }}
              className="flex items-start gap-3 px-4 py-2.5 transition hover:bg-surface-3"
            >
              <span className="mt-0.5 shrink-0">
                <Badge tone={TONE[r.kind] ?? "neutral"}>
                  {ALERT_KIND_LABELS[r.kind] ?? r.kind}
                </Badge>
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-sm",
                    r.read_at === null ? "font-semibold" : "font-medium text-text-2",
                  )}
                >
                  {r.title}
                </span>
                {r.body ? (
                  <span className="block truncate text-xs text-muted">{r.body}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-right text-xs text-muted tabular-nums">
                {when(r.created_at, timezone)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
