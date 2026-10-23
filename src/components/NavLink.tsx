"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
    </Link>
  );
}
