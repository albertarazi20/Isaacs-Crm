import type { ReactNode } from "react";
import {
  commissionNote,
  type AveragePoints,
  type CommissionAmount,
} from "@/lib/earnings/commission";
import { formatMoney } from "@/lib/money";
import { cn } from "../ui";

/**
 * A small "i" that explains a number on hover or keyboard focus. The bubble is positioned against the nearest
 * `relative` ancestor (the tile), not the icon, so it can never run off the edge of a phone screen.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        className="ml-1 inline-flex size-5 items-center justify-center rounded-full border border-border text-[10px] leading-none font-semibold text-muted transition hover:border-border-strong hover:text-text sm:size-4"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute inset-x-3 top-full z-30 mt-1 rounded-lg border border-border bg-surface p-2.5 text-xs font-normal tracking-normal text-text normal-case shadow-pop group-focus-within:visible group-hover:visible"
      >
        {children}
      </span>
    </span>
  );
}

/** A KPI tile: label over the number, a note under it, and an "estimate" mark when the figure is worked out. */
export function Tile({
  label,
  value,
  note,
  tip,
  tipLabel,
  estimate,
  className,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  tip?: ReactNode;
  tipLabel?: string;
  estimate?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative min-w-0 rounded-xl border border-border bg-surface px-4 py-3.5",
        className,
      )}
    >
      <p className="flex min-w-0 items-center text-[11px] font-semibold tracking-wide text-muted uppercase">
        <span className="truncate">{label}</span>
        {estimate ? (
          <span className="ml-1.5 shrink-0 rounded-md bg-warn-soft px-1.5 py-px text-[10px] font-semibold text-warn">
            estimate
          </span>
        ) : null}
        {tip ? (
          <InfoTip label={tipLabel ?? `How ${label.toLowerCase()} is worked out`}>{tip}</InfoTip>
        ) : null}
      </p>
      <p className="mt-1 truncate text-[26px] leading-8 font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {note ? <p className="mt-0.5 text-xs text-muted">{note}</p> : null}
    </div>
  );
}

/** "$2,500", with "est." and the formula in a tooltip when it is not a figure he entered. */
export function Commission({
  value,
  average,
  amountCents,
  none = "Not priced yet",
}: {
  value: CommissionAmount | null;
  average: AveragePoints | null;
  amountCents?: number;
  none?: string;
}) {
  if (!value) {
    return (
      <span
        className="font-normal text-muted"
        title="Enter a commission on an advance (Update on the client's Funding card) and the CRM estimates the rest"
      >
        {none}
      </span>
    );
  }
  return (
    <span className="tabular-nums" title={commissionNote(value, average, amountCents)}>
      {value.basis === "entered" ? "" : "~"}
      {formatMoney(value.cents)}
      {value.basis === "entered" ? null : (
        <span className="ml-1 text-[10px] font-semibold text-warn uppercase">est.</span>
      )}
    </span>
  );
}
