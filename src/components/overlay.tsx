"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ActionResult } from "@/lib/data/types";
import { cn } from "./ui";

/** Put focus back on the control that opened a dialog, if it is still on the page and nothing else took focus. */
function returnFocus(opener: { current: HTMLElement | null }) {
  const el = opener.current;
  opener.current = null;
  if (!el) return;
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (el.isConnected && (!now || now === document.body || !now.isConnected))
      el.focus({ preventScroll: true });
  });
}

/**
 * Should a click on a <dialog> close it? Only when the press started on the backdrop too: a text-selection drag that
 * starts in a field and ends past the dialog edge also dispatches its click to the <dialog> itself, and must not
 * throw away what was typed.
 */
export function isBackdropClick(
  pressStartedOnBackdrop: boolean,
  clickTarget: EventTarget | null,
  dialog: EventTarget | null,
): boolean {
  return pressStartedOnBackdrop && clickTarget !== null && clickTarget === dialog;
}

/** Props for a <dialog> that closes on a real backdrop click (see isBackdropClick). */
export function useBackdropClose(ref: { current: HTMLDialogElement | null }, onClose: () => void) {
  const pressedBackdrop = useRef(false);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLDialogElement>) => {
      pressedBackdrop.current = e.target === ref.current;
    },
    onClick: (e: ReactMouseEvent<HTMLDialogElement>) => {
      const started = pressedBackdrop.current;
      pressedBackdrop.current = false;
      if (isBackdropClick(started, e.target, ref.current)) onClose();
    },
  };
}

/**
 * Escape for a popover that sits inside a dialog or drawer (time picker, overflow menu): it listens before anything
 * else does and keeps the key to itself, so the press closes only the popover and not the sheet around it.
 * Returns the cleanup.
 */
export function listenEscape(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  onEscape: () => void,
): () => void {
  const handler = (e: Event) => {
    if ((e as KeyboardEvent).key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  };
  target.addEventListener("keydown", handler, true);
  return () => target.removeEventListener("keydown", handler, true);
}

/**
 * The modal dialogs that are open, oldest first. showModal() makes everything outside the dialog inert, so a toast
 * in the top layer would be visible over a dialog but dead to clicks; TopLayer therefore moves into the newest open
 * modal (the last one shown is the one on top) while one is open. These three are the pure part.
 */
export type ModalLike = { open: boolean; isConnected: boolean };

/** `el` is now the newest modal: it goes to the end, once. */
export function pushModal<T>(stack: readonly T[], el: T): readonly T[] {
  return [...stack.filter((x) => x !== el), el];
}

export function dropModal<T>(stack: readonly T[], el: T): readonly T[] {
  return stack.includes(el) ? stack.filter((x) => x !== el) : stack;
}

/** The modal on top: the newest one that is really still open (a dialog removed from the page never reported). */
export function topModal<T extends ModalLike>(stack: readonly T[]): T | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const el = stack[i];
    if (el && el.open && el.isConnected) return el;
  }
  return null;
}

let openModals: readonly HTMLDialogElement[] = [];
const modalListeners = new Set<() => void>();
function setOpenModals(next: readonly HTMLDialogElement[]) {
  if (next === openModals) return;
  openModals = next;
  for (const l of modalListeners) l();
}
const subscribeModals = (l: () => void) => {
  modalListeners.add(l);
  return () => void modalListeners.delete(l);
};
const topModalNow = () => topModal(openModals);
const noModal = () => null;

/**
 * Opens and closes a native <dialog> from a boolean, and keeps the boolean honest.
 *
 * The browser's own "close" event can land a good half second after the dialog has gone (measured in Chrome). Until
 * it lands the app would still believe the dialog is open, so "open it again" does nothing, and when it does land it
 * can wipe a dialog that was opened in between. So:
 *   - Escape is handled here, on the key press: it runs onClose at once and the dialog is then closed by us;
 *   - every close() we call ourselves counts one native event to ignore;
 *   - a native close event that arrives while the dialog is open is from an earlier close and is ignored.
 * Returns [ref, onClose handler, onKeyDown handler] for the <dialog>.
 */
export function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const ownCloses = useRef(0);
  // what had focus when it opened: focus goes back there when it closes, even when the caller removes the dialog
  // from the page at once (the browser's own focus return never runs then, and focus would fall to <body>)
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      setOpenModals(pushModal(openModals, d));
    }
    if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
      setOpenModals(dropModal(openModals, d));
      returnFocus(opener);
    }
  }, [open]);
  // however the dialog closes (our close(), the browser's own, or leaving the page), it stops being the top modal
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // a close event from an earlier close can land after the dialog was opened again: only a dialog that is shut counts
    const onClose = () => {
      if (!d.open) setOpenModals(dropModal(openModals, d));
    };
    d.addEventListener("close", onClose);
    return () => {
      d.removeEventListener("close", onClose);
      setOpenModals(dropModal(openModals, d));
    };
  }, []);
  useEffect(() => () => returnFocus(opener), []);
  const onNativeClose = useCallback(() => {
    if (ownCloses.current > 0) {
      ownCloses.current -= 1;
      return;
    }
    if (ref.current?.open) return;
    onClose();
  }, [onClose]);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDialogElement>) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // ours to close: stops the browser closing it behind our back, and an outer sheet from closing too
      e.preventDefault();
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );
  // Escape pressed while focus is outside the dialog (the clicked button was removed) never reaches onKeyDown; the
  // browser fires "cancel" on the top dialog instead, at once, so the state follows it before any late close event
  const onCancel = useCallback(
    (e: SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    [onClose],
  );
  return [ref, onNativeClose, onKeyDown, onCancel] as const;
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
  const [ref, onNativeClose, onKeyDown, onCancel] = useModal(open, onClose);
  const backdrop = useBackdropClose(ref, onClose);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
      className={cn(
        // anchored a fixed distance from the top on a desktop, so content that loads after it opens grows downward instead
        // of re-centring the box under the pointer; a bottom sheet with a grab handle on a phone
        "mx-auto mt-[8vh] mb-auto w-[calc(100%-2rem)] rounded-3xl border border-border bg-surface p-0 text-text shadow-pop max-sm:m-0 max-sm:mt-auto max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div
            className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong sm:hidden"
            aria-hidden
          />
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
  const [ref, onNativeClose, onKeyDown, onCancel] = useModal(open, onClose);
  const backdrop = useBackdropClose(ref, onClose);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
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
          <div data-drawer-body className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
            {children}
          </div>
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

/**
 * A box that lives in the browser's top layer. A modal <dialog> puts itself and its backdrop there, and no z-index
 * can lift an ordinary element above it, so anything that must stay visible over a dialog (toasts, the reminder
 * banner) renders through this. Shown on mount and again whenever `bump` changes, so it lands above a dialog that
 * opened after it. A modal dialog also makes everything outside its own subtree inert, so while one is open the box
 * is rendered inside the newest open modal: still above it, and clickable (Undo, Dismiss). Where popovers are
 * unsupported it is just a fixed box, as before.
 */
export function TopLayer({
  bump,
  className,
  children,
  ...rest
}: {
  bump?: string | number;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const ref = useRef<HTMLDivElement>(null);
  const modal = useSyncExternalStore(subscribeModals, topModalNow, noModal);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      el.showPopover();
    } catch {
      // not allowed right now (detached, or the page is closing): it stays a plain fixed box
    }
    return () => {
      try {
        if (el.matches(":popover-open")) el.hidePopover();
      } catch {
        // already gone
      }
    };
    // `modal`: the box is a new element inside another parent, so it has to be shown again
  }, [bump, modal]);
  const box = (
    <div
      ref={ref}
      popover="manual"
      // reset the browser's popover box (centred, bordered, opaque, scrolling) to a bare fixed strip
      className={cn(
        "m-0 h-auto max-h-none w-auto overflow-visible border-0 bg-transparent p-0 text-inherit",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
  return modal ? createPortal(box, modal) : box;
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
      <TopLayer
        aria-live="polite"
        bump={items.length}
        className="pointer-events-none fixed inset-x-0 top-auto bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-5"
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
              <svg
                viewBox="0 0 16 16"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
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
      </TopLayer>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** What a failed network call says: the action never answered (offline, the server restarting). */
export const NETWORK_ERROR = "Couldn't reach the server. Check your connection";

/** The body of useCall, without the hook: await the action, toast a failure, resolve to the data or null. */
export async function runCall<T>(
  toast: (t: ToastInput) => void,
  promise: Promise<ActionResult<T>>,
  success?: string,
): Promise<T | null> {
  let res: ActionResult<T>;
  try {
    res = await promise;
  } catch {
    toast({ message: NETWORK_ERROR, tone: "error" });
    return null;
  }
  if (!res.ok) {
    toast({ message: res.error, tone: "error" });
    return null;
  }
  if (success) toast({ message: success, tone: "success" });
  return res.data;
}

/**
 * Await a server action. Failures become an error toast and resolve to null, so callers
 * can write `const card = await call(moveClientAction(...)); if (!card) return;`.
 */
export function useCall() {
  const toast = useToast();
  return useCallback(
    <T,>(promise: Promise<ActionResult<T>>, success?: string): Promise<T | null> =>
      runCall(toast, promise, success),
    [toast],
  );
}
