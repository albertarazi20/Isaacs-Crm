"use client";

import { useEffect, useRef } from "react";
import { cn } from "./ui";

const fmt = (n: number, decimals: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * A number that counts up to its value when it appears. The server renders the real figure (so it is right without
 * script and for a screen reader); the browser then runs the count by writing the text, never through React state.
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || value === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const final = `${prefix}${fmt(value, decimals)}${suffix}`;
    const started = performance.now();
    const duration = 900;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = p < 1 ? `${prefix}${fmt(value * eased, decimals)}${suffix}` : final;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = final;
    };
  }, [value, decimals, prefix, suffix]);
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {prefix}
      {fmt(value, decimals)}
      {suffix}
    </span>
  );
}
