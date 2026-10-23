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
        className="ml-1 inline-flex size-4 items-center justify-center rounded-full border border-border text-[10px] leading-none font-semibold text-muted hover:text-text"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute inset-x-3 top-full z-30 mt-1 rounded-lg border border-border bg-surface p-2.5 text-xs font-normal tracking-normal text-text normal-case shadow-lg group-focus-within:visible group-hover:visible"
      >
        {children}
      </span>
    </span>
  );
}

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
    <div className={cn("relative rounded-xl border border-border bg-surface p-4", className)}>
      <p className="flex items-center text-xs font-medium text-muted">
        {label}
        {estimate ? (
          <span className="ml-1.5 rounded bg-warn-soft px-1 py-px text-[10px] font-semibold text-warn uppercase">
            estimate
          </span>
        ) : null}
        {tip ? (
          <InfoTip label={tipLabel ?? `How ${label.toLowerCase()} is worked out`}>{tip}</InfoTip>
        ) : null}
      </p>
      <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums">{value}</p>
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
        className="text-muted"
        title="Enter a commission on an advance (Update on the client's Funding card) and Isaac can estimate the rest"
      >
        {none}
      </span>
    );
  }
  return (
    <span title={commissionNote(value, average, amountCents)}>
      {value.basis === "entered" ? "" : "~"}
      {formatMoney(value.cents)}
      {value.basis === "entered" ? null : (
        <span className="ml-1 text-[10px] font-semibold text-warn uppercase">est.</span>
      )}
    </span>
  );
}
