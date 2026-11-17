/**
 * The navigation: two links (Overview, Open approvals) and three dropdowns in the sidebar. Pure, shared by the sidebar
 * and the tests.
 * Adding a lead is not a place: it is the "New lead" button, which opens over whatever page you are on.
 */

export interface NavItem {
  href: string;
  label: string;
}

/** Reps and managers see the same pages; an ops account (the role stays in the database) is shown them too. */
const ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/approvals", label: "Open approvals" },
  { href: "/follow-up", label: "Follow Up" },
  { href: "/clients", label: "Merchants" },
  { href: "/settings", label: "Settings" },
];

/** Whether a path is a top-level page of the nav (the nav is the source of truth). */
export function pageAllowed(href: string): boolean {
  return ITEMS.some((n) => n.href === href);
}

export function navFor(): NavItem[] {
  return ITEMS.map(({ href, label }) => ({ href, label }));
}

/** What sits under Merchants. */
export const MERCHANT_VIEWS: readonly NavItem[] = [
  { href: "/clients", label: "All merchants" },
  { href: "/today", label: "Call list" },
  { href: "/dial", label: "Power dial" },
  { href: "/import", label: "Import a file" },
  { href: "/trash", label: "Trash" },
];

/** What sits under Settings; `manager` marks the ones only a manager is shown. */
export const SETTINGS_VIEWS: readonly (NavItem & { manager?: boolean })[] = [
  { href: "/settings", label: "My account" },
  { href: "/settings/buckets", label: "Buckets & templates" },
  { href: "/settings/sheets", label: "Lead sources" },
  { href: "/settings/email", label: "Email", manager: true },
  { href: "/settings/approvals", label: "Approval emails", manager: true },
  { href: "/settings/team", label: "Team", manager: true },
  { href: "/settings/ai", label: "AI assistant", manager: true },
];
