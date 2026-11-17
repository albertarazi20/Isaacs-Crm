import type { ReactNode } from "react";
import { PageHeader, Segmented } from "@/components/ui";
import type { Role } from "@/lib/auth/roles";
import { SETTINGS_VIEWS } from "@/lib/nav";

/**
 * The six settings pages as one compact control. The sidebar already lists them on a wide screen, so this is only
 * drawn below that width, where the sidebar is behind the menu button and a thumb wants the pages one tap away.
 */
export function SettingsNav({
  role,
  current,
  className,
}: {
  role: Role;
  current: string;
  className?: string;
}) {
  return (
    <Segmented
      label="Settings pages"
      className={className}
      items={SETTINGS_VIEWS.filter((i) => !i.manager || role === "manager").map((i) => ({
        href: i.href,
        label: i.label,
        active: i.href === current,
      }))}
    />
  );
}

/**
 * The frame every settings page shares: the page header, the phone-only page switcher, then the topics in one
 * column, each a `SettingsCard` (title and one line on the left, its panel on the right).
 */
export function SettingsPage({
  role,
  current,
  title,
  description,
  actions,
  notice,
  children,
}: {
  role: Role;
  current: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A status line shown under the header (a connect result, a missing key). */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1120px]">
      <PageHeader eyebrow="Settings" title={title} description={description} actions={actions} />
      <div className="mt-4 flex lg:hidden">
        <SettingsNav role={role} current={current} />
      </div>
      {notice ? <div className="mt-5">{notice}</div> : null}
      <div className="mt-6">{children}</div>
    </div>
  );
}
