"use client";

import { useState, useTransition } from "react";
import { setThemeAction } from "@/app/theme-actions";
import { THEME_LABELS, THEMES, type Theme } from "@/lib/theme";
import { cn } from "./ui";

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
      className="inline-grid grid-cols-3 rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => pick(t)}
          className={cn(
            "h-8 rounded-md px-3 text-[13px] font-medium transition",
            theme === t ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
          )}
        >
          {THEME_LABELS[t]}
        </button>
      ))}
    </div>
  );
}
