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

/**
 * Opens and closes a native <dialog> from a boolean. Every close() we call ourselves still fires a native "close"
 * event, a moment later. If the same dialog has been opened again by then (log a call, start the next at once), that
 * late event would run onClose for the NEW one and wipe it. So each programmatic close counts one event to ignore;
 * only the person's own dismissal (Escape, the backdrop, the X) reaches onClose.
 */
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
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
  return {
    ref,
    onClose: () => {
      if (ownCloses.current > 0) {
        ownCloses.current -= 1;
        return;
      }
      onClose();
    },
    onClick: (e: { target: EventTarget | null }) => {
      if (e.target === ref.current) onClose();
    },
  };
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition duration-150 hover:bg-surface-2 hover:text-text active:scale-95 sm:size-8"
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
  );
}

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
  const modal = useModal(open, onClose);
  return (
    <dialog
      ref={modal.ref}
      onClose={modal.onClose}
      onClick={modal.onClick}
      className={cn(
        // anchored a fixed distance from the top on a desktop, so content that loads after it opens grows downward instead
        // of re-centring the box under the pointer; a bottom sheet with a grab handle on a phone
        "mx-auto mt-[8vh] mb-auto w-[calc(100%-2rem)] rounded-3xl border border-border bg-surface p-0 text-text shadow-pop max-sm:m-0 max-sm:mt-auto max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong sm:hidden" aria-hidden />
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5 sm:px-6">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            <CloseButton onClose={onClose} />
          </header>
          <div className="overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-border bg-surface-3/60 px-5 py-3 sm:px-6">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * A sheet that slides in from the right edge and leaves the page visible behind it: the place for work that belongs
 * to the page you are on (a new lead, one merchant, a bucket's settings) so it never needs a page of its own.
 */
export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  subtitle,
  children,
  footer,
  wide,
  headerAside,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  headerAside?: ReactNode;
}) {
  const modal = useModal(open, onClose);
  return (
    <dialog
      ref={modal.ref}
      aria-label={title}
      onClose={modal.onClose}
      onClick={modal.onClick}
      className={cn(
        "sheet-right glass-strong m-0 ml-auto h-dvh max-h-none w-full border-l border-border p-0 text-text shadow-pop sm:rounded-l-3xl",
        wide ? "max-w-[820px]" : "max-w-[560px]",
      )}
    >
      {open ? (
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 pt-5 pb-4 sm:px-7">
            <div className="min-w-0">
              {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
              <h2 className="text-xl font-semibold tracking-[-0.025em]">{title}</h2>
              {subtitle ? <p className="mt-1 text-[13px] text-muted">{subtitle}</p> : null}
            </div>
            <div className="flex items-center gap-1">
              {headerAside}
              <CloseButton onClose={onClose} />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-7">
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
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-5"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="glass-strong pointer-events-auto flex max-w-md animate-pop items-center gap-3 rounded-2xl border border-border py-2.5 pr-4 pl-3 text-sm text-text shadow-pop"
          >
            <span
              aria-hidden
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full",
                t.tone === "error"
                  ? "bg-bad-soft text-bad"
                  : t.tone === "success"
                    ? "bg-good-soft text-good"
                    : "bg-accent-soft text-accent",
              )}
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {t.tone === "error" ? (
                  <path d="M8 4.5v4M8 11.2v.3" />
                ) : t.tone === "success" ? (
                  <path d="m4 8.4 2.6 2.6L12 5.5" />
                ) : (
                  <path d="M8 7.5v4M8 4.6v.3" />
                )}
              </svg>
            </span>
            <span>{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="rounded-full px-2 py-0.5 font-semibold text-accent transition hover:bg-accent-soft"
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
