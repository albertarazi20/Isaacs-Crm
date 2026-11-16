"use client";

import { startTransition, useOptimistic, useState } from "react";
import { seedStipsAction, setStipAction } from "@/app/actions";
import type { StipRow } from "@/lib/data/types";
import { stipLabel } from "@/lib/mca/stips";
import { Button, cn } from "../ui";
import { rollupOf, setStipReceived, splitStips } from "./logic";
import { Muted, Panel, useRun } from "./parts";

interface Flip {
  id: string;
  received: boolean;
  at: string;
}

export function StipsCard({
  clientId,
  stips,
  className,
}: {
  clientId: string;
  stips: StipRow[];
  className?: string;
}) {
  const run = useRun();
  const [starting, setStarting] = useState(false);
  // Shows the tick instantly; reverts by itself if the save fails (the props never changed).
  const [shown, flip] = useOptimistic(stips, (cur, f: Flip) =>
    setStipReceived(cur, f.id, f.received, f.at),
  );

  async function start() {
    setStarting(true);
    await run(seedStipsAction({ clientId }), "Checklist started");
    setStarting(false);
  }

  function toggle(s: StipRow, received: boolean) {
    startTransition(async () => {
      flip({ id: s.id, received, at: new Date().toISOString() });
      await run(setStipAction({ stipId: s.id, received }));
    });
  }

  if (shown.length === 0) {
    return (
      <Panel title="Stips" className={className}>
        <p className="text-sm text-muted">
          Stips are the documents underwriting asks for — statements, ID, a voided check.
        </p>
        <Button className="mt-3" disabled={starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Start the checklist"}
        </Button>
      </Panel>
    );
  }

  const roll = rollupOf(shown);
  const { required, optional } = splitStips(shown);

  return (
    <Panel
      title="Stips"
      className={className}
      aside={
        <span className="text-sm font-medium">
          {roll.requiredReceived} of {roll.requiredTotal} required
        </span>
      }
    >
      {roll.ready ? (
        <p className="mb-3 rounded-lg border border-good/30 bg-good-soft p-3 text-sm font-semibold text-good">
          Ready to submit — every required document is in.
        </p>
      ) : (
        <p className="mb-3 rounded-lg border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
          <strong>Missing:</strong> {roll.missing.join(", ")}
        </p>
      )}
      <Checklist items={required} onToggle={toggle} />
      {optional.length > 0 ? (
        <>
          <p className="mt-3 mb-1 text-[12px] font-medium text-text-2">When the funder asks</p>
          <Checklist items={optional} onToggle={toggle} />
        </>
      ) : null}
      <Muted className="mt-3">
        Document uploads aren&apos;t built yet — these are checkmarks for what you&apos;ve received.
      </Muted>
    </Panel>
  );
}

function Checklist({
  items,
  onToggle,
}: {
  items: StipRow[];
  onToggle: (s: StipRow, received: boolean) => void;
}) {
  return (
    <ul>
      {items.map((s) => {
        const got = s.received_at !== null;
        return (
          <li key={s.id}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 transition hover:bg-surface-2 sm:min-h-9">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-accent"
                checked={got}
                onChange={(e) => onToggle(s, e.target.checked)}
              />
              <span className={cn("text-sm", got && "text-muted line-through")}>
                {stipLabel(s)}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
