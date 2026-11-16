"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveRegistrationAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { FormDialog, useFormState, useRun } from "@/components/client/parts";
import { Badge, Button, Field, Input, Select, cn } from "@/components/ui";
import type { RegistrationStatus } from "@/lib/settings/schemas";
import { renewalTone, type StateLine } from "@/lib/settings/states";
import { Note, SettingsCard, SHEET } from "./primitives";

const STATUS_LABEL: Record<RegistrationStatus, string> = {
  none: "None",
  filed: "Filed, not yet granted",
  registered: "Registered",
  exempt: "Exempt",
};

const STATUS_TONE: Record<RegistrationStatus, "neutral" | "warn" | "good" | "info"> = {
  none: "neutral",
  filed: "warn",
  registered: "good",
  exempt: "info",
};

function RulesBadges({ s }: { s: StateLine }) {
  const items = [
    s.broker_registration ? "Broker registration" : null,
    s.registration_deadline && !s.broker_registration
      ? `Registration from ${s.registration_deadline}`
      : null,
    s.advance_fee_ban ? "No advance fee" : null,
    s.apr_wording_rule ? "Rate wording rule" : null,
    s.disclosure_law ? "Disclosure law" : null,
  ].filter((x): x is string => x !== null);
  if (items.length === 0) return <span className="text-xs text-muted">No special rules</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i} tone={i === "Broker registration" ? "accent" : "neutral"}>
          {i}
        </Badge>
      ))}
    </span>
  );
}

function RegistrationDialog({
  line,
  choices,
  onClose,
}: {
  /** The state being edited; null adds a new registration. */
  line: StateLine | null;
  /** The states a new registration may be for. */
  choices: StateLine[];
  onClose: () => void;
}) {
  const run = useRun();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { v, bind } = useFormState(() => ({
    state: line?.state ?? choices[0]?.state ?? "",
    status: (line?.status ?? "registered") as string,
    registrationNo: line?.registration_no ?? "",
    renewsOn: line?.renews_on ?? "",
    note: line?.registration_note ?? "",
  }));
  return (
    <FormDialog
      title={
        line
          ? line.status === null
            ? `Add a ${line.state} registration`
            : `${line.state} registration`
          : "Add a registration"
      }
      onClose={onClose}
      busy={busy}
      submitLabel="Save registration"
      onSubmit={async () => {
        setBusy(true);
        const ok = await run(saveRegistrationAction(v), "Registration saved");
        setBusy(false);
        if (ok) {
          onClose();
          router.refresh();
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="State">
          <Select {...bind("state")} disabled={line !== null} required>
            {(line ? [line] : choices).map((c) => (
              <option key={c.state} value={c.state}>
                {c.state} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select {...bind("status")}>
            {(Object.keys(STATUS_LABEL) as RegistrationStatus[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Registration number">
          <Input {...bind("registrationNo")} placeholder="OCCC-12345" />
        </Field>
        <Field label="Renews on" hint="Managers are told 30 days before and again if it lapses">
          <Input type="date" {...bind("renewsOn")} />
        </Field>
      </div>
      <Field label="Note">
        <Input {...bind("note")} placeholder="Bond filed, renewal reminder set with the lawyer" />
      </Field>
    </FormDialog>
  );
}

/**
 * The shop's registration in each state, beside the rules the shop's lawyer keeps (0350). The rules are read-only here;
 * a registration is added, or its status, number and renewal date edited. Managers only.
 */
export function StatesEditor({ lines }: { lines: StateLine[] }) {
  const { today } = useApp();
  const [editing, setEditing] = useState<StateLine | "new" | null>(null);
  const without = lines.filter((l) => l.status === null);
  return (
    <div className="space-y-5">
      <Note>
        The shop&apos;s lawyer maintains the rules in this list. To add a state or change what a
        state requires, ask them. This page only records where the shop is registered and when each
        registration renews.
      </Note>
      <SettingsCard
        title="Registrations by state"
        description="A deal for a state that needs a broker registration is flagged when it goes to ops and the shop has none registered. Managers are told 30 days before a registration renews."
        flush
        className="relative min-w-0 overflow-x-auto"
        aside={
          <Button
            size="sm"
            variant="primary"
            disabled={without.length === 0}
            onClick={() => setEditing("new")}
          >
            + Registration
          </Button>
        }
      >
        <table className={cn(SHEET.table, "border-t border-border")}>
          <thead className={SHEET.thead}>
            <tr>
              <th className={SHEET.th}>State</th>
              <th className={SHEET.th}>The rules say</th>
              <th className={SHEET.th}>Shop registration</th>
              <th className={SHEET.th}>Renews</th>
              <th className={SHEET.th}>
                <span className="sr-only">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody className={SHEET.tbody}>
            {lines.map((l) => {
              const renew = renewalTone(l.renews_on, today);
              return (
                <tr key={l.state} className={SHEET.tr} data-state-row={l.state}>
                  <td className={cn(SHEET.td, "whitespace-nowrap")}>
                    <span className="font-semibold">{l.state}</span>{" "}
                    <span className="text-xs text-muted">{l.name}</span>
                  </td>
                  <td className={cn(SHEET.td, "min-w-48")}>
                    <RulesBadges s={l} />
                  </td>
                  <td className={SHEET.td}>
                    {l.status === null ? (
                      <Badge tone={l.broker_registration ? "bad" : "neutral"}>
                        {l.broker_registration ? "needed, none on file" : "none on file"}
                      </Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
                        {l.registration_no ? (
                          <span className="text-xs text-muted">{l.registration_no}</span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className={cn(SHEET.td, "whitespace-nowrap tabular-nums")}>
                    {l.renews_on ? (
                      <>
                        {l.renews_on}{" "}
                        <Badge tone={renew.tone === "neutral" ? "neutral" : renew.tone}>
                          {renew.text}
                        </Badge>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={cn(SHEET.td, "text-right whitespace-nowrap")}>
                    <Button
                      size="sm"
                      aria-label={`${l.status === null ? "Add" : "Edit"} ${l.state} registration`}
                      onClick={() => setEditing(l)}
                    >
                      {l.status === null ? "Add" : "Edit"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SettingsCard>
      {editing ? (
        <RegistrationDialog
          line={editing === "new" ? null : editing}
          choices={without}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
