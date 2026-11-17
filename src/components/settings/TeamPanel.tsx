"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { addTeamMemberAction, setTeamMemberAction } from "@/app/team-actions";
import { useApp } from "@/components/app-context";
import { useFormState, useRun } from "@/components/client/parts";
import { Avatar, Badge, Button, Field, Input, Select, cn } from "@/components/ui";
import { OFFERED_ROLES } from "@/lib/auth/roles";
import { timeAgo } from "@/lib/format";
import type { TeamMember } from "@/lib/settings/team";
import { SettingsCard, StatusChip } from "./primitives";

function AddMember() {
  const run = useRun();
  const router = useRouter();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const { v, bind, set } = useFormState(() => ({ email: "", name: "", role: "rep" }));
  return (
    <SettingsCard
      title="Add someone"
      description="They sign in with that Google account, so there is no password to send. A rep sees their own merchants; a manager sees and changes everything."
      footer={
        <Button type="submit" form={formId} variant="primary" disabled={busy}>
          {busy ? "Adding…" : "Add"}
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

  const active = members.filter((m) => m.active);
  const managers = active.filter((m) => m.role === "manager").length;
  const COLS =
    "md:grid md:grid-cols-[minmax(0,1fr)_7rem_5rem_6.75rem_6rem_5.5rem] md:items-center md:gap-x-3";
  return (
    <>
      <SettingsCard
        title="The team"
        description="Everyone who can sign in. Change a role in place, or disable an account that should no longer get in."
        aside={
          <span className="tabular-nums">
            {active.length} active · {managers} manager{managers === 1 ? "" : "s"}
          </span>
        }
        flush
      >
        <div className={cn("hidden border-b border-border bg-surface-3/60 px-5 py-2.5", COLS)}>
          <span className="eyebrow">Person</span>
          <span className="eyebrow">Role</span>
          <span className="eyebrow text-right">Merchants</span>
          <span className="eyebrow">Gmail</span>
          <span className="eyebrow">Last login</span>
          <span />
        </div>
        <ul className="divide-y divide-border text-[13px]">
          {members.map((m) => (
            <li
              key={m.id}
              className={cn(
                "flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/50 md:min-h-14 md:px-5 md:py-2",
                COLS,
                !m.active && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 basis-full items-center gap-3 md:basis-auto">
                <Avatar name={m.name || m.email} size={34} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{m.name || m.email}</span>
                    {m.id === meId ? <Badge tone="accent">you</Badge> : null}
                    {!m.active ? <Badge tone="warn">disabled</Badge> : null}
                  </span>
                  <span className="block truncate text-xs text-muted">{m.email}</span>
                </span>
              </span>
              <span>
                {m.id === meId ? (
                  <Badge tone={m.role === "manager" ? "accent" : "neutral"}>{m.role}</Badge>
                ) : (
                  <Select
                    aria-label={`Role for ${m.name || m.email}`}
                    value={m.role}
                    disabled={busy || !m.active}
                    onChange={(e) => void setMember(m, e.target.value, m.active)}
                    className="h-9 w-28 min-w-28 rounded-full px-3 text-[13px] sm:h-8"
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
              </span>
              <span className="tabular-nums md:text-right">
                <span className="font-semibold">{m.clients}</span>
                <span className="text-muted md:hidden"> merchants</span>
              </span>
              <span>
                {m.gmail_connected ? (
                  <StatusChip tone="good">Connected</StatusChip>
                ) : (
                  <StatusChip>No Gmail</StatusChip>
                )}
              </span>
              <span className="text-xs whitespace-nowrap text-muted">
                <span className="md:hidden">Last login </span>
                {m.last_login_at ? timeAgo(m.last_login_at, new Date(nowMs)) : "never"}
              </span>
              <span className="ml-auto md:ml-0 md:text-right">
                {m.id !== meId ? (
                  m.active ? (
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
                  )
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>
      <AddMember />
    </>
  );
}
