import Link from "next/link";
import { WinbackList } from "@/components/winback/WinbackList";
import { cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { loadWinback } from "@/lib/messaging/queries";
import {
  compact,
  parseWinbackDays,
  splitBatch,
  WINBACK_DAY_CHOICES,
} from "@/lib/messaging/winback";
import { formatMoneyCompact } from "@/lib/money";

const LATER_SHOWN = 40;

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

export default async function WinbackPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const { days: rawDays } = await searchParams;
  const days = parseWinbackDays(Array.isArray(rawDays) ? rawDays[0] : rawDays);
  const session = await requireSession();
  const rows = await db.withUser(session.userId, async (q) =>
    loadWinback(q, await userContext(q), days),
  );
  const { batch, later, done } = splitBatch(rows);
  const onTheTable = rows.reduce((sum, r) => sum + r.moneyCents, 0);
  const choices = WINBACK_DAY_CHOICES.includes(days)
    ? WINBACK_DAY_CHOICES
    : [...WINBACK_DAY_CHOICES, days].sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Win-back</h1>
          <p className="text-sm text-muted">
            Merchants who said no, went quiet, were declined or funded elsewhere — and are due for a
            call. Ten at a time, biggest money first.
          </p>
        </div>
        <nav aria-label="Due within" className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted">Due within</span>
          {choices.map((d) => (
            <Link
              key={d}
              href={`/winback?days=${d}`}
              aria-current={d === days ? "page" : undefined}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-sm font-medium",
                d === days
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Kpi label={`Due in the next ${days} days`} value={rows.length} />
        <Kpi label="Still to work" value={batch.length + later.length} />
        <Kpi label="Money on the table" value={formatMoneyCompact(onTheTable)} />
      </div>

      <WinbackList
        batch={batch}
        later={later.slice(0, LATER_SHOWN).map(compact)}
        laterCount={later.length}
        done={done.map(compact)}
        days={days}
      />
    </div>
  );
}
