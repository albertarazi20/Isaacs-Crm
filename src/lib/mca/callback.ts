/** "Call back in 3 hours": quick timed follow-ups, booked as a call so the card shows the time. */
export const CALLBACK_HOURS = [1, 2, 3, 4] as const;

/** The wall-clock time `hours` from `nowMs` in `timezone`, as the `YYYY-MM-DDTHH:mm` the call form sends. */
export function callbackAt(timezone: string, hours: number, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowMs + hours * 3_600_000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export const callbackLabel = (hours: number) => (hours === 1 ? "1 hour" : `${hours} hours`);
