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
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/50",
        wide ? "max-w-2xl" : "max-w-md",
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-muted hover:bg-surface-2"
            >
              ✕
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
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-lg",
              t.tone === "error"
                ? "border-bad bg-bad-soft text-bad"
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
