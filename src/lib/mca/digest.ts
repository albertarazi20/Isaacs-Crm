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

/** Only things that need a human today: overdue first (oldest first), then due today. */
export function groupDue(timers: readonly DueTimer[], today: ISODate): DigestGroups {
  const byDueThenName = (a: DueTimer, b: DueTimer) =>
    a.dueOn.localeCompare(b.dueOn) || a.businessName.localeCompare(b.businessName);
  return {
    overdue: timers.filter((t) => t.dueOn < today).sort(byDueThenName),
    dueToday: timers.filter((t) => t.dueOn === today).sort(byDueThenName),
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
