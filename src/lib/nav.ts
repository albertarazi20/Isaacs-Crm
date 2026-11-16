/** The main navigation, by role. Pure, shared by the header, the phone tab bar and the tests. */
import type { Role } from "./auth/roles";

export interface NavItem {
  href: string;
  label: string;
  /** Short label for the phone tab bar. */
  short?: string;
}

const ALL: (NavItem & { roles: readonly Role[] })[] = [
  { href: "/", label: "Dashboard", short: "Home", roles: ["rep", "ops", "manager"] },
  { href: "/lead-intake", label: "Lead Intake", short: "Intake", roles: ["rep", "manager"] },
  { href: "/follow-up", label: "Follow Up", short: "Follow", roles: ["rep", "manager"] },
  { href: "/board", label: "Submission Board", short: "Board", roles: ["ops", "manager"] },
  { href: "/deals", label: "My Deals", short: "Deals", roles: ["rep", "ops", "manager"] },
  { href: "/winback", label: "Winback", short: "Winback", roles: ["rep", "manager"] },
  { href: "/funded", label: "Funded", short: "Funded", roles: ["rep", "manager"] },
  { href: "/settings", label: "Settings", short: "Settings", roles: ["rep", "ops", "manager"] },
];

export function navFor(role: Role): NavItem[] {
  return ALL.filter((n) => n.roles.includes(role)).map(({ href, label, short }) => ({
    href,
    label,
    short,
  }));
}

/** The four that fit a phone's tab bar; the rest go under "More". */
export function phoneTabsFor(role: Role): { tabs: NavItem[]; more: NavItem[] } {
  const items = navFor(role);
  const primary = items.filter((n) => n.href !== "/settings").slice(0, 4);
  const more = [
    ...items.filter((n) => !primary.includes(n)),
    { href: "/today", label: "Today's calls" },
    { href: "/dial", label: "Power dial" },
    { href: "/clients", label: "All merchants" },
    { href: "/trash", label: "Trash" },
  ];
  return { tabs: primary, more };
}
