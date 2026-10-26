"use client";

import { useState } from "react";
import { disconnectGmailAction, sendTestReminderAction, updateSettingsAction } from "@/app/actions";
import { useCall, useToast } from "./overlay";
import { Button, buttonClass, Card, Field, Select } from "./ui";

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
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

export function SettingsPanels({ loginEmail, settings, gmail, resendReady }: Props) {
  const call = useCall();
  const toast = useToast();
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | null>(null);
  const zones = ZONES.some(([z]) => z === form.timezone)
    ? ZONES
    : [...ZONES, [form.timezone, form.timezone] as const];

  async function save() {
    setBusy("save");
    await call(updateSettingsAction(form), "Settings saved");
    setBusy(null);
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
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Reminders</h2>
          <p className="text-sm text-muted">
            One email each morning listing what&apos;s overdue and due today, with a link to each
            client.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={form.digestEnabled}
            onChange={(e) => setForm({ ...form, digestEnabled: e.target.checked })}
          />
          Email me my follow-ups every morning
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
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
        <p className="text-sm text-muted">
          Reminders go to <strong>{loginEmail}</strong> — the Google account you signed in with.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button disabled={busy !== null || !resendReady} onClick={() => void test()}>
            {busy === "test" ? "Sending…" : "Send me a test email"}
          </Button>
          {!resendReady ? (
            <span className="text-sm text-warn">
              Email sending isn&apos;t set up on the server yet.
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <h2 className="text-base font-semibold">Gmail</h2>
          <p className="text-sm text-muted">
            Connect your Gmail so emails to merchants go out from your own address and land in your
            Sent folder.
          </p>
        </div>
        {!gmail.configured ? (
          <p className="text-sm text-warn">
            Google sign-in isn&apos;t configured on the server yet.
          </p>
        ) : gmail.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-good">Connected as {gmail.googleEmail}</p>
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
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {gmail.needsReconnect ? (
              <p className="text-sm text-warn">
                Google expired the permission for {gmail.googleEmail}.
              </p>
            ) : null}
            <a className={buttonClass("primary", "md")} href="/api/auth/google?purpose=gmail">
              {gmail.needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}
