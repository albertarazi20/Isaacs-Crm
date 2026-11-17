"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { addTeamMemberAction, setTeamMemberAction } from "@/app/team-actions";
import { useApp } from "@/components/app-context";
import { useFormState, useRun } from "@/components/client/parts";
import { Button, Field, Input, Select, cn } from "@/components/ui";
import { OFFERED_ROLES } from "@/lib/auth/roles";
import { timeAgo } from "@/lib/format";
import type { TeamMember } from "@/lib/settings/team";
import { SettingsCard, SHEET } from "./primitives";

function AddMember() {
  const run = useRun();
  const router = useRouter();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({ email: "", name: "", role: "rep" }));
  return (
    <SettingsCard
      title="Add someone"
      footer={
        <Button type="submit" form={formId} variant="primary" disabled={busy}>
          Add
        </Button>
      }
    >
      <form
        id={formId}
        className="grid gap-3 sm:grid-cols-[1fr_1.2fr_8rem]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await run(
            addTeamMemberAction(v),
            "Added — they sign in with that Google account",
          );
          setBusy(false);
          if (ok) {
            set("email", "");
            set("name", "");
            router.refresh();
          }
        }}
      >
        <Field label="Name">
          <Input {...bind("name")} placeholder="Sam Rivera" required />
        </Field>
        <Field label="selectivecap.com email">
          <Input {...bind("email")} type="email" placeholder="sam@selectivecap.com" required />
        </Field>
        <Field label="Role">
          <Select {...bind("role")}>
            {OFFERED_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </SettingsCard>
  );
}

export function TeamPanel({ members, meId }: { members: TeamMember[]; meId: string }) {
  const { nowMs } = useApp();
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setMember(m: TeamMember, role: string, active: boolean) {
    setBusy(true);
    const ok = await run(setTeamMemberAction({ userId: m.id, role, active }), "Saved");
    setBusy(false);
    if (ok) router.refresh();
  }

  return (
    <div className="space-y-5">
      <AddMember />
      <SettingsCard title="The team" flush className="min-w-0 overflow-x-auto">
        <table className={cn(SHEET.table, "border-t border-border")}>
          <thead className={SHEET.thead}>
            <tr>
              <th className={SHEET.th}>Person</th>
              <th className={SHEET.th}>Role</th>
              <th className={SHEET.thNum}>Merchants</th>
              <th className={SHEET.th}>Gmail</th>
              <th className={SHEET.th}>Last login</th>
              <th className={SHEET.th}></th>
            </tr>
          </thead>
          <tbody className={SHEET.tbody}>
            {members.map((m) => {
              return (
                <tr key={m.id} className={cn(SHEET.tr, !m.active && "opacity-60")}>
                  <td className={cn(SHEET.td, "max-w-56")}>
                    <span className="block truncate font-semibold">{m.name || m.email}</span>
                    <span className="block truncate text-xs text-muted">{m.email}</span>
                  </td>
                  <td className={SHEET.td}>
                    {m.id === meId ? (
                      <span>{m.role}</span>
                    ) : (
                      <Select
                        aria-label={`Role for ${m.name || m.email}`}
                        value={m.role}
                        disabled={busy || !m.active}
                        onChange={(e) => void setMember(m, e.target.value, m.active)}
                        className="h-9 w-28 min-w-28 px-2 text-[13px] sm:h-8"
                      >
                        {[
                          ...OFFERED_ROLES,
                          ...(OFFERED_ROLES.some((r) => r === m.role) ? [] : [m.role]),
                        ].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className={SHEET.tdNum}>{m.clients}</td>
                  <td className={cn(SHEET.td, "text-xs")}>
                    {m.gmail_connected ? (
                      <span className="font-medium text-good">connected</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={cn(SHEET.td, "text-xs whitespace-nowrap text-muted")}>
                    {m.last_login_at ? timeAgo(m.last_login_at, new Date(nowMs)) : "never"}
                  </td>
                  <td className={cn(SHEET.td, "text-right whitespace-nowrap")}>
                    {m.id !== meId ? (
                      <span className="inline-flex gap-1">
                        {m.active ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void setMember(m, m.role, false)}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void setMember(m, m.role, true)}
                          >
                            Re-enable
                          </Button>
                        )}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SettingsCard>
    </div>
  );
}
