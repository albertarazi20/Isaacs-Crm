"use client";

import { useState, useTransition } from "react";
import { setThemeAction } from "@/app/theme-actions";
import { THEME_LABELS, THEMES, type Theme } from "@/lib/theme";
import { ICON, Icon } from "./settings/primitives";
import { cn } from "./ui";

const THEME_ICON: Record<Theme, string> = {
  light: ICON.sun,
  dark: ICON.moon,
  system: ICON.monitor,
};

/** Light, dark or follow the device. The page flips at once; the cookie makes it stick. */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [, start] = useTransition();
  const pick = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    start(() => setThemeAction(t));
  };
  return (
    <div
      role="radiogroup"
      aria-label="Color mode"
      className="inline-grid w-full max-w-sm grid-cols-3 gap-0.5 rounded-full border border-border bg-surface-2/70 p-1"
    >
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
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
