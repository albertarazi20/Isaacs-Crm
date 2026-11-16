"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogoutButton } from "../LogoutButton";
import { cn } from "../ui";
import type { Role } from "@/lib/auth/roles";
import { phoneTabsFor } from "@/lib/nav";

const svg = (d: string) => (
  <svg
    aria-hidden
    viewBox="0 0 24 24"
    className="size-6"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  "/": svg("M4 5h16v15H4zM4 10h16M9 3v4M15 3v4"),
  "/lead-intake": svg("M12 5v14M5 12h14"),
  "/follow-up": svg("M4 6h16M4 12h10M4 18h7M18 15l3 3-3 3"),
  "/board": svg("M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z"),
  "/deals": svg("M3 7h18v12H3zM3 11h18M8 7V5h8v2"),
  "/winback": svg("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
  "/funded": svg("M12 3v18M7 8h7a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h8"),
};
const fallbackIcon = svg("M4 6h16M4 12h16M4 18h16");

const tabClass = (active: boolean) =>
  cn(
    "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium",
    active ? "text-accent" : "text-muted",
  );

/**
 * Phone navigation (under 640px): Today, Board, Clients, Renewals and a More sheet, fixed to the bottom with
 * the safe-area inset. The top links are hidden at this width. Hidden in power-dial mode, which is full screen.
 */
export function MobileTabBar({ due, email, role }: { due: number; email: string; role: Role }) {
  const path = usePathname();
  const { tabs, more } = phoneTabsFor(role);
  const [moreOpen, setMoreOpen] = useState(false);
  if (path === "/dial") return null;
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const moreActive = more.some((l) => isActive(l.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <ul className="mx-auto flex max-w-xl">
          {tabs.map((t) => (
            <li key={t.href} className="flex flex-1">
              <Link
                href={t.href}
                aria-current={isActive(t.href) ? "page" : undefined}
                className={tabClass(isActive(t.href))}
              >
                <span className="relative">
                  {ICONS[t.href] ?? fallbackIcon}
                  {t.href === "/" && due > 0 ? (
                    <span
                      className="absolute -top-1.5 left-3.5 min-w-5 rounded-full bg-bad px-1 text-center text-[11px] leading-5 font-bold text-white tabular-nums"
                      aria-label={`${due} follow-ups due`}
                    >
                      {due > 99 ? "99+" : due}
                    </span>
                  ) : null}
                </span>
                {t.short ?? t.label}
              </Link>
            </li>
          ))}
          <li className="flex flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className={tabClass(moreActive)}
            >
              {svg("M5 12h.01M12 12h.01M19 12h.01")}
              More
            </button>
          </li>
        </ul>
      </nav>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} email={email} links={more} />
    </>
  );
}

function MoreSheet({
  open,
  onClose,
  email,
  links,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
  links: { href: string; label: string }[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="More"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-border bg-surface p-0 pb-[env(safe-area-inset-bottom)] text-text shadow-2xl backdrop:bg-black/50 sm:hidden"
    >
      {open ? (
        <div className="p-2">
          <div className="mx-auto my-1 h-1 w-10 rounded-full bg-border" aria-hidden />
          <ul>
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={onClose}
                  aria-current={path.startsWith(l.href) ? "page" : undefined}
                  className="flex min-h-12 items-center rounded-xl px-4 text-base font-medium hover:bg-surface-2 aria-[current=page]:text-accent"
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="flex min-h-12 items-center justify-between rounded-xl px-4">
              <span className="truncate text-sm text-muted">{email}</span>
              <div className="shrink-0 [&_button]:whitespace-nowrap">
                <LogoutButton email={email} />
              </div>
            </li>
          </ul>
        </div>
      ) : null}
    </dialog>
  );
}
