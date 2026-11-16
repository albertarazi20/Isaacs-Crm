"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createLeadTokenAction, revokeLeadTokenAction } from "@/app/lead-actions";
import type { LeadTokenRow } from "@/lib/leads/queries";
import { timeAgo } from "@/lib/format";
import { useApp } from "./app-context";
import { useCall } from "./overlay";
import { Button, Card, Field, Input, SectionTitle } from "./ui";

const EXAMPLE = (endpoint: string, token: string) =>
  `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"businessName":"Mike'"'"'s Pizza","contactName":"Mike Ross","phone":"305-555-0100","wantedAmount":"50k","source":"My website"}'`;

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
      /* clipboard blocked — the text is selectable */
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Lead intake</h1>
        <p className="mt-1 text-sm text-muted">
          Send new merchants straight in from your website form, Zapier or a lead vendor. Each one
          lands on Today as <em>call now</em>. A merchant already in your list is not added twice —
          you get a note and the follow-up moves to today.
        </p>
      </div>

      {fresh ? (
        <Card className="border-warn/40 p-4">
          <div role="alert" className="space-y-3">
            <SectionTitle>Copy this now — it is shown once</SectionTitle>
            <p className="text-sm text-muted">
              Only a fingerprint is kept. If you lose it, turn the connection off and make a new
              one. Keep it on a server or inside Zapier — never in a web page.
            </p>
            <code className="block overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[13px] break-all">
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
              <summary className="cursor-pointer text-sm font-medium">Example request</summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
                {EXAMPLE(endpoint, fresh)}
              </pre>
              <p className="mt-2 text-sm text-muted">
                Fields: businessName, contactName, phone, email, wantedAmount, industry, state,
                source, notes. Send a phone or an email, and a business or contact name.
              </p>
            </details>
          </div>
        </Card>
      ) : null}

      <Card className="p-4">
        <SectionTitle
          aside={
            tokens.length > 0 ? (
              <span className="text-xs text-muted tabular-nums">{tokens.length}</span>
            ) : undefined
          }
        >
          Connections
        </SectionTitle>
        {tokens.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            None yet. Make one for each place leads come from.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.label}</p>
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
                    <Button size="sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirming(t.id)}>
                    Turn off
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="Where will the leads come from?" className="min-w-0 flex-1 sm:flex-none">
            <Input
              className="sm:w-72"
              placeholder="e.g. My website, Zapier, Lead vendor X"
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || label.trim() === ""}>
            Make a connection
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted">
          Address to send to: <code className="font-mono break-all">{endpoint}</code>
        </p>
      </Card>
    </div>
  );
}
