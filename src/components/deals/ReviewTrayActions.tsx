"use client";

import { useState } from "react";
import { markAlertsReadAction } from "@/app/alerts-actions";
import { revertAiUpdateAction, sendChaseDraftAction } from "@/app/inbox-actions";
import { copyText, useRun } from "@/components/client/parts";
import { Icon } from "@/components/deals/primitives";
import { QuietConfirm } from "@/components/funders/QuietConfirm";
import { useToast } from "@/components/overlay";
import { Button } from "@/components/ui";

/** A manager puts a lender row back to what it was before the AI changed it. Two clicks: it can remove an offer. */
export function UndoAiUpdate({ id, removesOffer }: { id: string; removesOffer: boolean }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <span className="text-xs text-muted">Undone</span>;
  return (
    <span className="flex flex-col items-start gap-0.5 sm:items-end">
      <QuietConfirm
        label="Undo"
        confirmLabel="Click again to undo"
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          const ok = await run(
            revertAiUpdateAction({ id }),
            "Undone — the lender row is back to what it was",
          );
          setBusy(false);
          if (ok) setDone(true);
        }}
      />
      {removesOffer ? (
        <span className="text-[11px] text-muted">Also removes the offer it added</span>
      ) : null}
    </span>
  );
}

/**
 * One drafted chase: Send puts it on the lender's thread, Copy is for when it has to go from your own mail, Dismiss
 * clears it. An answered lender can only be dismissed.
 */
export function ChaseDraftActions({
  alertId,
  moot,
  canSend,
  copyBody,
}: {
  alertId: string;
  moot: boolean;
  canSend: boolean;
  /** To, subject and the nudge as one block, for Copy. */
  copyBody: string;
}) {
  const run = useRun();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"sent" | "dismissed" | null>(null);
  if (done)
    return <span className="text-xs text-muted">{done === "sent" ? "Sent" : "Dismissed"}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {!moot && canSend ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await sendChaseDraftAction({ alertId });
            setBusy(false);
            if (!r.ok) return toast({ message: r.error, tone: "error" });
            toast({ message: `Chase sent to ${r.data.funderName}`, tone: "success" });
            setDone("sent");
          }}
        >
          <Icon name="send" className="size-3.5 text-muted" />
          Send
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          const ok = await copyText(copyBody);
          toast(
            ok
              ? { message: "Chase copied — paste it into your email", tone: "success" }
              : { message: "Couldn't copy — select the text and press Ctrl+C", tone: "error" },
          );
        }}
      >
        <Icon name="copy" className="size-3.5 text-muted" />
        Copy
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const ok = await run(markAlertsReadAction({ ids: [alertId] }), "Draft dismissed");
          setBusy(false);
          if (ok) setDone("dismissed");
        }}
      >
        Dismiss
      </Button>
    </span>
  );
}
