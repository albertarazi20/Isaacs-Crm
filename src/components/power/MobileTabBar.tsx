"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogoutButton } from "../LogoutButton";
import { cn } from "../ui";

interface Tab {
  href: string;
  label: string;
  icon: ReactNode;
}

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

const TABS: Tab[] = [
  { href: "/", label: "Today", icon: svg("M4 5h16v15H4zM4 10h16M9 3v4M15 3v4") },
  { href: "/board", label: "Board", icon: svg("M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z") },
  {
    href: "/clients",
    label: "Clients",
    icon: svg(
      "M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    ),
  },
  {
    href: "/renewals",
    label: "Renewals",
    icon: svg("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
  },
];

const MORE_LINKS = [
  { href: "/dial", label: "Power dial" },
  { href: "/winback", label: "Win-back" },
  { href: "/funders", label: "Funders" },
  { href: "/earnings", label: "Earnings" },
  { href: "/reports", label: "Reports" },
  { href: "/long-game", label: "Long game" },
  { href: "/lead-intake", label: "Lead intake" },
  { href: "/import", label: "Import" },
  { href: "/trash", label: "Trash" },
  { href: "/settings", label: "Settings" },
];

const tabClass = (active: boolean) =>
  cn(
    "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium",
    active ? "text-accent" : "text-muted",
  );

/**
 * Phone navigation (under 640px): Today, Board, Clients, Renewals and a More sheet, fixed to the bottom with
 * the safe-area inset. The top links are hidden at this width. Hidden in power-dial mode, which is full screen.
 */
export function MobileTabBar({ due, email }: { due: number; email: string }) {
  const path = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  if (path === "/dial") return null;
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const moreActive = MORE_LINKS.some((l) => isActive(l.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <ul className="mx-auto flex max-w-xl">
          {TABS.map((t) => (
            <li key={t.href} className="flex flex-1">
              <Link
                href={t.href}
                aria-current={isActive(t.href) ? "page" : undefined}
                className={tabClass(isActive(t.href))}
              >
                <span className="relative">
                  {t.icon}
                  {t.href === "/" && due > 0 ? (
                    <span
                      className="absolute -top-1.5 left-3.5 min-w-5 rounded-full bg-bad px-1 text-center text-[11px] leading-5 font-bold text-white tabular-nums"
                      aria-label={`${due} follow-ups due`}
                    >
                      {due > 99 ? "99+" : due}
                    </span>
                  ) : null}
                </span>
                {t.label}
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
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} email={email} />
    </>
  );
}

function MoreSheet({
  open,
  onClose,
  email,
}: {
  open: boolean;
  onClose: () => void;
  email: string;
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
            {MORE_LINKS.map((l) => (
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
