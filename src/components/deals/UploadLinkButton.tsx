"use client";

import { useState } from "react";
import { mintUploadLinkAction } from "@/app/docs-actions";
import { copyText } from "@/components/client/parts";
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
