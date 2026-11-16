/**
 * When a quiet lender gets a nudge (S2-6). Pure, so the rules are tested without a database:
 *   * the quiet window counts business days — Mon–Fri, or every day when the shop sends on weekends;
 *   * a chase only goes out in business hours (08:00–18:00) in the rep's own time zone, on a business day;
 *   * the row flips to no_response once the last chase has had a full window to land.
 */
export interface ChaseRules {
  /** Business days a lender may stay quiet before a nudge. */
  days: number;
  /** The shop's send-window days: true means every day counts, false means Mon–Fri. */
  weekends: boolean;
}

function partsIn(now: Date, timezone: string): { weekday: number; hour: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = f.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { weekday: weekday < 0 ? 1 : weekday, hour };
}

const isBusinessDay = (weekday: number, weekends: boolean): boolean =>
  weekends || (weekday >= 1 && weekday <= 5);

/** A nudge may go out now: a business day, between 8 and 18 in the rep's zone. */
export function inBusinessHours(now: Date, timezone: string, weekends: boolean): boolean {
  const { weekday, hour } = partsIn(now, timezone);
  return isBusinessDay(weekday, weekends) && hour >= 8 && hour < 18;
}

/**
 * The moment `days` business days before `now`: a lender whose last touch is older than this has been quiet for the
 * whole window. Weekend days are skipped unless the shop sends on weekends.
 */
export function quietSince(now: Date, rules: ChaseRules, timezone: string): Date {
  const d = new Date(now.getTime());
  let left = Math.max(0, rules.days);
  while (left > 0) {
    d.setTime(d.getTime() - 24 * 60 * 60 * 1000);
    if (isBusinessDay(partsIn(d, timezone).weekday, rules.weekends)) left -= 1;
  }
  return d;
}

/** The nudge itself: short, on the same thread, from the rep. */
export function chaseText(a: {
  funderName: string;
  businessName: string;
  dealNumber: number;
  senderName: string;
}): string {
  return `Hi ${a.funderName} team,\n\nAny update on ${a.businessName} (D-${a.dealNumber})? Happy to send anything else you need.\n\nThanks,\n${a.senderName}`;
}
