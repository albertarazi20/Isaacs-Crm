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
          {rows.length}
        </Badge>
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">Empty.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border text-[13px]">
          {rows.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 px-4 py-2 transition hover:bg-surface-3"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{s.display ?? "(address purged)"}</span>
                <span className="text-muted">
                  {" "}
                  · {s.reason.replace(/_/g, " ")}
                  {s.business_name ? ` · ${s.business_name}` : ""} ·{" "}
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
