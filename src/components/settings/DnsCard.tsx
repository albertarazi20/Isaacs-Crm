"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkAutomationDnsAction } from "@/app/settings-actions";
import { useApp } from "@/components/app-context";
import { useCall, useToast } from "@/components/overlay";
import { Badge, Button, cn } from "@/components/ui";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { DnsView } from "@/lib/settings/dnsView";
import { CopyButton } from "./CopyButton";
import { ICON, Icon, SettingsCard } from "./primitives";

const STATE_BADGE = {
  ok: { tone: "good", text: "Verified" },
  failed: { tone: "bad", text: "Not verified" },
  unchecked: { tone: "neutral", text: "Not checked" },
  no_domain: { tone: "neutral", text: "No domain" },
} as const;

/** Where each record lives on the domain, so the person knows which name to open at their DNS host. */
const HOST: Record<string, (domain: string) => string> = {
  SPF: (d) => d,
  DKIM: (d) => `<selector>._domainkey.${d}`,
  DMARC: (d) => `_dmarc.${d}`,
};

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
      flush
      footer={
        <>
          <p className="mr-auto min-w-0 flex-1 basis-56 text-xs text-muted" data-dns="summary">
            {view.summary}
          </p>
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
            <Icon d={ICON.refresh} className={cn("size-3.5", busy && "animate-spin")} />
            {busy ? "Checking…" : "Check DNS"}
          </Button>
        </>
      }
    >
      <dl className="grid gap-x-8 gap-y-3 px-4 py-4 sm:grid-cols-2 sm:px-5">
        <div className="min-w-0">
          <dt className="eyebrow">Domain</dt>
          <dd className="mt-1 flex items-center gap-1">
            <span className="truncate font-mono text-sm font-medium" data-dns="domain">
              {view.domain || "none"}
            </span>
            {view.domain ? <CopyButton value={view.domain} label="the domain" /> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow">Last checked</dt>
          <dd className="mt-1 flex min-h-8 items-center">
            <span className="truncate text-sm font-medium tabular-nums" data-dns="checked">
              {view.checkedAt
                ? `${timeAgo(view.checkedAt, new Date(nowMs))} · ${formatDateTime(view.checkedAt, timezone)}`
                : "never"}
            </span>
          </dd>
        </div>
      </dl>
      {view.lines.length > 0 ? (
        <div
          tabIndex={0}
          role="region"
          aria-label="DNS records"
          className="overflow-x-auto border-t border-border focus-visible:outline-offset-[-2px]"
        >
          <table className="w-full text-[13px]">
            <thead className="max-sm:sr-only">
              <tr className="text-left">
                <th className="eyebrow border-b border-border bg-surface-3/60 py-2.5 pr-3 pl-4 sm:pl-5">
                  Record
                </th>
                <th className="eyebrow border-b border-border bg-surface-3/60 px-3 py-2.5">
                  Where it lives
                </th>
                <th className="eyebrow border-b border-border bg-surface-3/60 px-3 py-2.5">
                  What the check found
                </th>
                <th className="border-b border-border bg-surface-3/60 py-2.5 pr-4 pl-3 sm:pr-5">
                  <span className="sr-only">Copy</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.lines.map((l) => (
                <tr
                  key={l.label}
                  className="transition-colors duration-150 hover:bg-surface-2/50 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2 max-sm:px-4 max-sm:py-3"
                >
                  <td className="py-2.5 pr-3 pl-4 align-top whitespace-nowrap max-sm:p-0 sm:pl-5">
                    <span className="inline-flex items-center gap-2">
                      <Icon
                        d={l.ok ? ICON.check : ICON.alert}
                        className={l.ok ? "text-good" : "text-bad"}
                      />
                      <span>
                        <span className="font-semibold">{l.label}</span>{" "}
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
                            l.ok ? "bg-good-soft text-good" : "bg-bad-soft text-bad",
                          )}
                        >
                          {l.ok ? "found" : "missing"}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-top font-mono text-xs text-text-2 max-sm:order-3 max-sm:col-span-2 max-sm:px-0 max-sm:pt-1.5 max-sm:pb-0">
                    <span className="break-all">{HOST[l.label]?.(view.domain) ?? view.domain}</span>
                  </td>
                  <td className="px-3 py-2.5 align-top text-xs text-muted max-sm:order-4 max-sm:col-span-2 max-sm:px-0 max-sm:pt-1 max-sm:pb-0">
                    <span className={cn("break-words", l.ok && "font-mono break-all")}>
                      {l.detail}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 pl-3 text-right align-top max-sm:order-2 max-sm:p-0 sm:pr-4">
                    <CopyButton
                      value={l.ok ? l.detail : (HOST[l.label]?.(view.domain) ?? view.domain)}
                      label={l.ok ? `the ${l.label} record` : `the ${l.label} host name`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SettingsCard>
  );
}
