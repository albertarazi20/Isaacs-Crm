import type { ISODate } from "../mca/dates";

/**
 * The rules every automated email obeys, as pure functions so each can be tested without a database.
 * The worker (worker.ts) reads the numbers from the database and asks these functions what to do.
 */

export const LANES = ["intake", "reply", "sequence", "blast", "system"] as const;
export type Lane = (typeof LANES)[number];

export interface CapInput {
  /** The shop's lock per mailbox per rolling 24h (Settings). */
  shopCap: number;
  /** The provider's own limit for this mailbox (gmail.com 500, Workspace 2000). */
  providerLimit: number;
  /** Sends held back for intake and replies. */
  reserved: number;
  /** Already sent from this mailbox in the last 24h (CRM + what the inbox sync saw). */
  sent24h: number;
}

/** The lock for a mailbox: never above what the provider allows, with a safety margin on gmail.com. */
export function effectiveCap(shopCap: number, providerLimit: number): number {
  // Google locks the mailbox for up to 24h past its limit, so trip well before it: 80% of a small limit.
  const margin = providerLimit <= 500 ? Math.floor(providerLimit * 0.8) : providerLimit;
  return Math.min(shopCap, margin);
}

export type CapDecision = { ok: true } | { ok: false; reason: "cap" };

/** May this lane send one more from this mailbox right now? */
export function capAllows(lane: Lane, c: CapInput): CapDecision {
  const cap = effectiveCap(c.shopCap, c.providerLimit);
  if (c.sent24h >= cap) return { ok: false, reason: "cap" };
  // sequence and blast stop early so intake and replies keep a reserved slice
  const bulk = lane === "sequence" || lane === "blast";
  if (bulk && c.sent24h >= cap - c.reserved) return { ok: false, reason: "cap" };
  return { ok: true };
}

export type Gauge = "green" | "amber" | "locked";

export function gauge(sent24h: number, cap: number, amberAt: number): Gauge {
  if (sent24h >= cap) return "locked";
  if (sent24h >= Math.min(amberAt, cap)) return "amber";
  return "green";
}

export interface WindowInput {
  /** The merchant's zone. */
  timezone: string;
  startHour: number;
  endHour: number;
  weekends: boolean;
}

function partsIn(
  tz: string,
  at: Date,
): { hour: number; minute: number; weekday: number; date: ISODate } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Mon");
  return {
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Is `at` inside the merchant's local send window? */
export function inSendWindow(at: Date, w: WindowInput): boolean {
  const p = partsIn(w.timezone, at);
  if (!w.weekends && (p.weekday === 0 || p.weekday === 6)) return false;
  return p.hour >= w.startHour && p.hour < w.endHour;
}

/**
 * The next instant inside the window at or after `from`, spread randomly across the window so a bucket does not
 * fire at 10:00:00 sharp. `spread` in [0,1) picks the minute; pass a fixed value in tests.
 */
export function nextSendTime(from: Date, w: WindowInput, spread = Math.random()): Date {
  // walk forward in 30-minute steps for at most 8 days until a slot is in-window
  const step = 30 * 60_000;
  let t = from.getTime();
  const end = t + 8 * 86_400_000;
  while (t < end) {
    const at = new Date(t);
    if (inSendWindow(at, w)) {
      const p = partsIn(w.timezone, at);
      // if we are at the start of the window, spread across it; otherwise send now
      if (p.hour === w.startHour && p.minute === 0) {
        const span = (w.endHour - w.startHour) * 60 * 60_000;
        return new Date(t + Math.floor(spread * span));
      }
      return at;
    }
    // jump to the next half hour on the clock
    t = t - (t % step) + step;
  }
  return new Date(from.getTime() + 86_400_000);
}

export interface MerchantCapInput {
  sent24h: number;
  sent7d: number;
  perDay: number;
  perWeek: number;
}

/** One automated email per merchant per day (by default), three a week, across every source. */
export function merchantCapAllows(m: MerchantCapInput): boolean {
  return m.sent24h < m.perDay && m.sent7d < m.perWeek;
}

/** Footer every automated email carries. Reps cannot remove it: it is appended by the engine, not the template. */
export function legalFooter(args: {
  shopName: string;
  postalAddress: string;
  unsubscribeUrl: string;
}): { text: string; html: string } {
  const esc = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const text = `\n\n—\n${args.shopName}\n${args.postalAddress}\nTo stop these emails: ${args.unsubscribeUrl}`;
  const html = `<p style="color:#6b7280;font-size:12px;margin-top:24px">${esc(args.shopName)}<br>${esc(
    args.postalAddress,
  )}<br><a href="${esc(args.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a></p>`;
  return { text, html };
}

/** Plain text → simple HTML paragraphs, so Gmail and phones render line breaks. */
export function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const urlish = (s: string) =>
    s.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${urlish(esc(p)).replaceAll("\n", "<br>")}</p>`)
    .join("");
}
