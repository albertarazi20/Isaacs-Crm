"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

export function NavLink({
  href,
  children,
  badge,
}: {
  href: string;
  children: React.ReactNode;
  badge?: number;
}) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition",
        active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/70 hover:text-text",
      )}
    >
      {children}
      {badge ? (
        <span
          className="rounded-full bg-bad px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums"
          aria-label={`${badge} follow-ups due`}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
