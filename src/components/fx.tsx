"use client";

import { useEffect, useRef } from "react";
import { cn } from "./ui";

const fmt = (n: number, decimals: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** The number as written on the page. */
export const formatCount = (n: number, decimals: number, prefix = "", suffix = "") =>
  `${prefix}${fmt(n, decimals)}${suffix}`;

/** What startCountUp needs from the page, so the animation can be tried without a browser. */
export interface CountUpEnv {
  now: () => number;
  raf: (cb: (t: number) => void) => number;
  cancel: (id: number) => void;
  reducedMotion: boolean;
}

/**
 * Write `value` into the element: straight away when it is 0 or motion is reduced, otherwise counted up over 900 ms.
 * The element's text is always written, even for 0: after the first frame the text nodes React rendered are no longer
 * in the page, so React's own update would never show and an older number would stay on screen. Returns a cancel.
 */
export function startCountUp(
  el: { textContent: string | null },
  value: number,
  decimals: number,
  prefix: string,
  suffix: string,
  env: CountUpEnv,
): () => void {
  const final = formatCount(value, decimals, prefix, suffix);
  if (value === 0 || env.reducedMotion) {
    el.textContent = final;
    return () => undefined;
  }
  const started = env.now();
  const duration = 900;
  let raf = 0;
  const tick = (now: number) => {
    const p = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = p < 1 ? formatCount(value * eased, decimals, prefix, suffix) : final;
    if (p < 1) raf = env.raf(tick);
  };
  raf = env.raf(tick);
  return () => env.cancel(raf);
}

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
    if (!el) return;
    return startCountUp(el, value, decimals, prefix, suffix, {
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  }, [value, decimals, prefix, suffix]);
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {formatCount(value, decimals, prefix, suffix)}
    </span>
  );
}
