"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mintUploadLinkAction, rotateUploadTokenAction } from "@/app/docs-actions";
import { copyText, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button } from "@/components/ui";

/** Mints a two-hour upload link for the merchant and puts it on the clipboard. */
export function UploadLinkButton({
  clientId,
  dealId,
  size = "sm",
}: {
  clientId: string;
  dealId?: string | null;
  size?: "sm" | "md";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await mintUploadLinkAction({ clientId, dealId: dealId ?? null });
        setBusy(false);
        if (!r.ok) {
          toast({ message: r.error, tone: "error" });
          return;
        }
        const copied = await copyText(r.data.url);
        toast({
          message: copied ? "Upload link copied — good for 2 hours" : r.data.url,
          tone: copied ? "success" : "info",
        });
      }}
    >
      {busy ? "…" : "Copy upload link"}
    </Button>
  );
}

/**
 * Kills the merchant's permanent upload link (the one every email carries) and issues a new one (P2-29).
 * Two clicks, so a stray tap does nothing.
 */
export function ResetUploadLinkButton({ clientId }: { clientId: string }) {
  const run = useRun();
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      title="The link in past emails stops working; the next email carries the new one"
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
          return;
        }
        setArmed(false);
        setBusy(true);
        const ok = await run(
          rotateUploadTokenAction({ clientId }),
          "Upload link reset — the old one no longer works",
        );
        setBusy(false);
        if (ok) router.refresh();
      }}
    >
      {armed ? "Click again to reset" : "Reset upload link"}
    </Button>
  );
}
