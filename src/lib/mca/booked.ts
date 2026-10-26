import { todayIn, type ISODate } from "./dates";

/**
 * A call booked for a time TODAY is an appointment, whatever else is due for that merchant. The calendar's
 * "next timer" can be an older follow-up (the normal case: log a call, then book the next one), so the
 * booking itself decides — in the user's own time zone.
 */
export function bookedToday(
  card: { scheduled_call_at: string | null },
  today: ISODate,
  timezone: string,
): boolean {
  if (!card.scheduled_call_at) return false;
  const at = new Date(card.scheduled_call_at);
  return !Number.isNaN(at.getTime()) && todayIn(timezone, at) === today;
}

/** "3:00 PM" in the user's zone, or null when nothing is booked. */
export function bookedTime(
  card: { scheduled_call_at: string | null },
  timezone: string,
): string | null {
  if (!card.scheduled_call_at) return null;
  const at = new Date(card.scheduled_call_at);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
