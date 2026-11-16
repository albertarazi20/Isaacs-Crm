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
        className="-my-1 inline-flex min-h-8 items-center rounded-md px-1 text-xs font-medium whitespace-nowrap text-accent transition hover:bg-accent-soft"
        title={`Set this month's goal for ${label === "shop" ? "the shop" : label}`}
      >
        {fundedCents > 0
          ? `Goal ${formatMoneyCompact(fundedCents)} · edit`
          : `Set a goal for ${label === "shop" ? "the shop" : label}`}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
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
        className="h-9 w-28 text-sm tabular-nums sm:h-8 sm:text-[13px]"
        autoFocus
      />
      <Button type="submit" variant="primary" size="sm" disabled={busy}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}
