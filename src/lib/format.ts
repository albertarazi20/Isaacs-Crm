import { addMonths, diffDays, parseISODate, type ISODate } from "./mca/dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 23", or "Oct 23, 2027" when the year differs from `today`'s. */
export function formatDate(d: ISODate, today?: ISODate): string {
  const date = parseISODate(d);
  const base = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return today && today.slice(0, 4) === d.slice(0, 4)
    ? base
    : today
      ? `${base}, ${date.getUTCFullYear()}`
      : base;
}

function monthsBetween(from: ISODate, to: ISODate): number {
  let n = 0;
  while (addMonths(from, n + 1) <= to) n += 1;
  return n;
}

/** How far away a due date is, in Isaac's words. Overdue is spelled out — it is what he must act on. */
export function relativeDay(dueOn: ISODate, today: ISODate): string {
  const diff = diffDays(today, dueOn);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 0) return `${-diff} day${diff === -1 ? "" : "s"} overdue`;
  if (diff <= 13) return `in ${diff} days`;
  if (diff <= 59) return `in ${Math.round(diff / 7)} weeks`;
  const months = monthsBetween(today, dueOn);
  if (months < 24) return `in ${months} months`;
  const years = Math.round((months / 12) * 10) / 10;
  return `in ${years} years`;
}

/** "3 days ago" for an ISO timestamp. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(months / 12)} years ago`;
}

export function formatDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "2026-10-27T14:30" for <input type="datetime-local">, in the given timezone. */
export function toLocalInput(iso: string, timezone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
