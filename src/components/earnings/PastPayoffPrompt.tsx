"use client";

import Link from "next/link";
import { useState } from "react";
import { moveClientAction } from "@/app/actions";
import { formatDate } from "@/lib/format";
import type { PastPayoffRow } from "@/lib/earnings/radar";
import { factorInput } from "@/lib/earnings/terms";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { useCall, useToast } from "../overlay";
import { ICON, Icon } from "../settings/primitives";
import { Button } from "../ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function when(row: PastPayoffRow, today: string): string {
  if (row.payoffOn === null) return "marked as fully collected";
  if (row.daysPast === 0) return `estimated payoff today (${formatDate(row.payoffOn, today)})`;
  return `estimated payoff ${formatDate(row.payoffOn, today)} · ${plural(row.daysPast ?? 0, "day")} ago`;
}

/**
 * Advances whose last remittance is behind us but that still say Funded. The move is the app's own Paid in full
 * move (moveClientAction), so the advance is marked paid off and the 14-day timer is set exactly as elsewhere.
 */
export function PastPayoffPrompt({ rows }: { rows: PastPayoffRow[] }) {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [busy, setBusy] = useState<string | "all" | null>(null);
  if (rows.length === 0) return null;

  async function moveOne(r: PastPayoffRow) {
    setBusy(r.card.id);
    await call(
      moveClientAction({ clientId: r.card.id, stage: "paid_in_full" }),
      `${r.card.business_name} moved to Paid in full`,
    );
    setBusy(null);
  }

  async function moveAll() {
    setBusy("all");
    let moved = 0;
    for (const r of rows) {
      const card = await call(moveClientAction({ clientId: r.card.id, stage: "paid_in_full" }));
      if (card) moved += 1;
    }
    setBusy(null);
    if (moved === rows.length) {
      toast({ message: `Moved ${plural(moved, "merchant")} to Paid in full`, tone: "success" });
    }
  }

  return (
    <section
      aria-label="Advances past their estimated payoff"
      className="min-w-0 rounded-xl border border-warn/40 bg-surface p-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5 pb-3">
        <h2 className="flex items-start gap-2 text-[13px] font-semibold">
          <Icon d={ICON.alert} className="mt-px text-warn" />
          <span>
            {plural(rows.length, "advance")} {rows.length === 1 ? "is" : "are"} past{" "}
            {rows.length === 1 ? "its" : "their"} estimated payoff — move to Paid in full?
          </span>
        </h2>
        {rows.length > 1 ? (
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void moveAll()}
          >
            {busy === "all" ? "Moving…" : `Move all ${rows.length}`}
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {rows.map((r) => (
          <li
            key={r.card.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/clients/${r.card.id}`}
                className="block truncate text-sm font-semibold hover:underline"
              >
                {r.card.business_name}
              </Link>
              <p className="truncate text-xs text-muted">
                {formatMoney(r.advance.amountCents)} at {factorInput(r.advance.factorRate)} ·{" "}
                {when(r, today)}
              </p>
            </div>
            <Button size="sm" disabled={busy !== null} onClick={() => void moveOne(r)}>
              {busy === r.card.id ? "Moving…" : "Move to Paid in full"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
