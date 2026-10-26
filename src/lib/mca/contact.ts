/**
 * How a merchant may be reached. "Stop" must mean stop: Call/Text/Email are disabled in the UI AND refused
 * on the server, and a do-not-contact merchant never appears on Today or in the morning email.
 */
export type ContactStatus = "ok" | "no_text" | "no_call" | "no_email" | "dnc";
export type ContactKind = "call" | "text" | "email";

export const CONTACT_STATUSES: readonly ContactStatus[] = [
  "ok",
  "no_text",
  "no_call",
  "no_email",
  "dnc",
];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  ok: "OK to contact",
  no_text: "Do not text",
  no_call: "Do not call",
  no_email: "Do not email",
  dnc: "Do not contact",
};

export type ContactCheck = { ok: true } | { ok: false; reason: string };

export function contactAllowed(status: ContactStatus, kind: ContactKind): ContactCheck {
  if (status === "dnc") return { ok: false, reason: "Marked do-not-contact" };
  if (status === "no_text" && kind === "text")
    return { ok: false, reason: "Asked not to be texted" };
  if (status === "no_call" && kind === "call")
    return { ok: false, reason: "Asked not to be called" };
  if (status === "no_email" && kind === "email")
    return { ok: false, reason: "Asked not to be emailed" };
  return { ok: true };
}

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DE: "America/New_York",
  DC: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

/** The merchant's time zone from a free-text state ("TX", "Texas"). Null when unknown — never guess. */
export function stateTimezone(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const abbr = s.length === 2 ? s.toUpperCase() : STATE_NAMES[s.toLowerCase()];
  return (abbr && STATE_TZ[abbr]) || null;
}

export const QUIET_START_HOUR = 21; // 9 PM
export const QUIET_END_HOUR = 8; // 8 AM

export interface QuietHours {
  /** e.g. "9:42 PM", in the merchant's time zone. */
  localTime: string;
}

/** A warning (not a block) when it is before 8 AM or after 9 PM where the merchant is. Null when fine or unknown. */
export function quietHours(state: string, now: Date = new Date()): QuietHours | null {
  const tz = stateTimezone(state);
  if (!tz) return null;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(
      now,
    ),
  );
  if (hour >= QUIET_END_HOUR && hour < QUIET_START_HOUR) return null;
  return {
    localTime: new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
  };
}
