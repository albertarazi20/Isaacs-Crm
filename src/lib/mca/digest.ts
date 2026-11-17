import { diffDays, type ISODate } from "./dates";
import { formatUS } from "./phone";
import { stageDef, TIMER_LABELS, type StageKey, type TimerKind } from "./stages";

export interface DueTimer {
  timerId: string;
  clientId: string;
  businessName: string;
  contactName: string;
  phone: string;
  stage: StageKey;
  kind: TimerKind;
  dueOn: ISODate;
  note: string;
}

export interface DigestGroups {
  overdue: DueTimer[];
  dueToday: DueTimer[];
}

const KIND_RANK: Record<TimerKind, number> = {
  scheduled_call: 0,
  follow_up: 1,
};

/** One line per client — two timers landing on the same day (a booked call beside a follow-up) are one phone call. */
function onePerClient(timers: readonly DueTimer[]): DueTimer[] {
  const best = new Map<string, DueTimer>();
  for (const t of timers) {
    const cur = best.get(t.clientId);
    if (
      !cur ||
      t.dueOn < cur.dueOn ||
      (t.dueOn === cur.dueOn && KIND_RANK[t.kind] < KIND_RANK[cur.kind])
    )
      best.set(t.clientId, t);
  }
  return [...best.values()];
}

/** Only things that need a human today: overdue first (oldest first), then due today. */
export function groupDue(timers: readonly DueTimer[], today: ISODate): DigestGroups {
  const byDueThenName = (a: DueTimer, b: DueTimer) =>
    a.dueOn.localeCompare(b.dueOn) || a.businessName.localeCompare(b.businessName);
  const due = onePerClient(timers.filter((t) => t.dueOn <= today));
  return {
    overdue: due.filter((t) => t.dueOn < today).sort(byDueThenName),
    dueToday: due.filter((t) => t.dueOn === today).sort(byDueThenName),
  };
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function line(t: DueTimer, today: ISODate, appUrl: string): { text: string; html: string } {
  const late = diffDays(t.dueOn, today);
  const when = late > 0 ? `${late}d overdue` : "today";
  const label = `${TIMER_LABELS[t.kind]} · ${stageDef(t.stage).label}`;
  const who = `${t.businessName} — ${t.contactName}`;
  const href = `${appUrl}/clients/${t.clientId}`;
  const phone = t.phone ? formatUS(t.phone) : "";
  return {
    text: `• ${who} ${phone} [${label}, ${when}]\n  ${href}${t.note ? `\n  ${t.note}` : ""}`,
    html: `<li><a href="${esc(href)}"><strong>${esc(t.businessName)}</strong></a> — ${esc(
      t.contactName,
    )} ${esc(phone)}<br><small>${esc(label)}, ${esc(when)}${t.note ? ` — ${esc(t.note)}` : ""}</small></li>`,
  };
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
  count: number;
}

/** Null when there is nothing to do — never send an empty digest. */
export function buildDigest(
  timers: readonly DueTimer[],
  today: ISODate,
  appUrl: string,
): Digest | null {
  const { overdue, dueToday } = groupDue(timers, today);
  const count = overdue.length + dueToday.length;
  if (count === 0) return null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const subject =
    dueToday.length === 0
      ? `${overdue.length} overdue follow-up${overdue.length === 1 ? "" : "s"}`
      : overdue.length === 0
        ? `${plural(dueToday.length, "follow-up")} due today`
        : `${dueToday.length} due today, ${overdue.length} overdue — follow-ups`;
  const section = (title: string, rows: DueTimer[]) => {
    if (rows.length === 0) return { text: "", html: "" };
    const lines = rows.map((r) => line(r, today, appUrl));
    return {
      text: `${title}\n${lines.map((l) => l.text).join("\n")}\n\n`,
      html: `<h3>${esc(title)}</h3><ul>${lines.map((l) => l.html).join("")}</ul>`,
    };
  };
  const a = section("OVERDUE", overdue);
  const b = section("DUE TODAY", dueToday);
  return {
    subject,
    count,
    text: `${a.text}${b.text}Open your list: ${appUrl}/\n`,
    html: `<div style="font-family:system-ui,sans-serif">${a.html}${b.html}<p><a href="${esc(appUrl)}/">Open your list</a></p></div>`,
  };
}

export interface CallReminderInput {
  clientId: string;
  businessName: string;
  contactName: string;
  phone: string;
  /** Already formatted in Isaac's timezone, e.g. "3:30 PM". */
  callTime: string;
  /** What the reminder is for. Missing means a call. */
  channel?: "call" | "text" | "email" | null;
  wantedAmount: string | null;
  lastCallNote: string | null;
}

/** A short "get ready" email an hour or so before a booked call, with what he needs to say hello properly. */
/** Subjects go into email headers: strip anything that could break one. */
const oneLine = (s: string): string => s.replace(/\p{Cc}+/gu, " ").trim();

export function buildCallReminder(c: CallReminderInput, appUrl: string): Omit<Digest, "count"> {
  const href = `${appUrl}/clients/${c.clientId}`;
  const phone = c.phone ? formatUS(c.phone) : "no phone on file";
  const what = c.channel === "text" ? "Text" : c.channel === "email" ? "Email" : "Call";
  const facts = [
    c.wantedAmount ? `Wants ${c.wantedAmount}` : "",
    c.lastCallNote ? `Last call: ${c.lastCallNote}` : "",
  ].filter(Boolean);
  return {
    subject: oneLine(`${what} at ${c.callTime}: ${c.businessName}`),
    text: `${what} at ${c.callTime} — ${c.businessName} (${c.contactName || "merchant"}), ${phone}\n${facts.join("\n")}${facts.length ? "\n" : ""}\n${href}\n`,
    html: `<div style="font-family:system-ui,sans-serif"><h3>${what} at ${esc(c.callTime)}</h3><p><a href="${esc(href)}"><strong>${esc(c.businessName)}</strong></a> — ${esc(
      c.contactName || "merchant",
    )}<br>${esc(phone)}</p>${facts.length ? `<ul>${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</div>`,
  };
}

export interface NewLeadInput {
  clientId: string;
  businessName: string;
  contactName: string;
  phone: string;
  wantedAmount: string | null;
  source: string;
}

/** The instant alert for a new inbound lead — short enough to read from a phone's lock screen. */
export function buildNewLeadAlert(l: NewLeadInput, appUrl: string): Omit<Digest, "count"> {
  const href = `${appUrl}/clients/${l.clientId}`;
  const phone = l.phone ? formatUS(l.phone) : "no phone — email only";
  const facts = [
    l.contactName ? `Contact: ${l.contactName}` : "",
    l.wantedAmount ? `Wants ${l.wantedAmount}` : "",
    l.source ? `From: ${l.source}` : "",
  ].filter(Boolean);
  return {
    subject: oneLine(`New lead: ${l.businessName} — call now`),
    text: `New lead — ${l.businessName}\n${phone}\n${facts.join("\n")}${facts.length ? "\n" : ""}\n${href}\n`,
    html: `<div style="font-family:system-ui,sans-serif"><h3>New lead — call now</h3><p><a href="${esc(href)}"><strong>${esc(
      l.businessName,
    )}</strong></a><br>${esc(phone)}</p>${facts.length ? `<ul>${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</div>`,
  };
}
