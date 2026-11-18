"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { listenEscape } from "./overlay";
import { Glyph } from "./shell/icons";
import { cn } from "./ui";

/**
 * A page's secondary actions (downloads, imports) folded into one menu so the header keeps a single primary
 * button. The items are plain links passed in as children; tapping one, tapping outside, or Escape closes it.
 * With `text` the trigger is a labelled pill; without it, a round "more" button.
 */
export function OverflowMenu({
  label,
  text,
  children,
  className,
}: {
  label: string;
  text?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    // kept to this menu: inside a dialog, Escape must not close the whole sheet
    const stopEscape = listenEscape(document, () => {
      setOpen(false);
      button.current?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      stopEscape();
    };
  }, [open]);

  return (
    <div ref={box} className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-border bg-surface text-sm font-medium text-text shadow-card transition duration-150 hover:border-border-strong hover:bg-surface-3 active:scale-[0.97] sm:h-9",
          text ? "px-4" : "w-10 sm:w-9",
        )}
      >
        {text ? (
          <>
            {text}
            <Glyph
              name="chevronDown"
              className={cn("size-3.5 text-muted transition duration-150", open && "rotate-180")}
            />
          </>
        ) : (
          <Glyph name="more" className="size-[18px]" />
        )}
      </button>
      {open ? (
        <div
          id={panelId}
          onClick={() => setOpen(false)}
          className="glass-strong absolute top-full right-0 z-40 mt-1.5 w-64 animate-pop overflow-hidden rounded-2xl border border-border p-1 shadow-pop [&_a]:flex [&_a]:min-h-10 [&_a]:items-center [&_a]:gap-2.5 [&_a]:rounded-xl [&_a]:px-3 [&_a]:text-[13px] [&_a]:font-medium [&_a]:text-text-2 [&_a]:transition [&_a:hover]:bg-surface-2 [&_a:hover]:text-text"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
