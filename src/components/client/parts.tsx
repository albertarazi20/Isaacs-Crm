"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { ActionResult } from "@/lib/data/types";
import { Dialog, useCall, useToast } from "../overlay";
import { Button, cn } from "../ui";
import { Icon, type IconName } from "./icons";

/**
 * Like useCall, but resolves true/false. useCall returns null for a failure AND for an action
 * whose data is null (notes, stips…), so those can't tell "saved" from "failed".
 */
export function useRun() {
  const call = useCall();
  return useCallback(
    async (promise: Promise<ActionResult<unknown>>, success?: string): Promise<boolean> => {
      const mapped = promise.then((r): ActionResult<true> => (r.ok ? { ok: true, data: true } : r));
      return (await call(mapped, success)) === true;
    },
    [call],
  );
}

// "3 days ago" must match between the server render and hydration, so the clock comes from the
// server (as a prop) and only moves forward once the browser has mounted.
const NowContext = createContext(0);

export function NowProvider({ serverNow, children }: { serverNow: number; children: ReactNode }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return <NowContext.Provider value={Math.max(serverNow, tick)}>{children}</NowContext.Provider>;
}

/** Milliseconds since epoch, as of the last render. */
export const useNowMs = () => useContext(NowContext);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, label: string) => {
      const ok = await copyText(text);
      toast(
        ok
          ? { message: `Copied ${label}: ${text}`, tone: "success" }
          : { message: `Couldn't copy. Select it and press Ctrl+C`, tone: "error" },
      );
    },
    [toast],
  );
}

/** One working panel: a small icon tile, its title, an optional aside, then the content. */
export function Panel({
  title,
  icon,
  aside,
  children,
  className,
}: {
  title: string;
  icon?: IconName;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-surface p-4 sm:p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon ? (
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-2 ring-1 ring-border ring-inset"
            >
              <Icon name={icon} className="size-3.5" />
            </span>
          ) : null}
          <h2 className="truncate text-sm font-semibold tracking-tight text-text">{title}</h2>
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

type StringKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];

/** Controlled form state for a dialog; the typed text survives a failed save because it lives here. */
export function useFormState<T extends object>(init: () => T) {
  const [v, setV] = useState(init);
  const bind = (k: StringKeys<T>) => ({
    value: v[k] as string,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setV((cur) => ({ ...cur, [k]: e.target.value })),
  });
  const set = <K extends keyof T>(k: K, value: T[K]) => setV((cur) => ({ ...cur, [k]: value }));
  return { v, bind, set };
}

/** Render only while open: the form state then starts fresh from props on every open. */
export function FormDialog({
  title,
  onClose,
  onSubmit,
  busy,
  submitLabel = "Save",
  leftFooter,
  wide,
  danger,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  submitLabel?: string;
  leftFooter?: ReactNode;
  wide?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      wide={wide}
      footer={
        <>
          {leftFooter ? <div className="mr-auto">{leftFooter}</div> : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            type="submit"
            form={formId}
            disabled={busy}
          >
            {busy ? "Saving…" : submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        {children}
      </form>
    </Dialog>
  );
}

/** Two clicks to delete: the first arms it, the second does it. Disarms itself if you look away. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  busy,
  size = "md",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy: boolean;
  size?: "sm" | "md";
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant={armed ? "danger" : "ghost"}
      size={size}
      disabled={busy}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-muted", className)}>{children}</p>;
}

export function Stat({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] font-medium text-muted">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}
