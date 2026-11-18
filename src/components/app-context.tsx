"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { todayIn, type ISODate } from "@/lib/mca/dates";

export interface AppInfo {
  /** Isaac's calendar day — never compute "today" in the browser, the server's is the truth. */
  today: ISODate;
  timezone: string;
  senderName: string;
  gmailConnected: boolean;
  gmailNeedsReconnect: boolean;
  /** Starred merchants: pinned to the top of Today. Kept on the server so they follow him from device to device. */
  hotIds: readonly string[];
  /** Server's clock at render. Relative times (\"5 min ago\") must use this, or server and browser disagree and React logs a hydration mismatch. */
  nowMs: number;
}

const AppContext = createContext<AppInfo | null>(null);

/** How often a tab left open re-reads the clock. */
const TICK_MS = 30_000;

/**
 * The server's clock moved forward by the time this tab has been running: `serverNowMs` was read at render, when the
 * browser's own clock read `clientAtRenderMs`. Anchoring on the server's reading (not the browser's date) keeps a
 * wrong device clock from changing what "now" means.
 */
export function advancedNow(serverNowMs: number, clientAtRenderMs: number, clientNowMs: number) {
  return serverNowMs + Math.max(0, clientNowMs - clientAtRenderMs);
}

/** True when the calendar day in `timezone` is no longer the `today` the layout was rendered with. */
export function dayHasPassed(today: ISODate, timezone: string, nowMs: number): boolean {
  return todayIn(timezone, new Date(nowMs)) > today;
}

/**
 * The (app) layout stays mounted across navigations, so its `today` and `nowMs` are as old as the last time the server
 * rendered it. In a tab left open all day that freezes "x ago" badges and the time picker's "already past" slots, and
 * after midnight every "today" preset is yesterday. So the clock here keeps running from the server's reading, and when
 * the day changes the layout is re-fetched for the new `today`.
 */
export function AppProvider({ value, children }: { value: AppInfo; children: ReactNode }) {
  const router = useRouter();
  const { today, timezone, nowMs: renderedNowMs } = value;
  const [advanced, setAdvanced] = useState<{ from: number; nowMs: number }>({
    from: renderedNowMs,
    nowMs: renderedNowMs,
  });
  // a fresh render from the server restarts the clock from its reading
  const nowMs = advanced.from === renderedNowMs ? advanced.nowMs : renderedNowMs;

  useEffect(() => {
    const clientAtRender = Date.now();
    const tick = () => {
      const now = advancedNow(renderedNowMs, clientAtRender, Date.now());
      setAdvanced({ from: renderedNowMs, nowMs: now });
      if (dayHasPassed(today, timezone, now)) router.refresh();
    };
    const timer = window.setInterval(tick, TICK_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [renderedNowMs, today, timezone, router]);

  const live = useMemo(() => ({ ...value, nowMs }), [value, nowMs]);
  return <AppContext.Provider value={live}>{children}</AppContext.Provider>;
}

export function useApp(): AppInfo {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp must be used inside the (app) layout");
  return v;
}
