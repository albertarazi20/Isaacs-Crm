"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkAutomationDnsAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { useCall, useToast } from "@/components/overlay";
import { Badge, Button } from "@/components/ui";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { DnsView } from "@/lib/settings/dnsView";
import { ICON, Icon, Note, SettingsCard } from "./primitives";

const STATE_BADGE = {
  ok: { tone: "good", text: "Verified" },
  failed: { tone: "bad", text: "Not verified" },
  unchecked: { tone: "neutral", text: "Not checked" },
  no_domain: { tone: "neutral", text: "No domain" },
} as const;

/**
 * The DNS gate (S1-4) on the page: the automation domain, the last stored check (when, and what SPF, DKIM and DMARC
 * said), and the button that runs it again. The engine sends from the domain only while all three are found.
 */
export function DnsCard({ view }: { view: DnsView }) {
  const { nowMs, timezone } = useApp();
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const badge = STATE_BADGE[view.state];
  return (
    <SettingsCard
      title="Automation domain check"
      description="Automated email goes out from the domain in the automation sender only after SPF, DKIM and DMARC are all published for it. Save the sender first: a new sender clears the last result."
      aside={<Badge tone={badge.tone}>{badge.text}</Badge>}
      footer={
        <Button
          disabled={busy || view.state === "no_domain"}
          onClick={async () => {
            setBusy(true);
            const r = await call(checkAutomationDnsAction());
            setBusy(false);
            if (!r) return;
            toast({ message: r.summary, tone: r.ok ? "success" : "error" });
            router.refresh();
          }}
        >
          {busy ? "Checking…" : "Check DNS"}
        </Button>
      }
    >
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">Domain</dt>
          <dd className="truncate font-medium" data-dns="domain">
            {view.domain || "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Last checked
          </dt>
          <dd className="truncate font-medium tabular-nums" data-dns="checked">
            {view.checkedAt
              ? `${timeAgo(view.checkedAt, new Date(nowMs))} · ${formatDateTime(view.checkedAt, timezone)}`
              : "never"}
          </dd>
        </div>
      </dl>
      {view.lines.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border text-[13px]">
          {view.lines.map((l) => (
            <li key={l.label} className="flex items-start gap-2.5 px-3 py-2">
              <Icon
                d={l.ok ? ICON.check : ICON.alert}
                className={l.ok ? "mt-0.5 text-good" : "mt-0.5 text-bad"}
              />
              <span className="min-w-0">
                <span className="font-semibold">{l.label}</span>{" "}
                <span className="font-medium">{l.ok ? "found" : "missing"}</span>
                <span className="block text-xs break-words text-muted">{l.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Note className="mt-3">{view.summary}</Note>
      )}
      {view.lines.length > 0 ? (
        <p className="mt-2 text-xs text-muted" data-dns="summary">
          {view.summary}
        </p>
      ) : null}
    </SettingsCard>
  );
}
