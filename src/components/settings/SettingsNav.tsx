import Link from "next/link";
import type { Role } from "@/lib/auth/roles";
import { cn } from "@/components/ui";

const ITEMS: { href: string; label: string; manager?: boolean }[] = [
  { href: "/settings", label: "Me" },
  { href: "/settings/buckets", label: "Buckets & templates" },
  { href: "/settings/sheets", label: "Google Sheets" },
  { href: "/settings/team", label: "Team & trust", manager: true },
  { href: "/settings/email", label: "Email & lenders", manager: true },
  { href: "/settings/plan", label: "Commission plan", manager: true },
  { href: "/settings/ai", label: "AI", manager: true },
  { href: "/funders", label: "Lender list", manager: true },
];

export function SettingsNav({ role, current }: { role: Role; current: string }) {
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-1.5">
      {ITEMS.filter((i) => !i.manager || role === "manager").map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={i.href === current ? "page" : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium transition",
            i.href === current
              ? "border-accent/30 bg-accent-soft text-accent"
              : "border-border bg-surface text-muted hover:border-border-strong hover:text-text",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
