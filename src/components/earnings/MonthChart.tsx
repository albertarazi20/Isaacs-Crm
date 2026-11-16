"use client";

import { useEffect, useRef, useState } from "react";
import { monthLabel, type MonthRow } from "@/lib/earnings/earned";
import { formatMoney, formatMoneyCompact } from "@/lib/money";

const H = 240;
const PAD = { left: 46, right: 8, top: 26, bottom: 34 };
const DEFAULT_W = 720;
const MAX_BAR = 24;

/**
 * Gridlines at round numbers: a step of 1, 2 or 5 × a power of ten, four or fewer intervals, top of the scale
 * at or above the biggest bar. 3,000 → 0, 1k, 2k, 3k (not 1.3k, 2.5k, 3.8k).
 */
export function niceScale(v: number): { step: number; max: number } {
  if (v <= 0) return { step: 1, max: 1 };
  const raw = v / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].map((m) => m * pow).find((c) => c >= raw) ?? 10 * pow) as number;
  return { step, max: step * Math.ceil(v / step) };
}

/** A column with a 4px rounded top and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

/**
 * Commission received, month by month — one series, so no legend: the title says what it is. Every figure the chart
 * hides (small bars, the months that are not labelled) is in the table under it and in the hover/focus tooltip.
 */
export function MonthChart({ months }: { months: readonly MonthRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the width it is shown at, so the text stays 11px on a phone and a bar stays 24px on a wide screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w >= 240) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { step, max } = niceScale(Math.max(...months.map((m) => m.commissionCents), 0));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, months.length);
  const bar = Math.min(MAX_BAR, slot * 0.6);
  const base = PAD.top + plotH;
  const y = (cents: number) => base - (cents / max) * plotH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const biggest = months.reduce(
    (best, m, i) => (m.commissionCents > (months[best]?.commissionCents ?? 0) ? i : best),
    0,
  );
  const labelled = new Set([months.length - 1, biggest]);
  const active = hover === null ? null : (months[hover] ?? null);
  const cx = (i: number) => PAD.left + slot * i + slot / 2;

  return (
    <div className="relative" ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full"
        role="group"
        aria-label="Commission received per month, last 12 months. The same figures are in the table below."
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--muted)"
              className="tabular-nums"
            >
              {formatMoneyCompact(t)}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const x = cx(i) - bar / 2;
          const top = y(m.commissionCents);
          const dim = hover !== null && hover !== i;
          return (
            <g key={m.key}>
              {m.commissionCents > 0 ? (
                <path
                  d={barPath(x, top, bar, base)}
                  fill="var(--accent)"
                  opacity={dim ? 0.45 : 1}
                  style={{ transition: "opacity 120ms" }}
                />
              ) : null}
              {labelled.has(i) && m.commissionCents > 0 ? (
                <text
                  x={cx(i)}
                  y={top - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--text)"
                  className="tabular-nums"
                >
                  {formatMoneyCompact(m.commissionCents)}
                </text>
              ) : null}
              <text x={cx(i)} y={base + 15} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {monthLabel(m.key, true)}
              </text>
              {i === 0 || m.key.endsWith("-01") ? (
                <text x={cx(i)} y={base + 28} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {m.key.slice(0, 4)}
                </text>
              ) : null}
              {/* the hit area is the whole column slot, far bigger than the bar */}
              <rect
                x={PAD.left + slot * i}
                y={PAD.top}
                width={slot}
                height={plotH + 18}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${m.label}: ${formatMoney(m.commissionCents)} commission received from ${m.commissionCount} advance${m.commissionCount === 1 ? "" : "s"}; ${m.fundedCount} funded for ${formatMoney(m.fundedCents)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {active && hover !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-44 rounded-lg border border-border bg-surface px-2.5 py-2 text-xs shadow-pop"
          style={{
            left: `${Math.min(88, Math.max(12, (cx(hover) / W) * 100))}%`,
            top: `${(Math.max(PAD.top, y(active.commissionCents)) / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 8px))",
          }}
        >
          <p className="text-muted">{active.label}</p>
          <p className="text-base font-semibold tabular-nums">
            {formatMoney(active.commissionCents)}
          </p>
          <p className="text-muted">
            from {active.commissionCount} advance{active.commissionCount === 1 ? "" : "s"}
          </p>
          <p className="text-muted">
            {active.fundedCount} funded · {formatMoney(active.fundedCents)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
