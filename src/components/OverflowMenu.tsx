"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * The "…" button for a phone: the page's secondary actions (downloads, imports, reports) fold into one
 * menu instead of a stack of buttons ahead of the list (I-14). The items are plain links passed in as
 * children; tapping one, tapping outside, or Escape closes it. Phones only: hidden from 640px up.
 */
export function OverflowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative sm:hidden">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-10 items-center justify-center rounded-lg bg-surface-2 text-lg leading-none font-bold text-text hover:bg-border"
      >
        <span aria-hidden>···</span>
      </button>
      {open ? (
        <div
          id={panelId}
          onClick={() => setOpen(false)}
          className="absolute top-full right-0 z-30 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl [&_a]:flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-4 [&_a]:text-sm [&_a]:font-medium [&_a:hover]:bg-surface-2"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
