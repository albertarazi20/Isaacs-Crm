"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { addTeamMemberAction, setTeamMemberAction } from "@/app/team-actions";
import { accessHistoryAction, offboardUserAction } from "@/app/trust-actions";
import { useApp } from "@/components/app-context";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, Field, Input, Select, cn } from "@/components/ui";
import { ROLES } from "@/lib/auth/roles";
import { timeAgo } from "@/lib/format";
import type { AccessLine, OffboardReport, TeamMember, TrustRow } from "@/lib/trust/queries";
import { SettingsCard, SHEET } from "./primitives";

const TONE: Record<string, string> = {
  calm: "bg-good-soft text-good",
  watch: "bg-warn-soft text-warn",
  look: "bg-bad-soft text-bad",
};

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
            {ROLES.map((r) => (
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

function Offboard({
  m,
  others,
  onClose,
}: {
  m: TeamMember;
  others: TeamMember[];
  onClose: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [report, setReport] = useState<OffboardReport | null>(null);
  if (report) {
    const d = report.last_30_days;
    return (
      <FormDialog
        title={`${report.user} is out`}
        onClose={onClose}
        onSubmit={onClose}
        busy={false}
        submitLabel="Done"
      >
        <p className="text-sm">
          Login disabled, Gmail cut, {report.clients_moved} merchants and {report.deals_moved} deals
          moved to {report.to}.
        </p>
        <dl className="grid grid-cols-2 gap-x-4 text-sm">
          {Object.entries(d).map(([k, val]) => (
            <div key={k} className="flex justify-between border-b border-border py-1.5">
              <dt className="text-muted">{k.replace(/_/g, " ")}</dt>
              <dd className="font-semibold tabular-nums">{val}</dd>
            </div>
          ))}
        </dl>
      </FormDialog>
    );
  }
  return (
    <FormDialog
      title={`Offboard ${m.name || m.email}`}
      onClose={onClose}
      busy={busy}
      submitLabel="Offboard now"
      danger
      onSubmit={async () => {
        setBusy(true);
        const r = await offboardUserAction({ userId: m.id, reassignTo: to });
        setBusy(false);
        if (!r.ok) return toast({ message: r.error, tone: "error" });
        setReport(r.data);
        router.refresh();
      }}
    >
      <p className="text-sm text-muted">
        One click: the login dies now, their Gmail connection is cut, every merchant and deal moves
        to the person you pick, and you get the 30-day report of what they viewed, copied and
        exported.
      </p>
      <Field label="Their book goes to">
        <Select value={to} onChange={(e) => setTo(e.target.value)}>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name || o.email} ({o.role})
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}

export function TeamPanel({
  members,
  trust,
  meId,
}: {
  members: TeamMember[];
  trust: TrustRow[];
  meId: string;
}) {
  const { nowMs } = useApp();
  const run = useRun();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [offboarding, setOffboarding] = useState<TeamMember | null>(null);
  const [history, setHistory] = useState<{ userId: string; lines: AccessLine[] } | null>(null);
  const trustBy = new Map(trust.map((t) => [t.user_id, t]));

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
              <th className={SHEET.thNum}>Open deals</th>
              <th className={SHEET.th}>Gmail</th>
              <th className={SHEET.th}>Last login</th>
              <th className={SHEET.th}>Trust (30d)</th>
              <th className={SHEET.th}></th>
            </tr>
          </thead>
          <tbody className={SHEET.tbody}>
            {members.map((m) => {
              const t = trustBy.get(m.id);
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
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className={SHEET.tdNum}>{m.clients}</td>
                  <td className={SHEET.tdNum}>{m.open_deals}</td>
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
                  <td className={SHEET.td}>
                    {t ? (
                      <button
                        type="button"
                        className={cn(
                          "inline-flex h-7 items-center rounded-md px-2 text-[11px] font-semibold whitespace-nowrap tabular-nums transition hover:brightness-95",
                          TONE[t.tone],
                        )}
                        title={`copies ${t.contact_copies} · exports ${t.exports} · changes on live files ${t.contact_changes} · after-hours opens ${t.after_hours_opens} · canaries ${t.canaries_touched}`}
                        onClick={async () => {
                          const r = await accessHistoryAction({ userId: m.id, days: 30 });
                          if (!r.ok) return toast({ message: r.error, tone: "error" });
                          setHistory({ userId: m.id, lines: r.data });
                        }}
                      >
                        {t.tone} · {t.score}
                      </button>
                    ) : null}
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
                        {/* a disabled account still has a book to move: Offboard stays (P2-49) */}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => setOffboarding(m)}
                        >
                          Offboard
                        </Button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SettingsCard>
      {history ? (
        <SettingsCard
          title={`Last 30 days · ${members.find((m) => m.id === history.userId)?.name ?? ""}`}
          flush
          aside={
            <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
              Close
            </Button>
          }
        >
          {history.lines.length === 0 ? (
            <p className="border-t border-border px-4 py-3 text-sm text-muted">Nothing logged.</p>
          ) : (
            <ul className="divide-y divide-border border-t border-border text-[13px]">
              {history.lines.slice(0, 100).map((l, i) => (
                <li key={i} className="flex justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{l.action.replace(/_/g, " ")}</span>
                    {l.business_name ? (
                      <span className="text-muted"> · {l.business_name}</span>
                    ) : null}
                    {l.detail ? (
                      <span className="block truncate text-xs text-muted">{l.detail}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs whitespace-nowrap text-muted">
                    {timeAgo(l.at, new Date(nowMs))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      ) : null}
      {offboarding ? (
        <Offboard
          m={offboarding}
          others={members.filter((o) => o.id !== offboarding.id && o.active)}
          onClose={() => setOffboarding(null)}
        />
      ) : null}
    </div>
  );
}
