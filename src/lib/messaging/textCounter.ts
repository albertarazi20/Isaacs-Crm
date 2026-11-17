/**
 * "7 texts today": a soft counter kept in this browser. Google Voice may slow or flag texting that looks like
 * a bulk send, so a long run of texts gets a gentle heads-up. It counts taps on "I sent it", per calendar day
 * (Isaac's day, which the server decides), and never blocks anything.
 */

export const TEXT_COUNT_KEY = "isaac:text-count";
export const TEXT_WARN_AT = 15;

/** The two methods of localStorage we use, so tests can pass a fake and a missing/blocked store is survivable. */
export interface CounterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Stored {
  date: string;
  n: number;
}

function read(storage: CounterStorage | null, today: string): Stored {
  try {
    const raw = storage?.getItem(TEXT_COUNT_KEY);
    if (!raw) return { date: today, n: 0 };
    const v = JSON.parse(raw) as Partial<Stored>;
    if (v.date !== today || typeof v.n !== "number" || !Number.isFinite(v.n) || v.n < 0) {
      return { date: today, n: 0 };
    }
    return { date: today, n: Math.floor(v.n) };
  } catch {
    return { date: today, n: 0 };
  }
}

/** Texts counted today (0 on a new day, with no storage, or with garbage in it). */
export function readTextCount(storage: CounterStorage | null, today: string): number {
  return read(storage, today).n;
}

/** Counts one more text today and returns the new total. A store that refuses the write still returns the count. */
export function bumpTextCount(storage: CounterStorage | null, today: string): number {
  const next: Stored = { date: today, n: read(storage, today).n + 1 };
  try {
    storage?.setItem(TEXT_COUNT_KEY, JSON.stringify(next));
  } catch {
    /* private mode or full: the count just isn't remembered */
  }
  return next.n;
}

/** The gentle warning, or null while the count is comfortable. */
export function textCountWarning(n: number): string | null {
  if (n < TEXT_WARN_AT) return null;
  return `That's ${n} texts today. Google Voice may slow down or flag a long run of texts that looks like a bulk send — consider pausing and picking this up tomorrow.`;
}
