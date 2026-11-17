"use client";

import { startTransition, useOptimistic, useState } from "react";
import { seedStipsAction, setStipAction } from "@/app/actions";
import type { StipRow } from "@/lib/data/types";
import { stipLabel } from "@/lib/mca/stips";
import { Button, cn, Meter } from "../ui";
import { Icon } from "./icons";
import { rollupOf, setStipReceived, splitStips } from "./logic";
import { Muted, Panel, useRun } from "./parts";
import { Label } from "./primitives";

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
      <Panel title="Stips" icon="check" className={className}>
        <p className="text-sm text-muted">
          Stips are the documents underwriting asks for: statements, ID, a voided check.
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
      icon="check"
      className={className}
      aside={
        <span className="text-xs font-medium text-text-2 tabular-nums">
          {roll.requiredReceived} of {roll.requiredTotal} required
        </span>
      }
    >
      <Meter
        label="Required documents received"
        value={roll.requiredReceived}
        max={roll.requiredTotal}
        tone={roll.ready ? "good" : "brand"}
      />
      {roll.ready ? (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-good-soft px-3 py-2 text-[13px] font-semibold text-good">
          <Icon name="check" className="mt-0.5 size-3.5" />
          Ready to submit. Every required document is in.
        </p>
      ) : (
        <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <strong>Missing:</strong> {roll.missing.join(", ")}
        </p>
      )}
      <div className="mt-2">
        <Checklist items={required} onToggle={toggle} />
      </div>
      {optional.length > 0 ? (
        <>
          <Label className="mt-4 mb-1 px-2">Also useful</Label>
          <Checklist items={optional} onToggle={toggle} />
        </>
      ) : null}
      <Muted className="mt-3 px-2">
        Tick what you have received. Files the merchant uploads tick themselves.
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
    <ul className="-mx-2">
      {items.map((s) => {
        const got = s.received_at !== null;
        return (
          <li key={s.id}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 transition duration-150 hover:bg-surface-2/60 sm:min-h-9">
              <input
                type="checkbox"
                className="size-4 shrink-0 rounded accent-accent"
                checked={got}
                onChange={(e) => onToggle(s, e.target.checked)}
              />
              <span className={cn("text-[13px]", got ? "text-muted" : "font-medium text-text")}>
                {stipLabel(s)}
              </span>
              {got ? <Icon name="check" className="ml-auto size-3.5 text-good" /> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
