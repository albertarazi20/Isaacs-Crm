"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createLeadTokenAction, revokeLeadTokenAction } from "@/app/lead-actions";
import type { LeadTokenRow } from "@/lib/leads/queries";
import { timeAgo } from "@/lib/format";
import { useApp } from "./app-context";
import { useCall } from "./overlay";
import { CopyButton } from "./settings/CopyButton";
import { ICON, Icon, SettingsCard, StatusChip } from "./settings/primitives";
import { Button, Field, Input } from "./ui";

const EXAMPLE = (endpoint: string, token: string) =>
  `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"businessName":"Mike'"'"'s Pizza","contactName":"Mike Ross","phone":"305-555-0100","wantedAmount":"50k","source":"My website"}'`;

const FIELDS = [
  "businessName",
  "contactName",
  "phone",
  "email",
  "wantedAmount",
  "industry",
  "state",
  "source",
  "notes",
] as const;

/**
 * Web lead connections: one secret per place leads come from (a website form, Zapier, a vendor). The secret is
 * shown once, at the moment it is made; after that only its name, age and last use.
 */
export function LeadIntakePanel({
  tokens,
  endpoint,
}: {
  tokens: LeadTokenRow[];
  endpoint: string;
}) {
  const router = useRouter();
  const call = useCall();
  const { nowMs } = useApp();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    const made = await call(createLeadTokenAction({ label }));
    setBusy(false);
    if (!made) return;
    setFresh(made.token);
    setLabel("");
    router.refresh();
  }

  async function revoke(id: string) {
    setBusy(true);
    const done = await call(revokeLeadTokenAction({ id }), "Connection turned off");
    setBusy(false);
    setConfirming(null);
    if (done !== null) router.refresh();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }

  return (
    <SettingsCard
      id="web-leads"
      title="Web lead connections"
      description="Send new merchants straight in from your website form, Zapier or a lead vendor. Each one arrives as a call-now lead. A merchant already in your list is not added twice: you get a note and the follow-up moves to today."
      aside={
        tokens.length > 0 ? (
          <StatusChip tone="good">
            {tokens.length} live connection{tokens.length === 1 ? "" : "s"}
          </StatusChip>
        ) : (
          <StatusChip>None yet</StatusChip>
        )
      }
      flush
    >
      <div className="px-4 py-4 sm:px-5">
        <p className="eyebrow mb-2">Address to send to</p>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-3 py-1 pr-1 pl-3.5">
          <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-accent">
            POST
          </span>
          <code className="min-w-0 flex-1 truncate px-1.5 font-mono text-[13px] text-text-2">
            {endpoint}
          </code>
          <CopyButton value={endpoint} label="the address" />
        </div>
        <p className="mt-2 text-xs text-muted">
          Send it with the connection&apos;s secret as a Bearer token. A phone or an email, and a
          business or contact name, is enough.
        </p>
      </div>

      {fresh ? (
        <div
          role="alert"
          className="animate-rise space-y-3 border-t border-warn/30 bg-warn-soft/50 px-4 py-4 sm:px-5"
        >
          <div className="flex items-start gap-2.5">
            <Icon d={ICON.alert} className="mt-0.5 text-warn" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Copy this now. It is shown once.</p>
              <p className="mt-0.5 text-[13px] text-muted">
                Only a fingerprint is kept. If you lose it, turn the connection off and make a new
                one. Keep it on a server or inside Zapier, never in a web page.
              </p>
            </div>
          </div>
          <code className="block overflow-x-auto rounded-xl border border-border bg-surface p-3 font-mono text-[13px] break-all">
            {fresh}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void copy(fresh)}>
              {copied ? "Copied" : "Copy token"}
            </Button>
            <Button size="sm" onClick={() => setFresh(null)}>
              I&apos;ve saved it
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-[13px] font-medium">Example request</summary>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-surface p-3 font-mono text-xs">
              {EXAMPLE(endpoint, fresh)}
            </pre>
          </details>
        </div>
      ) : null}

      {tokens.length === 0 ? (
        <p className="flex items-center gap-3 border-t border-border px-4 py-4 text-[13px] text-muted sm:px-5">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong"
          >
            <Icon d={ICON.plug} className="size-4" />
          </span>
          No connections yet. Make one for each place leads come from, so you can turn one off
          without touching the others.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/50 sm:px-5"
            >
              <span
                aria-hidden
                className={`hidden size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-3 sm:flex ${t.last_used_at ? "text-good" : "text-muted"}`}
              >
                <Icon d={ICON.plug} className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-sm font-semibold">{t.label}</p>
                <p className="text-xs text-muted">
                  Made {timeAgo(t.created_at, new Date(nowMs))} ·{" "}
                  {t.last_used_at
                    ? `last lead ${timeAgo(t.last_used_at, new Date(nowMs))}`
                    : "never used"}
                </p>
              </div>
              {confirming === t.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void revoke(t.id)}
                  >
                    Yes, turn it off
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirming(t.id)}>
                  Turn off
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2 border-t border-border bg-surface-3/50 px-4 py-4 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Where will the leads come from?" className="min-w-0 flex-1 basis-56">
          <Input
            placeholder="e.g. My website, Zapier, Lead vendor X"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || label.trim() === ""}>
          <Icon d={ICON.plus} className="size-3.5" />
          Make a connection
        </Button>
      </form>

      <div className="border-t border-border px-4 py-3.5 sm:px-5">
        <p className="eyebrow mb-2">Fields it accepts</p>
        <div className="flex flex-wrap gap-1.5">
          {FIELDS.map((f) => (
            <span
              key={f}
              className="rounded-full border border-border bg-surface-3 px-2 py-0.5 font-mono text-[11px] text-text-2"
            >
              {f}
            </span>
          ))}
        </div>
      </div>
    </SettingsCard>
  );
}
