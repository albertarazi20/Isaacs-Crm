"use client";

import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { setThemeAction } from "@/app/theme-actions";
import { THEME_LABELS, THEMES, type Theme } from "@/lib/theme";
import { ICON, Icon } from "./settings/primitives";
import { useToast } from "./overlay";
import { cn } from "./ui";

const THEME_ICON: Record<Theme, string> = {
  light: ICON.sun,
  dark: ICON.moon,
  system: ICON.monitor,
};

/** The radio to move to for an arrow key (wrapping), or null for any other key. */
export function nextTheme(current: Theme, key: string): Theme | null {
  const i = THEMES.indexOf(current);
  if (key === "ArrowRight" || key === "ArrowDown")
    return THEMES[(i + 1) % THEMES.length] ?? current;
  if (key === "ArrowLeft" || key === "ArrowUp")
    return THEMES[(i - 1 + THEMES.length) % THEMES.length] ?? current;
  return null;
}

/** Light, dark or follow the device. The page flips at once; the cookie makes it stick. */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [, start] = useTransition();
  const toast = useToast();
  const group = useRef<HTMLDivElement>(null);
  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    // an error thrown inside a transition goes to the page's error screen: a cosmetic setting must not do that
    start(async () => {
      try {
        await setThemeAction(t);
      } catch {
        toast({ message: "Couldn't save the color mode. It will reset on reload", tone: "error" });
      }
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = nextTheme(theme, e.key);
    if (!t) return;
    e.preventDefault();
    pick(t);
    group.current?.querySelector<HTMLElement>(`[data-theme-option="${t}"]`)?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Color mode"
      onKeyDown={onKeyDown}
      className="inline-grid w-full max-w-sm grid-cols-3 gap-0.5 rounded-full border border-border bg-surface-2/70 p-1"
    >
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          tabIndex={theme === t ? 0 : -1}
          data-theme-option={t}
          onClick={() => pick(t)}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition duration-150 active:scale-[0.97] sm:h-8",
            theme === t
              ? "bg-surface text-text shadow-card"
              : "text-muted hover:bg-surface/60 hover:text-text",
          )}
        >
          <Icon d={THEME_ICON[t]} className={cn("size-3.5", theme === t && "text-accent")} />
          {THEME_LABELS[t]}
        </button>
      ))}
    </div>
  );
}
