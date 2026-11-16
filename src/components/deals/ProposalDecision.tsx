"use client";

import { useState } from "react";
import { decideProposedAction } from "@/app/inbox-actions";
import { useRun } from "@/components/client/parts";
import { Button } from "@/components/ui";

/** A manager accepts or rejects what the AI read from a lender email. Money never lands without this. */
export function ProposalDecision({ id }: { id: string }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"apply" | "reject" | null>(null);
  if (done)
    return <span className="text-xs text-muted">{done === "apply" ? "Applied" : "Rejected"}</span>;
  const decide = async (decision: "apply" | "reject") => {
    setBusy(true);
    const ok = await run(
      decideProposedAction({ id, decision }),
      decision === "apply" ? "Applied" : "Rejected",
    );
    setBusy(false);
    if (ok) setDone(decision);
  };
  return (
    <span className="flex gap-1.5">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("apply")}>
        Accept
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("reject")}>
        Reject
      </Button>
    </span>
  );
}
