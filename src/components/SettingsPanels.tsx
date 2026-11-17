"use client";

import { useState } from "react";
import { disconnectGmailAction, sendTestReminderAction, updateSettingsAction } from "@/app/actions";
import { useRun } from "./client/parts";
import { useCall, useToast } from "./overlay";
import { SettingRow, SettingsCard, StatusChip } from "./settings/primitives";
import { Toggle } from "./settings/Toggle";
import { Button, buttonClass, Field, Select } from "./ui";

const ZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
] as const;

interface Props {
  loginEmail: string;
  settings: { timezone: string; digestEnabled: boolean; digestHour: number };
  gmail: {
    connected: boolean;
    needsReconnect: boolean;
    googleEmail: string | null;
    configured: boolean;
  };
  resendReady: boolean;
  /** The hourly scheduler that sends the reminder emails: whether it is running, in one line. */
  scheduler: { tone: "good" | "warn" | "bad" | "neutral"; label: string; detail: string };
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

export function SettingsPanels({ loginEmail, settings, gmail, resendReady, scheduler }: Props) {
  const call = useCall();
  const run = useRun();
  const toast = useToast();
  const [form, setForm] = useState(settings);
  const [saved, setSaved] = useState(settings);
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  const zones = ZONES.some(([z]) => z === form.timezone)
    ? ZONES
    : [...ZONES, [form.timezone, form.timezone] as const];
  const dirty =
    form.timezone !== saved.timezone ||
    form.digestEnabled !== saved.digestEnabled ||
    form.digestHour !== saved.digestHour;

  async function save() {
    setBusy("save");
    const sent = form;
    const ok = await run(updateSettingsAction(sent), "Settings saved");
    setBusy(null);
    if (ok) setSaved(sent);
  }

  async function test() {
    setBusy("test");
    const r = await call(sendTestReminderAction());
    setBusy(null);
    if (r) {
      toast({
        message: r.usedSample
          ? `Preview sent to ${r.to}`
          : `Sent your ${r.count} due follow-up${r.count === 1 ? "" : "s"} to ${r.to}`,
        tone: "success",
      });
    }
  }

  return (
    <>
      <SettingsCard
        title="Reminders"
        description="One email each morning listing what is overdue and due today, with a link to each merchant."
        flush
        footer={
          <>
            <span className="mr-auto text-xs text-muted">
              {!resendReady ? (
                <span className="text-warn">Email sending is not set up on the server yet.</span>
              ) : dirty ? (
                <span className="font-medium text-accent">Unsaved changes</span>
              ) : null}
            </span>
            <Button disabled={busy !== null || !resendReady} onClick={() => void test()}>
              {busy === "test" ? "Sending…" : "Send me a test email"}
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="px-4 py-2 sm:px-5">
          <Toggle
            label="Email me my follow-ups every morning"
            hint={
              <>
                Goes to <span className="font-medium text-text-2">{loginEmail}</span>, the Google
                account you signed in with.
              </>
            }
            checked={form.digestEnabled}
            onChange={(x) => setForm({ ...form, digestEnabled: x })}
          />
        </div>
        <div className="grid gap-3 border-t border-border px-4 py-4 sm:grid-cols-2 sm:px-5">
          <Field label="Send at">
            <Select
              value={form.digestHour}
              onChange={(e) => setForm({ ...form, digestHour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="My time zone">
            <Select
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            >
              {zones.map(([z, label]) => (
                <option key={z} value={z}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SettingRow label="Hourly reminder scheduler" hint={scheduler.detail}>
          <StatusChip tone={scheduler.tone}>{scheduler.label}</StatusChip>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Gmail"
        description="Connect your Gmail so emails to merchants go out from your own address and land in your Sent folder."
        aside={
          !gmail.configured ? (
            <StatusChip tone="warn">Not set up</StatusChip>
          ) : gmail.connected ? (
            <StatusChip tone="good">Connected</StatusChip>
          ) : gmail.needsReconnect ? (
            <StatusChip tone="warn">Needs reconnect</StatusChip>
          ) : (
            <StatusChip>Not connected</StatusChip>
          )
        }
        flush
      >
        {!gmail.configured ? (
          <SettingRow
            label="Google sign-in is not configured"
            hint="The server needs its Google keys before anyone can connect a mailbox."
          />
        ) : gmail.connected ? (
          <SettingRow
            label={gmail.googleEmail ?? "Your Gmail"}
            hint="Sends as you. Replies are read for alerts."
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("disconnect");
                await call(disconnectGmailAction(), "Gmail disconnected");
                setBusy(null);
              }}
            >
              Disconnect
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            label={
              gmail.needsReconnect ? (gmail.googleEmail ?? "Your Gmail") : "No mailbox connected"
            }
            hint={
              gmail.needsReconnect
                ? "Google expired the permission. Until you reconnect, emails open in Gmail instead of sending."
                : "Until you connect, emails open in Gmail instead of sending from here."
            }
          >
            <a className={buttonClass("secondary", "sm")} href="/api/auth/google?purpose=gmail">
              {gmail.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}
            </a>
          </SettingRow>
        )}
      </SettingsCard>
    </>
  );
}
