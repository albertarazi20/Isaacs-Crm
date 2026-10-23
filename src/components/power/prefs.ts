"use client";

import { useMemo, useSyncExternalStore } from "react";
import { importHotAction, setHotAction } from "@/app/power-actions";
import type { SortMode } from "@/lib/data/priority";
import { useApp } from "../app-context";

/**
 * One small per-browser preference: how Today is ordered. (Stars used to be here too; they live on the merchant now.)
 * Stored in localStorage under `isaac:` (log out clears them) but never required: every read and write is
 * guarded, and an in-memory copy keeps the buttons working when storage is blocked (private mode).
 */

const SORT_KEY = "isaac:today-sort";
const HOT_KEY = "isaac:hot";

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the in-memory copy still serves this tab */
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab wrote (or storage was cleared): our in-memory copy is stale.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== SORT_KEY && e.key !== HOT_KEY) return;
    memory.delete(SORT_KEY);
    memory.delete(HOT_KEY);
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The server renders "biggest first"; a remembered "oldest first" applies right after hydration. */
export function useSortMode(): [SortMode, (m: SortMode) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(SORT_KEY),
    () => null,
  );
  const mode: SortMode = raw === "oldest" ? "oldest" : "biggest";
  return [mode, (m) => write(SORT_KEY, m)];
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Stars live on the merchant (clients.hot), so they follow him from device to device. The page gets the starred ids from
// the server; a tap shows at once through `taps` and is sent in the background. A tap is dropped when the server has
// answered, by which time the refreshed page carries the real list.

const taps = new Map<string, boolean>();
const tapListeners = new Set<() => void>();
let tapsKey = "[]";
const changed = () => {
  tapsKey = JSON.stringify([...taps]);
  tapListeners.forEach((l) => l());
};
const subscribeTaps = (onChange: () => void) => {
  tapListeners.add(onChange);
  return () => {
    tapListeners.delete(onChange);
  };
};

/** The server's starred ids, with any tap that has not been answered yet laid over them. */
export function mergeHot(
  server: readonly string[],
  pendingTaps: ReadonlyMap<string, boolean> | readonly (readonly [string, boolean])[],
): ReadonlySet<string> {
  const out = new Set(server);
  for (const [id, on] of pendingTaps) {
    if (on) out.add(id);
    else out.delete(id);
  }
  return out;
}

/** Starred clients. A fresh Set only when the server's list or a pending tap changes. */
export function useHotIds(): ReadonlySet<string> {
  const { hotIds } = useApp();
  const key = useSyncExternalStore(
    subscribeTaps,
    () => tapsKey,
    () => "[]",
  );
  return useMemo(() => mergeHot(hotIds, JSON.parse(key) as [string, boolean][]), [hotIds, key]);
}

/** Star or unstar. Shows at once; the server keeps it, so every device agrees. */
export async function toggleHot(id: string, currentlyHot: boolean): Promise<void> {
  taps.set(id, !currentlyHot);
  changed();
  try {
    await setHotAction({ clientId: id, hot: !currentlyHot });
  } finally {
    taps.delete(id);
    changed();
  }
}

/**
 * Stars this browser kept before they lived on the server: sent once, then forgotten. Safe to call on every load; it does
 * nothing when there are none or when storage is blocked.
 */
export async function importLocalStars(): Promise<void> {
  const ids = parseIds(read(HOT_KEY));
  if (ids.length === 0) return;
  const res = await importHotAction(ids);
  if (res.ok) write(HOT_KEY, "[]");
}
