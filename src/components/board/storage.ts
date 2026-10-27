import { useCallback, useMemo, useSyncExternalStore } from "react";
import { isStageKey, type StageGroup, type StageKey } from "@/lib/mca/stages";
import { VIEW_COOKIE, type BoardView } from "./logic";

/**
 * Per-browser preferences. localStorage can be missing or throw (private windows, blocked site
 * data), so every access is guarded and an in-memory copy keeps toggles working for the session.
 */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  const mem = memory.get(key);
  if (mem !== undefined) return mem;
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
    /* private mode or blocked: the in-memory copy still applies */
  }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key) memory.delete(e.key);
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// The server snapshot is always "nothing stored", so hydration matches and the saved value
// is picked up right after.
function useStored(key: string): [string | null, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const set = useCallback((v: string) => write(key, v), [key]);
  return [value, set];
}

export function useStoredFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [raw, set] = useStored(key);
  const setFlag = useCallback((v: boolean) => set(v ? "1" : "0"), [set]);
  return [raw === null ? fallback : raw === "1", setFlag];
}

/** The stage he last picked in the board dropdown, remembered on this device. */
export function useStoredStage(): [StageKey | null, (s: StageKey) => void] {
  const [raw, set] = useStored("isaac:board:stage");
  return [raw && isStageKey(raw) ? raw : null, set];
}

const GROUPS_KEY = "isaac:board:collapsed";

function parseGroups(raw: string | null): ReadonlySet<StageGroup> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? (v as StageGroup[]) : []);
  } catch {
    return new Set();
  }
}

export function useCollapsedGroups(): [ReadonlySet<StageGroup>, (g: StageGroup) => void] {
  const [raw, set] = useStored(GROUPS_KEY);
  const toggle = useCallback(
    (g: StageGroup) => {
      const next = new Set(parseGroups(read(GROUPS_KEY)));
      if (!next.delete(g)) next.add(g);
      set(JSON.stringify([...next]));
    },
    [set],
  );
  const groups = useMemo(() => parseGroups(raw), [raw]);
  return [groups, toggle];
}

/** Remembers the Board view for next time in the cookie the server reads (see VIEW_COOKIE). Never throws. */
export function rememberView(view: BoardView): void {
  try {
    document.cookie = `${VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* cookies blocked: the view still works, it just is not remembered */
  }
}
