"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { confirmFundingAction } from "@/app/money-actions";
import { useRun } from "@/components/client/parts";
import { Button } from "@/components/ui";

/** The manager's half of FUND: the commission posts to the ledger only here. */
export function ConfirmFundingButton({ fundingId }: { fundingId: string }) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      className="bg-good text-white hover:brightness-110"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const ok = await run(
          confirmFundingAction({ fundingId }),
          "Confirmed — the commission is on the ledger",
        );
        setBusy(false);
        if (ok) router.refresh();
      }}
    >
      {busy ? "Confirming…" : "Confirm funding"}
    </Button>
  );
}
