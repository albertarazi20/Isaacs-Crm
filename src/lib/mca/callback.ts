/** "Call back in 3 hours": quick timed follow-ups, booked as a call so the card shows the time. */
export const CALLBACK_HOURS = [0.5, 1, 2, 3, 4] as const;

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

export const callbackLabel = (hours: number) =>
  hours < 1 ? `${hours * 60} min` : hours === 1 ? "1 hour" : `${hours} hours`;

const pad = (n: number) => String(n).padStart(2, "0");

/** Every half hour of the day: "00:00", "00:30" ... "23:30", labelled "12:00 AM" ... "11:30 PM". */
export const TIME_SLOTS: readonly { value: string; label: string }[] = Array.from(
  { length: 48 },
  (_, i) => {
    const h = Math.floor(i / 2);
    const m = (i % 2) * 30;
    return {
      value: `${pad(h)}:${pad(m)}`,
      label: `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`,
    };
  },
);

/** The `YYYY-MM-DDTHH:mm` a reminder form sends for a date and a half-hour slot. */
export const slotAt = (date: string, time: string) => `${date}T${time}`;

/** The wall-clock "HH:mm" in `timezone` right now. */
export const clockNow = (timezone: string, nowMs: number) =>
  callbackAt(timezone, 0, nowMs).slice(11);
