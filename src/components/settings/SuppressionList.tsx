"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteSuppressionAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { useRun } from "@/components/client/parts";
import { Button, Card, SectionTitle } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import type { SuppressionRow } from "@/lib/settings/queries";

export function SuppressionList({ rows }: { rows: SuppressionRow[] }) {
  const { nowMs } = useApp();
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <SectionTitle aside={<span className="text-xs text-muted">{rows.length}</span>}>
          Do-not-email list
        </SectionTitle>
        <p className="mt-1 text-xs text-muted">
          Unsubscribes, hard bounces, complaints and STOP replies. The engine checks it right before
          every send. Remove one only when the person asked.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-muted">Empty.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-sm">
          {rows.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2">
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
    </Card>
  );
}
