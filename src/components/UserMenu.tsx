"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LogoutButton } from "./LogoutButton";
import { ThemeSwitch } from "./ThemeSwitch";
import type { Theme } from "@/lib/theme";

const ROLE_LABEL: Record<string, string> = { rep: "Rep", ops: "Ops", manager: "Manager" };

/** The person: who they are, the colour mode, Settings, and the way out. */
export function UserMenu({
  name,
  email,
  role,
  theme,
}: {
  name: string;
  email: string;
  role: string;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const initial = (name || email).trim().charAt(0).toUpperCase() || "?";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="grid size-8 place-items-center rounded-full border border-border bg-surface-2 text-[13px] font-semibold text-text-2 transition hover:border-border-strong hover:text-text"
      >
        {initial}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-border bg-surface p-1.5 shadow-pop"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold">{name || email}</p>
            <p className="truncate text-xs text-muted">
              {email} · {ROLE_LABEL[role] ?? role}
            </p>
          </div>
          <div className="px-2.5 pb-2">
            <ThemeSwitch initial={theme} />
          </div>
          <div className="my-1 border-t border-border" />
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="block rounded-md px-2.5 py-2 text-sm text-text-2 transition hover:bg-surface-2 hover:text-text"
          >
            Settings
          </Link>
          <div className="px-1 pb-0.5">
            <LogoutButton email={email} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
