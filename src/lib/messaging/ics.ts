/**
 * "Add to calendar" for a booked call: an .ics file (RFC 5545) and a Google Calendar template link.
 * Pure — the browser turns the string into a download.
 */

export interface CallEvent {
  /** Stable, so importing the same call twice updates it instead of duplicating it. */
  uid: string;
  /** An instant ("2026-10-27T18:30:00Z" or a Date), or a local time like "2026-10-27T14:30" with `timezone`. */
  start: Date | string;
  /** Required when `start` is a local time with no Z/offset. */
  timezone?: string;
  durationMinutes?: number;
  businessName: string;
  phone?: string;
  /** What the merchant wants: "$60,000, 6 months daily". */
  wants?: string;
  /** What the call is about, from the booking. */
  topic?: string;
  /** The last call note. */
  lastNote?: string;
  /** The client page. */
  url: string;
  /** DTSTAMP; defaults to now. */
  now?: Date;
  alarmMinutes?: number;
}

export const DEFAULT_DURATION_MINUTES = 30;
export const DEFAULT_ALARM_MINUTES = 15;

/** TEXT values: backslash, semicolon and comma are escaped, line breaks become \n, control characters go. */
export function escapeText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Lines are at most 75 octets (UTF-8 bytes, not characters) before the CRLF; longer ones continue on the next
 * line after a single space, which counts toward that line's 75. A multi-byte character is never split.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** 20261027T183000Z */
export function icsUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function offsetMinutes(timezone: string, atMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * "2026-11-01T01:30" in New York → the real instant. Handles daylight saving: a time that happens twice
 * (clocks go back) is the first one; a time that never happens (clocks go forward) moves ahead an hour.
 */
export function zonedLocalToInstant(local: string, timezone: string): Date {
  const m = LOCAL.exec(local);
  if (!m) throw new Error(`bad local time: ${local}`);
  const asUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  const DAY = 86_400_000;
  const before = offsetMinutes(timezone, asUtc - DAY);
  const after = offsetMinutes(timezone, asUtc + DAY);
  const candidates = [...new Set([before, after])]
    .map((off) => asUtc - off * 60_000)
    .filter((c) => offsetMinutes(timezone, c) === (asUtc - c) / 60_000);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // In the gap: use the offset from before the change, which lands an hour later on the wall clock.
  return new Date(asUtc - before * 60_000);
}

function toInstant(start: Date | string, timezone?: string): Date {
  if (start instanceof Date) return start;
  if (LOCAL.test(start)) {
    if (!timezone) throw new Error("a local start time needs a timezone");
    return zonedLocalToInstant(start, timezone);
  }
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) throw new Error(`bad start time: ${start}`);
  return d;
}

function summary(ev: CallEvent): string {
  return `Call: ${ev.businessName.trim()}`;
}

function descriptionLines(ev: CallEvent): string[] {
  const lines: string[] = [];
  if (ev.phone?.trim()) lines.push(`Phone: ${ev.phone.trim()}`);
  if (ev.wants?.trim()) lines.push(`Wants: ${ev.wants.trim()}`);
  if (ev.topic?.trim()) lines.push(`About: ${ev.topic.trim()}`);
  if (ev.lastNote?.trim()) lines.push(`Last call note: ${ev.lastNote.trim()}`);
  if (ev.url.trim()) lines.push(`Client page: ${ev.url.trim()}`);
  return lines;
}

/** A complete VCALENDAR with one 30-minute VEVENT and a 15-minute reminder. CRLF line endings throughout. */
export function buildCallIcs(ev: CallEvent): string {
  const start = toInstant(ev.start, ev.timezone);
  const minutes = ev.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const end = new Date(start.getTime() + minutes * 60_000);
  const alarm = ev.alarmMinutes ?? DEFAULT_ALARM_MINUTES;
  const title = escapeText(summary(ev));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Selective Capital//Selective CRM//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid.replace(/[^A-Za-z0-9@._-]/g, "-")}`,
    `DTSTAMP:${icsUtc(ev.now ?? new Date())}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${escapeText(descriptionLines(ev).join("\n"))}`,
    ...(ev.url.trim() ? [`URL:${ev.url.replace(/[\s\u0000-\u001F\u007F]/g, "")}`] : []),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${title}`,
    `TRIGGER:-PT${alarm}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** A link that opens Google Calendar's "new event" form already filled in. */
export function googleCalendarUrl(ev: CallEvent): string {
  const start = toInstant(ev.start, ev.timezone);
  const end = new Date(start.getTime() + (ev.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000);
  const details = descriptionLines(ev).join("\n").slice(0, 1500);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: summary(ev),
    dates: `${icsUtc(start)}/${icsUtc(end)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${q.toString().replace(/%2F/g, "/")}`;
}

/** call-mikes-pizza.ics */
export function icsFilename(businessName: string): string {
  const slug = businessName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `call-${slug || "client"}.ics`;
}
