"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { useBackdropClose, useModal } from "@/components/overlay";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { Avatar, cn, Kbd } from "@/components/ui";
import { MERCHANT_VIEWS, SETTINGS_VIEWS } from "@/lib/nav";
import type { Theme } from "@/lib/theme";
import { Glyph, type GlyphName } from "./icons";
import { NewLeadButton } from "./NewLead";

/** Ask the assistant panel (mounted once in the layout) to open. */
const openAssistantPanel = () => window.dispatchEvent(new Event("crm:assistant"));

export interface SidebarBucket {
  id: string;
  name: string;
  count: number;
  mine: boolean;
}
export interface SidebarProps {
  user: { name: string; email: string; roleLabel: string };
  theme: Theme;
  manager: boolean;
  buckets: SidebarBucket[];
  /** Follow-ups due today or overdue. */
  due: number;
  /** Open approvals waiting on a pitch. */
  approvals: number;
  unreadAlerts: number;
}

type GroupKey = "follow" | "merchants" | "settings";

/** Ask the search palette (mounted once in the layout) to open. */
export const openSearch = () => window.dispatchEvent(new Event("crm:search"));

const MERCHANT_ICON: Record<string, GlyphName> = {
  "/clients": "merchants",
  "/today": "list",
  "/dial": "zap",
  "/import": "upload",
  "/trash": "trash",
};
const SETTINGS_ICON: Record<string, GlyphName> = {
  "/settings": "user",
  "/settings/buckets": "bucket",
  "/settings/sheets": "sheet",
  "/settings/email": "mail",
  "/settings/approvals": "send",
  "/settings/team": "merchants",
  "/settings/ai": "sparkles",
};

function Count({ n, tone = "quiet" }: { n: number; tone?: "quiet" | "hot" }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums",
        tone === "hot" ? "bg-brand-ink text-white shadow-glow" : "bg-surface-2 text-text-2",
      )}
    >
      {n > 999 ? "999+" : n}
    </span>
  );
}

/** A top-level row: a link, or the head of a dropdown. */
function rowClass(active: boolean) {
  return cn(
    "group relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition duration-150 lg:h-9",
    active
      ? "bg-surface-2/80 text-text shadow-[inset_0_1px_0_var(--hairline)]"
      : "text-text-2 hover:bg-surface-2/50 hover:text-text",
  );
}

function ActiveBar() {
  return (
    <span
      aria-hidden
      className="bg-brand absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full shadow-glow"
    />
  );
}

function Group({
  icon,
  label,
  active,
  open,
  onToggle,
  badge,
  children,
}: {
  icon: GlyphName;
  label: string;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={onToggle} className={rowClass(active)}>
        {active ? <ActiveBar /> : null}
        <Glyph name={icon} className={cn("size-[18px] shrink-0", active && "text-accent")} />
        <span className="flex-1 text-left">{label}</span>
        {badge}
        <Glyph
          name="chevron"
          className={cn(
            "size-3.5 shrink-0 text-muted transition-transform duration-300 ease-out",
            open && "rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!open}
      >
        <div className="overflow-hidden">
          <ul className="mt-1 mb-1.5 ml-[21px] space-y-0.5 border-l border-border pl-2.5">
            {children}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SubLink({
  href,
  active,
  onNavigate,
  icon,
  children,
  count,
}: {
  href: string;
  active: boolean;
  onNavigate?: () => void;
  icon?: GlyphName;
  children: ReactNode;
  count?: number;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] transition duration-150 lg:h-8",
          active
            ? "bg-accent-soft font-medium text-text ring-1 ring-accent/20 ring-inset"
            : "text-muted hover:bg-surface-2/50 hover:text-text",
        )}
      >
        {icon ? <Glyph name={icon} className="size-[15px] shrink-0" /> : null}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count !== undefined && count > 0 ? (
          <span className={cn("text-[11px] tabular-nums", active ? "text-accent" : "text-muted")}>
            {count}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function Logo({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      aria-label="Selective CRM home"
      onClick={onNavigate}
      className="flex h-9 items-center"
    >
      <Image
        src="/brand/SC-horizontal-light-web.png"
        alt="Selective Capital"
        width={148}
        height={24}
        priority
        className="only-light"
      />
      <Image
        src="/brand/SC-horizontal-dark-web.png"
        alt="Selective Capital"
        width={148}
        height={24}
        priority
        className="only-dark"
      />
    </Link>
  );
}

/** Everything inside the sidebar; the desktop rail and the phone's slide-in sheet both render it. */
function SidebarBody({
  user,
  theme,
  manager,
  buckets,
  due,
  approvals,
  unreadAlerts,
  onNavigate,
}: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const bucketParam = params.get("b");
  const inFollow = pathname.startsWith("/follow-up");
  const inMerchants = MERCHANT_VIEWS.some(
    (v) => pathname === v.href || pathname.startsWith(`${v.href}/`),
  );
  const inSettings = pathname.startsWith("/settings");
  // what the person toggled by hand; until they do, a dropdown is open when you are inside it
  const [manual, setManual] = useState<Partial<Record<GroupKey, boolean>>>({});
  const [account, setAccount] = useState(false);
  const accountButton = useRef<HTMLButtonElement | null>(null);
  const isOpen = (k: GroupKey, fallback: boolean) => manual[k] ?? fallback;
  const toggle = (k: GroupKey, fallback: boolean) =>
    setManual((m) => ({ ...m, [k]: !(m[k] ?? fallback) }));

  const shared = buckets.filter((b) => !b.mine);
  const mine = buckets.filter((b) => b.mine);
  // Follow Up starts open where the buckets are the point (here and on the Overview); elsewhere the group you are in
  // is the one that starts open, so the rail never needs scrolling to reach where you are
  const followDefault = inFollow || pathname === "/";
  const followOpen = isOpen("follow", followDefault);
  const merchantsOpen = isOpen("merchants", inMerchants);
  const settingsOpen = isOpen("settings", inSettings);

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-4">
        <Logo onNavigate={onNavigate} />
      </div>

      <div className="space-y-2 px-4">
        <NewLeadButton variant="full" onOpen={onNavigate} />
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            openSearch();
          }}
          aria-label="Find a merchant"
          aria-keyshortcuts="Control+K Meta+K"
          className="flex h-10 w-full items-center gap-2.5 rounded-full border border-border bg-surface-3/60 pr-2 pl-3.5 text-[13px] text-muted shadow-[inset_0_1px_2px_var(--shadow-c1)] transition duration-150 hover:border-border-strong hover:text-text lg:h-9"
        >
          <Glyph name="search" className="size-4" />
          <span className="flex-1 text-left">Find a merchant…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            openAssistantPanel();
          }}
          aria-keyshortcuts="Control+J Meta+J"
          className="bg-brand-soft group flex h-10 w-full items-center gap-2.5 rounded-full pr-2 pl-3.5 text-[13px] font-medium text-text ring-1 ring-accent/25 transition duration-150 ring-inset hover:ring-accent/55 active:scale-[0.98] lg:h-9"
        >
          <Glyph name="sparkles" className="size-4 text-accent" />
          <span className="flex-1 text-left">Ask the assistant</span>
          <Kbd>⌘J</Kbd>
        </button>
      </div>

      <nav
        aria-label="Main"
        className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]"
      >
        <Link
          href="/"
          onClick={onNavigate}
          aria-current={pathname === "/" ? "page" : undefined}
          className={rowClass(pathname === "/")}
        >
          {pathname === "/" ? <ActiveBar /> : null}
          <Glyph
            name="overview"
            className={cn("size-[18px] shrink-0", pathname === "/" && "text-accent")}
          />
          <span className="flex-1">Overview</span>
          <Count n={due} tone="hot" />
        </Link>

        <Link
          href="/approvals"
          onClick={onNavigate}
          aria-current={pathname.startsWith("/approvals") ? "page" : undefined}
          aria-label={approvals > 0 ? `Open approvals, ${approvals} waiting on a pitch` : undefined}
          className={rowClass(pathname.startsWith("/approvals"))}
        >
          {pathname.startsWith("/approvals") ? <ActiveBar /> : null}
          <Glyph
            name="target"
            className={cn(
              "size-[18px] shrink-0",
              pathname.startsWith("/approvals") && "text-accent",
            )}
          />
          <span className="flex-1">Open approvals</span>
          <Count n={approvals} />
        </Link>

        <Group
          icon="followup"
          label="Follow Up"
          active={inFollow}
          open={followOpen}
          onToggle={() => toggle("follow", followDefault)}
        >
          <SubLink
            href="/follow-up"
            active={inFollow && !bucketParam}
            onNavigate={onNavigate}
            icon="bucket"
          >
            All buckets
          </SubLink>
          {shared.map((b) => (
            <SubLink
              key={b.id}
              href={`/follow-up?b=${b.id}`}
              active={inFollow && bucketParam === b.id}
              onNavigate={onNavigate}
              count={b.count}
            >
              {b.name}
            </SubLink>
          ))}
          {mine.length > 0 ? (
            <li className="eyebrow px-2.5 pt-2.5 pb-1 text-[10px]!">My buckets</li>
          ) : null}
          {mine.map((b) => (
            <SubLink
              key={b.id}
              href={`/follow-up?b=${b.id}`}
              active={inFollow && bucketParam === b.id}
              onNavigate={onNavigate}
              count={b.count}
            >
              {b.name}
            </SubLink>
          ))}
        </Group>

        <Group
          icon="merchants"
          label="Merchants"
          active={inMerchants}
          open={merchantsOpen}
          onToggle={() => toggle("merchants", inMerchants)}
        >
          {MERCHANT_VIEWS.map((v) => (
            <SubLink
              key={v.href}
              href={v.href}
              active={pathname === v.href || pathname.startsWith(`${v.href}/`)}
              onNavigate={onNavigate}
              icon={MERCHANT_ICON[v.href]}
              count={v.href === "/today" ? due : undefined}
            >
              {v.label}
            </SubLink>
          ))}
        </Group>

        <Group
          icon="settings"
          label="Settings"
          active={inSettings}
          open={settingsOpen}
          onToggle={() => toggle("settings", inSettings)}
        >
          {SETTINGS_VIEWS.filter((v) => !v.manager || manager).map((v) => (
            <SubLink
              key={v.href}
              href={v.href}
              active={pathname === v.href}
              onNavigate={onNavigate}
              icon={SETTINGS_ICON[v.href]}
            >
              {v.label}
            </SubLink>
          ))}
        </Group>
      </nav>

      <div className="space-y-1 border-t border-border px-4 pt-3 pb-4">
        <Link
          href="/alerts"
          onClick={onNavigate}
          aria-label={unreadAlerts > 0 ? `Alerts, ${unreadAlerts} unread` : "Alerts"}
          aria-current={pathname === "/alerts" ? "page" : undefined}
          className={rowClass(pathname === "/alerts")}
        >
          {pathname === "/alerts" ? <ActiveBar /> : null}
          <Glyph
            name="bell"
            className={cn("size-[18px] shrink-0", pathname === "/alerts" && "text-accent")}
          />
          <span className="flex-1">Alerts</span>
          <Count n={unreadAlerts} tone="hot" />
        </Link>

        {/* the button comes first in the page so Tab goes from it into the panel; the panel shows above it */}
        <div
          className="flex flex-col-reverse"
          onKeyDown={(e) => {
            if (e.key === "Escape" && account) {
              e.stopPropagation();
              setAccount(false);
              accountButton.current?.focus();
            }
          }}
        >
          <button
            ref={accountButton}
            type="button"
            aria-expanded={account}
            aria-controls="account-panel"
            aria-label="Account"
            onClick={() => setAccount((v) => !v)}
            className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface-3/50 p-2 text-left transition duration-150 hover:border-border-strong hover:bg-surface-2/60"
          >
            <Avatar name={user.name || user.email} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">
                {user.name || user.email.split("@")[0]}
              </span>
              <span className="block truncate text-[11.5px] text-muted">{user.roleLabel}</span>
            </span>
            <Glyph
              name="chevronDown"
              className={cn(
                "mr-1 size-4 text-muted transition-transform duration-300",
                account ? "" : "rotate-180",
              )}
            />
          </button>
          <div
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
              account ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
            inert={!account}
            id="account-panel"
          >
            <div className="overflow-hidden">
              <div className="space-y-2.5 px-1 pt-2 pb-2.5">
                <p className="eyebrow text-[10px]!">Appearance</p>
                <ThemeSwitch initial={theme} />
                <div className="flex items-center justify-between">
                  <Link
                    href="/settings"
                    onClick={onNavigate}
                    className="text-[13px] text-muted transition hover:text-text"
                  >
                    Account settings
                  </Link>
                  <LogoutButton email={user.email} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The shell's navigation. On a wide screen it is a fixed glass rail; below that it is a top bar whose menu button
 * slides the same rail in from the left. `data-app-header` lets power-dial mode make all of it inert.
 */
export function Sidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [sheet, onNativeClose, onKeyDown, onCancel] = useModal(open, close);
  const backdrop = useBackdropClose(sheet, close);
  return (
    <div data-app-header className="contents">
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[272px] border-r border-border lg:block">
        <SidebarBody {...props} />
      </aside>

      <header className="glass sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-3 lg:hidden">
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="inline-flex size-10 items-center justify-center rounded-full text-text-2 transition hover:bg-surface-2 active:scale-95"
        >
          <Glyph name="menu" className="size-5" />
        </button>
        <Link
          href="/"
          aria-label="Selective CRM home"
          className="flex size-10 items-center justify-center"
        >
          <Image
            src="/brand/SC-logomark-light-web.png"
            alt=""
            width={22}
            height={26}
            priority
            className="only-light"
          />
          <Image
            src="/brand/SC-logomark-dark-web.png"
            alt=""
            width={22}
            height={26}
            priority
            className="only-dark"
          />
        </Link>
        <span className="text-[15px] font-semibold tracking-tight">Selective</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Ask the assistant"
          onClick={openAssistantPanel}
          className="inline-flex size-10 items-center justify-center rounded-full text-accent transition hover:bg-surface-2 active:scale-95"
        >
          <Glyph name="sparkles" className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Find a merchant"
          onClick={openSearch}
          className="inline-flex size-10 items-center justify-center rounded-full text-text-2 transition hover:bg-surface-2 active:scale-95"
        >
          <Glyph name="search" className="size-5" />
        </button>
        <Link
          href="/alerts"
          aria-label={props.unreadAlerts > 0 ? `Alerts, ${props.unreadAlerts} unread` : "Alerts"}
          className="relative inline-flex size-10 items-center justify-center rounded-full text-text-2 transition hover:bg-surface-2 active:scale-95"
        >
          <Glyph name="bell" className="size-5" />
          {props.unreadAlerts > 0 ? (
            <span className="bg-brand absolute top-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-bg" />
          ) : null}
        </Link>
        <NewLeadButton variant="icon" />
      </header>

      <dialog
        ref={sheet}
        aria-label="Menu"
        onClose={onNativeClose}
        onKeyDown={onKeyDown}
        onCancel={onCancel}
        onPointerDown={backdrop.onPointerDown}
        onClick={backdrop.onClick}
        className="sheet-left glass-strong m-0 h-dvh max-h-none w-[min(86vw,320px)] max-w-none rounded-r-3xl border-r border-border p-0 text-text shadow-pop lg:hidden"
      >
        {open ? <SidebarBody {...props} onNavigate={close} /> : null}
      </dialog>
    </div>
  );
}
