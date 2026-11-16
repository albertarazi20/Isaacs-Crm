import type { Role } from "@/lib/auth/roles";
import { ChipLink, ChipRow } from "./primitives";

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

/** The pill nav over every settings page. One row that scrolls on a phone, wraps on a desktop. */
export function SettingsNav({ role, current }: { role: Role; current: string }) {
  return (
    <ChipRow aria-label="Settings">
      {ITEMS.filter((i) => !i.manager || role === "manager").map((i) => (
        <ChipLink key={i.href} href={i.href} active={i.href === current}>
          {i.label}
        </ChipLink>
      ))}
    </ChipRow>
  );
}

/** The title and the pill nav every settings page starts with. */
export function SettingsHeader({ role, current }: { role: Role; current: string }) {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Settings</h1>
      <SettingsNav role={role} current={current} />
    </div>
  );
}
