/** The dial list of a bucket: who can be called, the numbers as text to paste, the merchant's own clock. Browser-safe. */
import { formatUS, normalizeUS, voiceCallHref } from "../mca/phone";

export interface Dialable {
  client_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  state: string;
  timezone: string;
  tz_label: string;
  /** ok, no_text, no_call, no_email or dnc. */
  contact_status: string;
}

export interface DialRow {
  clientId: string;
  business: string;
  contact: string;
  /** (305) 555-0100 */
  phone: string;
  /** +13055550100 */
  e164: string;
  state: string;
  timezone: string;
  tz: string;
  voiceHref: string;
}

export interface Skipped {
  clientId: string;
  business: string;
  why: string;
}

/**
 * Whoever asked not to be called, or has no number a phone can dial, is left off and listed with the reason. The same
 * number on two merchant records is dialed once (the first), and the other is listed as left off.
 */
export function dialList(members: readonly Dialable[]): { rows: DialRow[]; skipped: Skipped[] } {
  const rows: DialRow[] = [];
  const skipped: Skipped[] = [];
  const seen = new Map<string, string>();
  for (const m of members) {
    const why =
      m.contact_status === "dnc"
        ? "do not contact"
        : m.contact_status === "no_call"
          ? "asked not to be called"
          : normalizeUS(m.phone) === null
            ? m.phone.trim() === ""
              ? "no phone number"
              : "not a usable number"
            : null;
    const e164 = normalizeUS(m.phone);
    if (why || !e164) {
      skipped.push({
        clientId: m.client_id,
        business: m.business_name,
        why: why ?? "no phone number",
      });
      continue;
    }
    const twin = seen.get(e164);
    if (twin !== undefined) {
      skipped.push({
        clientId: m.client_id,
        business: m.business_name,
        why: `same number as ${twin}`,
      });
      continue;
    }
    seen.set(e164, m.business_name);
    rows.push({
      clientId: m.client_id,
      business: m.business_name,
      contact: m.contact_name,
      phone: formatUS(m.phone),
      e164,
      state: m.state,
      timezone: m.timezone,
      tz: m.tz_label,
      voiceHref: voiceCallHref(e164),
    });
  }
  return { rows, skipped };
}

/** One number a line, the way a dialer's paste box wants them. */
export const numbersText = (rows: readonly Pick<DialRow, "phone">[]): string =>
  rows.map((r) => r.phone).join("\n");

/**
 * One pasted cell: a tab or line break inside a value would split it into the wrong columns or rows, and a value
 * a sheet reads as a formula (= + - @) gets a leading apostrophe, the same guard the CSV export uses.
 */
const sheetCell = (v: string): string => {
  const flat = v.replace(/[\t\r\n]+/g, " ").trim();
  // (a plain +13055550100 is only digits after the plus: nothing a sheet could run, and a dialer wants it as it is)
  return /^[=+\-@]/.test(flat) && !/^\+\d{7,15}$/.test(flat) ? `'${flat}` : flat;
};

/** Business, contact and number, tab-separated: pasted into a sheet each lands in its own column. */
export const tableText = (
  rows: readonly Pick<DialRow, "business" | "contact" | "phone">[],
): string => rows.map((r) => [r.business, r.contact, r.phone].map(sheetCell).join("\t")).join("\n");

/** The merchant's own clock, "9:41 AM". */
export function localTime(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(now);
  } catch {
    return "";
  }
}

/** Calls go out between 8 am and 9 pm where the merchant is. */
export function callWindow(timezone: string, now: Date): "open" | "early" | "late" | "unknown" {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(now),
    );
    if (Number.isNaN(hour)) return "unknown";
    return hour < 8 ? "early" : hour >= 21 ? "late" : "open";
  } catch {
    return "unknown";
  }
}
