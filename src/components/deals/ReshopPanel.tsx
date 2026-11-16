"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startReshopAction } from "@/app/deals-actions";
import { Icon } from "@/components/deals/primitives";
import { Dialog, useCall } from "@/components/overlay";
import { Badge, Button, Card, SectionTitle } from "@/components/ui";
import type { ReshopCandidate } from "@/lib/deals/reshop";

/**
 * Every lender declined (S2-10). Lists the lenders whose rules fit this merchant and who have not seen the file on
 * any deal, and offers the one-click reshop: the declined deal closes, a new one opens with the same ask, and the
 * merchant is asked for the newest statement. A confirm first, because it closes a deal. Reps and managers only.
 */
export function ReshopPanel({
  clientId,
  dealNumber,
  candidates,
  canStart,
}: {
  clientId: string;
  dealNumber: number;
  candidates: ReshopCandidate[];
  canStart: boolean;
}) {
  const call = useCall();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const r = await call(startReshopAction({ clientId }), "Reshop started — the new deal is open");
    setBusy(false);
    if (!r) return;
    setOpen(false);
    router.push(`/deals/${r.id}`);
  }

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle
        aside={
          canStart ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Icon name="refresh" className="size-3.5 text-muted" />
              Start reshop
            </Button>
          ) : (
            <span className="text-xs text-muted">A rep or manager starts it</span>
          )
        }
      >
        Reshop
      </SectionTitle>
      <p className="mt-1 text-xs text-muted">
        Every lender declined D-{dealNumber}. These lenders fit this merchant and have not seen the
        file.
      </p>
      {candidates.length === 0 ? (
        <p className="mt-3 text-sm text-text-2">
          No other lender fits. Check the Funders list, or move the merchant to win-back.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {candidates.map((c) => (
            <li
              key={c.funderId}
              data-reshop-candidate={c.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 basis-40 truncate font-medium">{c.name}</span>
              <Badge tone={c.fit.level === "fits" ? "good" : "warn"}>
                {c.fit.level === "fits" ? "Fits" : "Check"}
              </Badge>
              {c.fit.unknown.length > 0 ? (
                <span className="text-xs text-muted">
                  Not entered yet: {c.fit.unknown.join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Start reshop?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void start()}>
              {busy ? "Starting…" : "Start reshop"}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          This closes D-{dealNumber} as declined and opens a new deal with the same ask. The
          merchant is asked for the newest statement before any lender sees the file again.
        </p>
        <p className="mt-2 text-xs text-muted">
          {candidates.length === 0
            ? "No lender fits right now; the new deal starts with an empty list."
            : `${candidates.length} ${candidates.length === 1 ? "lender fits" : "lenders fit"}, listed on the new deal's page.`}
        </p>
      </Dialog>
    </Card>
  );
}
