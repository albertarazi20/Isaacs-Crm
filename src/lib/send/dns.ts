import type { Db } from "../db";

/**
 * The DNS gate before automation (plan §11.8, S1-4): the shop's automation domain must publish SPF, DKIM and DMARC
 * before the engine sends from it, or every automated email lands in spam and burns the domain. The resolver is
 * injected (node:dns/promises in production, a fake in tests); the result is stored on shop_settings and the outbox
 * worker reads it before every Resend send.
 */

export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export interface DnsCheck {
  domain: string;
  spf: { ok: boolean; record: string | null };
  dkim: { ok: boolean; selector: string | null };
  dmarc: { ok: boolean; record: string | null; host: string | null };
  ok: boolean;
  checkedAt: string;
}

/** The DKIM selectors a Resend domain (or a Google / generic one) publishes under; the first that answers wins. */
export const DKIM_SELECTORS = ["resend", "default", "google", "k1", "mail", "s1", "selector1"];

/** "Selective <no-reply@mail.example.com>" → "mail.example.com"; null when there is no address in it. */
export function automationDomain(from: string): string | null {
  const m = /<([^>]+)>/.exec(from);
  const address = (m ? m[1] : from)?.trim().toLowerCase() ?? "";
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** A missing record is an answer, not a failure: NXDOMAIN and "no data" read as "nothing published". */
async function txt(resolver: DnsResolver, host: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(host)).map((chunks) => chunks.join(""));
  } catch (e) {
    const code = (e as { code?: string } | null)?.code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "ESERVFAIL") return [];
    throw e;
  }
}

export async function checkAutomationDns(
  from: string,
  resolver: DnsResolver,
  opts: { selectors?: readonly string[]; now?: Date } = {},
): Promise<DnsCheck> {
  const now = opts.now ?? new Date();
  const domain = automationDomain(from);
  const none: DnsCheck = {
    domain: domain ?? "",
    spf: { ok: false, record: null },
    dkim: { ok: false, selector: null },
    dmarc: { ok: false, record: null, host: null },
    ok: false,
    checkedAt: now.toISOString(),
  };
  if (!domain) return none;

  const spfRecord = (await txt(resolver, domain)).find((r) => /^v=spf1\b/i.test(r)) ?? null;
  const spf = { ok: spfRecord !== null, record: spfRecord };

  let dkim: DnsCheck["dkim"] = { ok: false, selector: null };
  for (const selector of opts.selectors ?? DKIM_SELECTORS) {
    const records = await txt(resolver, `${selector}._domainkey.${domain}`);
    if (
      records.some((r) => /(^|;\s*)v=DKIM1\b/i.test(r) || /(^|;\s*)p=[A-Za-z0-9+/=]{20,}/.test(r))
    ) {
      dkim = { ok: true, selector };
      break;
    }
  }

  // DMARC lives at the organisational domain: mail.example.com without its own record inherits example.com's.
  const labels = domain.split(".");
  const hosts = [`_dmarc.${domain}`];
  if (labels.length > 2) hosts.push(`_dmarc.${labels.slice(-2).join(".")}`);
  let dmarc: DnsCheck["dmarc"] = { ok: false, record: null, host: null };
  for (const host of hosts) {
    const record = (await txt(resolver, host)).find((r) => /^v=DMARC1\b/i.test(r));
    if (record) {
      dmarc = { ok: true, record, host };
      break;
    }
  }

  return {
    domain,
    spf,
    dkim,
    dmarc,
    ok: spf.ok && dkim.ok && dmarc.ok,
    checkedAt: now.toISOString(),
  };
}

/** Store the result on the one shop_settings row. The worker reads dns_ok before every Resend send. */
export async function storeDnsCheck(q: Db, check: DnsCheck): Promise<void> {
  await q.query(
    "update shop_settings set dns_ok = $1, dns_checked_at = $2, dns_result = $3::jsonb",
    [check.ok, check.checkedAt, JSON.stringify(check)],
  );
}

/** One line for the Settings page, in plain words. */
export function describeDnsCheck(c: DnsCheck): string {
  if (!c.domain) return "No automation address is set";
  const bits = [
    `SPF ${c.spf.ok ? "found" : "missing"}`,
    `DKIM ${c.dkim.ok ? `found (${c.dkim.selector})` : "missing"}`,
    `DMARC ${c.dmarc.ok ? "found" : "missing"}`,
  ];
  return `${c.domain}: ${bits.join(", ")}${c.ok ? " — automation may send" : " — automation waits"}`;
}
