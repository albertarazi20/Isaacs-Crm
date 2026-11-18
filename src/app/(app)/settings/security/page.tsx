import type { Metadata } from "next";
import { SettingRow, SettingsCard } from "@/components/settings/primitives";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { Badge, Button, Field, Select, type Tone } from "@/components/ui";
import { CAN } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import {
  AUDIT_KIND_LABELS,
  AUDIT_KINDS,
  AUDIT_PAGE_SIZE,
  auditPeople,
  browserOf,
  describeEvent,
  listAuditEvents,
} from "@/lib/settings/securityLog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Security" };

const TONE: Record<string, Tone> = {
  signin_failed: "bad",
  export_blocked: "bad",
  session_killed: "warn",
  team_disabled: "warn",
  signout_everywhere: "warn",
  export_download: "info",
};

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Managers only (requireRole sends a rep home). The last 200 lines of the audit log, filterable. */
export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireRole(CAN.manageTeam);
  const sp = await searchParams;
  const kind = one(sp.kind) ?? "";
  const user = one(sp.user) ?? "";
  const { rows, people, tz } = await db.withUser(session.userId, async (q) => ({
    rows: await listAuditEvents(q, { kind, userId: user }),
    people: await auditPeople(q),
    tz: (await userContext(q)).timezone,
  }));
  const filtered = Boolean(kind || user);
  return (
    <SettingsPage
      role={session.role}
      current="/settings/security"
      title="Security"
      description="Who signed in, from where, what they changed and what they downloaded. Lines are kept for 180 days and cannot be edited."
    >
      <SettingsCard
        title="Activity"
        description={`The last ${AUDIT_PAGE_SIZE} lines, newest first. You get an alert for a sign-in from a new device, a big or frequent export, and repeated failed sign-ins.`}
        flush
        footer={
          <p className="mr-auto text-xs text-muted tabular-nums">
            {rows.length === 0
              ? filtered
                ? "Nothing matches."
                : "Nothing yet."
              : `${rows.length} shown`}
          </p>
        }
      >
        <form
          method="get"
          className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3.5 sm:px-5"
        >
          <Field label="What">
            <Select name="kind" defaultValue={kind} className="min-w-44">
              <option value="">Everything</option>
              {AUDIT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {AUDIT_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who">
            <Select name="user" defaultValue={user} className="min-w-52">
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.email}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary">
            Filter
          </Button>
          {filtered ? (
            <a href="/settings/security" className="pb-2 text-[13px] text-muted underline">
              Clear
            </a>
          ) : null}
        </form>
        {rows.length === 0 ? null : (
          <div className="[&>:first-child]:border-t-0">
            {rows.map((r) => (
              <SettingRow
                key={r.id}
                label={
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={TONE[r.kind] ?? "neutral"}>
                      {AUDIT_KIND_LABELS[r.kind as keyof typeof AUDIT_KIND_LABELS] ?? r.kind}
                    </Badge>
                    <span className="min-w-0 break-words text-text">{describeEvent(r)}</span>
                  </span>
                }
                hint={
                  r.ip || r.user_agent
                    ? [r.ip, r.user_agent ? browserOf(r.user_agent) : ""]
                        .filter(Boolean)
                        .join(" · ")
                    : undefined
                }
              >
                <span
                  className="text-xs whitespace-nowrap text-muted tabular-nums"
                  title={r.at.replace("T", " ").replace("Z", " UTC")}
                >
                  {formatDateTime(r.at, tz)}
                </span>
              </SettingRow>
            ))}
          </div>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
