"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { SortMode } from "@/lib/data/priority";

/**
 * Two small per-browser preferences: how Today is ordered, and which clients are starred.
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

/** Starred clients. A fresh Set only when the stored list actually changes. */
export function useHotIds(): ReadonlySet<string> {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(HOT_KEY),
    () => null,
  );
  return useMemo(() => new Set(parseIds(raw)), [raw]);
}

export function toggleHot(id: string): void {
  const cur = new Set(parseIds(read(HOT_KEY)));
  if (cur.has(id)) cur.delete(id);
  else cur.add(id);
  write(HOT_KEY, JSON.stringify([...cur]));
}
