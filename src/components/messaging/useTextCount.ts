"use client";

import { useSyncExternalStore } from "react";
import { bumpTextCount, readTextCount, type CounterStorage } from "@/lib/messaging/textCounter";

const EVENT = "isaac:text-count";

function storage(): CounterStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Texts counted today in this browser. 0 on the server and before hydration, so nothing mismatches. */
export function useTextCount(today: string): number {
  return useSyncExternalStore(
    subscribe,
    () => readTextCount(storage(), today),
    () => 0,
  );
}

/** One more text sent today (the "I sent it" tap). */
export function recordTextSent(today: string): number {
  const n = bumpTextCount(storage(), today);
  window.dispatchEvent(new Event(EVENT));
  return n;
}
