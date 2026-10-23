import type { Discipline } from "../reports/report";
import { formatMoneyCompact } from "../money";
import type { Digest } from "./digest";

export interface OverdueDeal {
  clientId: string;
  businessName: string;
  wantedCents: number | null;
  daysOverdue: number;
}

export interface ScorecardInput {
  /** "Oct 19 – Oct 25" */
  weekLabel: string;
  discipline: Discipline;
  added: number;
  funded: { count: number; cents: number };
  commissionReceivedCents: number;
  /** The biggest overdue deals right now, most valuable first (already limited). */
  overdue: OverdueDeal[];
  overdueTotal: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const oneLine = (s: string): string => s.replace(/\p{Cc}+/gu, " ").trim();

/** Facts only: what happened, and the few deals to start with. No scolding, no invented targets. */
export function buildScorecard(i: ScorecardInput, appUrl: string): Omit<Digest, "count"> {
  const d = i.discipline;
  const lines: string[] = [];
  if (d.total === 0 || d.onTimeRate === null) {
    lines.push("No follow-ups came due last week.");
  } else {
    lines.push(
      `${d.onTimeRate}% of ${plural(d.total, "follow-up")} that came due were done on the day (${d.onTime} on time, ${d.late} late, ${d.pushed} pushed back, ${d.overdue} still overdue).`,
    );
    if (d.pushed > d.onTime && d.pushed >= 5)
      lines.push(
        "More were pushed back than done on the day — pushing the same merchants again is how deals go cold.",
      );
  }
  lines.push(`${plural(i.added, "new merchant")} added.`);
  lines.push(
    i.funded.count > 0
      ? `${plural(i.funded.count, "advance")} funded — ${formatMoneyCompact(i.funded.cents)}.`
      : "Nothing funded.",
  );
  if (i.commissionReceivedCents > 0)
    lines.push(`Commission received: ${formatMoneyCompact(i.commissionReceivedCents)}.`);

  const startHere = i.overdue.map((o) => {
    const wants = o.wantedCents ? `, wants ${formatMoneyCompact(o.wantedCents)}` : "";
    return {
      href: `${appUrl}/clients/${o.clientId}`,
      name: o.businessName,
      text: `${o.businessName}${wants} — ${plural(o.daysOverdue, "day")} overdue`,
    };
  });
  const more = i.overdueTotal - startHere.length;

  const headline = d.onTimeRate === null ? "Your week" : `Your week: ${d.onTimeRate}% on time`;
  const subject = oneLine(
    `${headline}${i.funded.count > 0 ? ` · ${i.funded.count} funded` : ""} · ${i.weekLabel}`,
  );
  const text = [
    `Your week — ${i.weekLabel}`,
    "",
    ...lines,
    ...(startHere.length
      ? [
          "",
          "Start here this week:",
          ...startHere.map((s) => `• ${s.text}\n  ${s.href}`),
          ...(more > 0 ? [`…and ${more} more overdue.`] : []),
        ]
      : ["", "Nothing is overdue. Keep it that way."]),
    "",
    `${appUrl}/reports`,
    "",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif"><h3>Your week — ${esc(i.weekLabel)}</h3><ul>${lines
    .map((l) => `<li>${esc(l)}</li>`)
    .join("")}</ul>${
    startHere.length
      ? `<p><strong>Start here this week:</strong></p><ul>${startHere
          .map((s) => `<li><a href="${esc(s.href)}">${esc(s.text)}</a></li>`)
          .join("")}</ul>${more > 0 ? `<p>…and ${more} more overdue.</p>` : ""}`
      : "<p>Nothing is overdue. Keep it that way.</p>"
  }<p><a href="${esc(appUrl)}/reports">See the full reports</a></p></div>`;
  return { subject, text, html };
}
