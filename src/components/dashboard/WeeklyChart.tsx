import type { WeekPoint } from "@/lib/followup/overview";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** Round a maximum up to a tidy axis top (5, 10, 20, 50, 100, 200 ...). */
function niceTop(n: number): number {
  if (n <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const unit = n / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}

/**
 * Eight weeks, two bars a week: leads that came in (quiet) and merchants brought in (brand light). Drawn as plain
 * SVG on the server; the figures are also in a visually hidden table for a screen reader.
 */
export function WeeklyChart({ series }: { series: WeekPoint[] }) {
  const W = 640;
  const H = 230;
  const pad = { top: 16, right: 8, bottom: 28, left: 30 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const top = niceTop(Math.max(1, ...series.map((w) => Math.max(w.newLeads, w.broughtIn))));
  const slot = innerW / Math.max(1, series.length);
  const bar = Math.min(18, slot * 0.28);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const ticks = [0, top / 2, top];
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Leads and merchants brought in, last 8 weeks"
      >
        <defs>
          <linearGradient id="wk-brand" x1="0" x2="0" y1="1" y2="0">
            <stop offset="0" stopColor="#2e7bff" />
            <stop offset="0.6" stopColor="#a855f7" />
            <stop offset="1" stopColor="#d946ef" />
          </linearGradient>
          <linearGradient id="wk-quiet" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--muted)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--muted)" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeDasharray={t === 0 ? undefined : "3 5"}
            />
            <text
              x={pad.left - 8}
              y={y(t) + 3.5}
              textAnchor="end"
              fontSize="10.5"
              fill="var(--muted)"
            >
              {t}
            </text>
          </g>
        ))}
        {series.map((w, i) => {
          const cx = pad.left + slot * i + slot / 2;
          const h1 = Math.max(w.newLeads > 0 ? 3 : 0, (w.newLeads / top) * innerH);
          const h2 = Math.max(w.broughtIn > 0 ? 3 : 0, (w.broughtIn / top) * innerH);
          return (
            <g key={w.weekStart}>
              <title>{`Week of ${label(w.weekStart)}: ${w.newLeads} leads, ${w.broughtIn} brought in`}</title>
              <rect
                x={cx - bar - 2}
                y={pad.top + innerH - h1}
                width={bar}
                height={h1}
                rx={Math.min(5, bar / 2)}
                fill="url(#wk-quiet)"
              />
              <rect
                x={cx + 2}
                y={pad.top + innerH - h2}
                width={bar}
                height={h2}
                rx={Math.min(5, bar / 2)}
                fill="url(#wk-brand)"
              />
              {w.broughtIn > 0 ? (
                <text
                  x={cx + 2 + bar / 2}
                  y={pad.top + innerH - h2 - 5}
                  textAnchor="middle"
                  fontSize="10.5"
                  fontWeight="600"
                  fill="var(--text)"
                >
                  {w.broughtIn}
                </text>
              ) : null}
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--muted)">
                {label(w.weekStart)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>Leads and merchants brought in by week</caption>
        <thead>
          <tr>
            <th>Week of</th>
            <th>New leads</th>
            <th>Brought in</th>
          </tr>
        </thead>
        <tbody>
          {series.map((w) => (
            <tr key={w.weekStart}>
              <td>{label(w.weekStart)}</td>
              <td>{w.newLeads}</td>
              <td>{w.broughtIn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
