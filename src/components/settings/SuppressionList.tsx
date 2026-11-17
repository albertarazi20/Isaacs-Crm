"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteSuppressionAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { useRun } from "@/components/client/parts";
import { Badge, Button } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import type { SuppressionRow } from "@/lib/settings/queries";
import { SettingsCard } from "./primitives";

export function SuppressionList({ rows }: { rows: SuppressionRow[] }) {
  const { nowMs } = useApp();
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <SettingsCard
      title="Do-not-email list"
      description="Unsubscribes, hard bounces, complaints and STOP replies. The engine checks it right before every send. Remove one only when the person asked."
      aside={
        <Badge tone="neutral" className="tabular-nums">
          {rows.length} {rows.length === 1 ? "address" : "addresses"}
        </Badge>
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted sm:px-5">
          Nobody is on the list. Unsubscribes and bounces land here on their own.
        </p>
      ) : (
        <ul className="max-h-[26rem] divide-y divide-border overflow-y-auto text-[13px]">
          {rows.map((s) => (
            <li
              key={s.id}
              className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/50 sm:px-5"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{s.display ?? "(address purged)"}</span>
                  <Badge tone={s.reason.includes("complaint") ? "bad" : "neutral"}>
                    {s.reason.replace(/_/g, " ")}
                  </Badge>
                </span>
                <span className="block truncate text-xs text-muted">
                  {s.business_name ? `${s.business_name} · ` : ""}
                  {timeAgo(s.created_at, new Date(nowMs))}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Remove from the do-not-email list? Only if they asked to hear from you again.",
                    )
                  )
                    return;
                  setBusy(true);
                  const ok = await run(deleteSuppressionAction({ suppressionId: s.id }), "Removed");
                  setBusy(false);
                  if (ok) router.refresh();
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
