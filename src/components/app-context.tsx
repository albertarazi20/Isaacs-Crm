"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ISODate } from "@/lib/mca/dates";

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

export function AppProvider({ value, children }: { value: AppInfo; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppInfo {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp must be used inside the (app) layout");
  return v;
}
