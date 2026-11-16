"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { closeMonthAction } from "@/app/money-actions";
import { useRun } from "@/components/client/parts";
import { Button } from "@/components/ui";

/** A manager closes a past month by hand: its lines lock and every person's statement is built. Safe to repeat. */
export function CloseMonthButton({ period, label }: { period: string; label: string }) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      aria-label={`Close ${label}`}
      onClick={async () => {
        setBusy(true);
        const ok = await run(closeMonthAction({ period }), `${label} closed`);
        setBusy(false);
        if (ok) router.refresh();
      }}
    >
      {busy ? "Closing…" : "Close month"}
    </Button>
  );
}
