"use client";

import { useState } from "react";
import { setGoalAction } from "@/app/dashboard-actions";
import { useRun } from "@/components/client/parts";
import { Button, Input } from "@/components/ui";
import { formatMoneyCompact } from "@/lib/money";

/** Managers type the month's target; everyone else just sees the bar. */
export function GoalEditor({
  month,
  userId,
  fundedCents,
  label,
}: {
  month: string;
  userId: string | null;
  fundedCents: number;
  label: string;
}) {
  const run = useRun();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fundedCents ? String(Math.round(fundedCents / 100)) : "");
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs font-medium text-accent hover:underline"
        title={`Set the ${label} goal for this month`}
      >
        {fundedCents > 0 ? `Goal ${formatMoneyCompact(fundedCents)} · edit` : `Set a ${label} goal`}
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await run(
          setGoalAction({ userId, month, fundedAmount: value || "0", deals: 0 }),
          "Goal saved",
        );
        setBusy(false);
        if (ok) setEditing(false);
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`${label} goal for this month`}
        placeholder="250k"
        className="h-8 w-28 text-sm"
        autoFocus
      />
      <Button type="submit" variant="primary" size="sm" disabled={busy}>
        Save
      </Button>
      <Button size="sm" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}
