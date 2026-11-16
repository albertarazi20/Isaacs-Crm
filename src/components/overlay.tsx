"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ActionResult } from "@/lib/data/types";
import { cn } from "./ui";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Every close() we call ourselves still fires a native "close" event, a moment later. If the same dialog has been
  // opened again by then (log a call, start the next at once), that late event would run onClose for the NEW one and
  // wipe it. So each programmatic close counts one event to ignore; only the person's own dismissal (Escape, the
  // backdrop, the X) reaches onClose.
  const ownCloses = useRef(0);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={() => {
        if (ownCloses.current > 0) {
          ownCloses.current -= 1;
          return;
        }
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        // anchored a fixed distance from the top on a desktop, so content that loads after it opens grows downward instead
        // of re-centring the box under the pointer; a bottom sheet with a grab handle on a phone
        "mx-auto mt-[8vh] mb-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-0 text-text shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px] max-sm:m-0 max-sm:mt-auto max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border sm:hidden" aria-hidden />
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="inline-flex size-10 items-center justify-center rounded-md text-muted transition hover:bg-surface-2 hover:text-text sm:size-8"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

interface ToastInput {
  message: string;
  tone?: "info" | "error" | "success";
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<(t: ToastInput) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const toast = useCallback((t: ToastInput) => {
    const id = next.current++;
    setItems((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), t.action ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 sm:bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-pop",
              t.tone === "error"
                ? "border-bad/30 bg-bad-soft text-bad"
                : t.tone === "success"
                  ? "border-good/30 bg-good-soft text-good"
                  : "border-border bg-surface text-text",
            )}
          >
            <span>{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="font-semibold text-accent underline"
                onClick={() => {
                  t.action?.onClick();
                  setItems((cur) => cur.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/**
 * Await a server action. Failures become an error toast and resolve to null, so callers
 * can write `const card = await call(moveClientAction(...)); if (!card) return;`.
 */
export function useCall() {
  const toast = useToast();
  return useCallback(
    async <T,>(promise: Promise<ActionResult<T>>, success?: string): Promise<T | null> => {
      let res: ActionResult<T>;
      try {
        res = await promise;
      } catch {
        toast({ message: "Couldn't reach the server — check your connection", tone: "error" });
        return null;
      }
      if (!res.ok) {
        toast({ message: res.error, tone: "error" });
        return null;
      }
      if (success) toast({ message: success, tone: "success" });
      return res.data;
    },
    [toast],
  );
}
