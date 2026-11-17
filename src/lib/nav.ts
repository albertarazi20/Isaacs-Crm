/** The main navigation. Pure, shared by the header, the phone tab bar and the tests. */

export interface NavItem {
  href: string;
  label: string;
  /** Short label for the phone tab bar. */
  short?: string;
}

/** Reps and managers see the same pages; an ops account (the role stays in the database) is shown them too. */
const ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", short: "Home" },
  { href: "/lead-intake", label: "Lead Intake", short: "Intake" },
  { href: "/follow-up", label: "Follow Up", short: "Follow" },
  { href: "/clients", label: "Merchants", short: "Merchants" },
  { href: "/settings", label: "Settings", short: "Settings" },
];

/** Whether a path is a top-level page of the nav (the nav is the source of truth). */
export function pageAllowed(href: string): boolean {
  return ITEMS.some((n) => n.href === href);
}

export function navFor(): NavItem[] {
  return ITEMS.map(({ href, label, short }) => ({ href, label, short }));
}

/** The four that fit a phone's tab bar; the rest go under "More". */
export function phoneTabsFor(): { tabs: NavItem[]; more: NavItem[] } {
  const items = navFor();
  const primary = items.filter((n) => n.href !== "/settings").slice(0, 4);
  const more = [
    ...items.filter((n) => !primary.includes(n)),
    { href: "/alerts", label: "Alerts" },
    { href: "/today", label: "Today's calls" },
    { href: "/dial", label: "Power dial" },
    { href: "/trash", label: "Trash" },
  ];
  return { tabs: primary, more };
}
