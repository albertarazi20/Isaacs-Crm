import { automationDomain, describeDnsCheck, type DnsCheck } from "../send/dns";

/**
 * What the Check DNS card shows, from the stored result (shop_settings.dns_*). Pure: the page builds it on the
 * server and hands plain props to the card, so the browser never loads the resolver.
 */
export interface DnsView {
  /** The domain the next check looks at, taken from the automation sender; "" when none is set. */
  domain: string;
  state: "no_domain" | "unchecked" | "ok" | "failed";
  checkedAt: string | null;
  /** One line in plain words (SPF found, DKIM missing...). */
  summary: string;
  /** SPF, DKIM, DMARC one by one, with what was found. */
  lines: { label: string; ok: boolean; detail: string }[];
}

export function dnsView(s: {
  automation_from: string;
  dns_ok: boolean;
  dns_checked_at: string | null;
  dns_result: Partial<DnsCheck>;
}): DnsView {
  const domain = automationDomain(s.automation_from) ?? "";
  if (!domain)
    return {
      domain,
      state: "no_domain",
      checkedAt: null,
      summary: "Set the automation sender above first: the check reads its domain.",
      lines: [],
    };
  const r = s.dns_result;
  if (!s.dns_checked_at || !r.domain)
    return {
      domain,
      state: "unchecked",
      checkedAt: null,
      summary: "Not checked yet. Automated email waits until SPF, DKIM and DMARC are all found.",
      lines: [],
    };
  const full = r as DnsCheck;
  return {
    domain,
    state: s.dns_ok ? "ok" : "failed",
    checkedAt: s.dns_checked_at,
    summary: describeDnsCheck(full),
    lines: [
      {
        label: "SPF",
        ok: Boolean(full.spf?.ok),
        detail: full.spf?.ok
          ? (full.spf.record ?? "found")
          : "No SPF record. Add the sending service's include to the domain's TXT record.",
      },
      {
        label: "DKIM",
        ok: Boolean(full.dkim?.ok),
        detail: full.dkim?.ok
          ? `Key found under “${full.dkim.selector}”`
          : "No signing key found under the usual names. Publish the DKIM record the email service gives you.",
      },
      {
        label: "DMARC",
        ok: Boolean(full.dmarc?.ok),
        detail: full.dmarc?.ok
          ? `${full.dmarc.host ?? ""}: ${full.dmarc.record ?? ""}`.trim()
          : "No DMARC policy. Publish a _dmarc TXT record (v=DMARC1; p=none is enough to start).",
      },
    ],
  };
}
