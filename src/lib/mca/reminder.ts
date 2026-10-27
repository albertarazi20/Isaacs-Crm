import { todayIn, type ISODate } from "./dates";

export const REMINDER_CHANNELS = ["call", "text", "email"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  call: "Call",
  text: "Text",
  email: "Email",
};

const clock = (timezone: string, at: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...opts }).format(at);

/**
 * The line on the bright tag: "Text 3:15 PM" today, "Email Thu 9:00 AM" later, "Call overdue" once its day has gone.
 * It depends only on `today` (not the clock), so the server and the browser print the same words.
 */
export function reminderText(
  at: string,
  channel: ReminderChannel | null | undefined,
  timezone: string,
  today: ISODate,
): string {
  const label = CHANNEL_LABEL[channel ?? "call"];
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return label;
  const day = todayIn(timezone, when);
  if (day < today) return `${label} overdue`;
  const time = clock(timezone, when, { hour: "numeric", minute: "2-digit" });
  return day === today
    ? `${label} ${time}`
    : `${label} ${clock(timezone, when, { weekday: "short" })} ${time}`;
}
