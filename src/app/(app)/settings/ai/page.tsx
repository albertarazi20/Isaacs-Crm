import type { Metadata } from "next";
import { AiSettingsForm } from "@/components/settings/AiSettingsForm";
import { AiSpendCard } from "@/components/settings/AiSpendCard";
import { Note, SettingsCard, StatusChip } from "@/components/settings/primitives";
import { SettingsPage } from "@/components/settings/SettingsNav";
import { cn, Meter, ProgressRing } from "@/components/ui";
import { requireRole } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { timeAgo } from "@/lib/format";
import { requestTimeMs } from "@/lib/server-time";
import { aiSpendByPurpose } from "@/lib/settings/ai";
import { aiStatus, getShopSettings } from "@/lib/settings/queries";

export const dynamic = "force-dynamic";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const metadata: Metadata = { title: "AI assistant" };

export default async function AiSettingsPage() {
  const session = await requireRole(CAN.manageTeam);
  const { settings, status, spend } = await db.withUser(session.userId, async (q) => ({
    settings: await getShopSettings(q),
    status: await aiStatus(q),
    spend: await aiSpendByPurpose(q),
  }));
  const keySet = Boolean(env().ANTHROPIC_API_KEY);
  const now = new Date(requestTimeMs());
  const spent = status.spent_today_cents;
  const cap = settings.ai_daily_cap_cents;
  const share = cap > 0 ? Math.min(1, spent / cap) : 0;
  const left = Math.max(0, cap - spent);
  const tone = share >= 1 ? "bad" : share >= 0.8 ? "warn" : "brand";
  const live = keySet && settings.ai_enabled;
  const stats = [
    { label: "Runs today", value: String(status.runs_today), bad: false },
    { label: "Errors today", value: String(status.errors_today), bad: status.errors_today > 0 },
    {
      label: "Per run",
      value: status.runs_today > 0 ? `${(spent / status.runs_today).toFixed(2)}¢` : "0¢",
      bad: false,
    },
  ];
  return (
    <SettingsPage
      role={session.role}
      current="/settings/ai"
      title="AI assistant"
      description="The AI tags merchants' replies and splits pasted lead lines. It never sends mail or decides anything by itself: it fills in a form and the code checks it. Every run is logged with its cost."
      notice={
        !keySet ? (
          <Note tone="warn">
            ANTHROPIC_API_KEY is not set on the server. Nothing is tagged or split until it is.
          </Note>
        ) : null
      }
    >
      <SettingsCard
        title="Today"
        description="What the AI has spent since midnight against the daily cap. At the cap it pauses until tomorrow."
        aside={
          live ? (
            share >= 1 ? (
              <StatusChip tone="bad">Paused at the cap</StatusChip>
            ) : (
              <StatusChip tone="good">Running</StatusChip>
            )
          ) : (
            <StatusChip tone="warn">{keySet ? "Switched off" : "No key"}</StatusChip>
          )
        }
        flush
        panelClassName="ring-brand"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5 sm:p-6">
          <ProgressRing value={share} size={92} stroke={8}>
            <span className="text-[15px]">
              {share > 0 && share < 0.01 ? "<1" : Math.round(share * 100)}%
            </span>
          </ProgressRing>
          <div className="min-w-0 flex-1 basis-56">
            <p className="eyebrow">Spent today</p>
            <p className="mt-1.5 flex items-baseline gap-2">
              <span className="text-gradient text-[36px] leading-none font-semibold tracking-[-0.04em] tabular-nums">
                {usd(spent)}
              </span>
              <span className="text-sm font-medium text-muted tabular-nums">of {usd(cap)}</span>
            </p>
            <Meter
              label="AI spend today, of the daily cap"
              value={spent}
              max={Math.max(cap, 1)}
              tone={tone}
              className="mt-3.5 h-2"
            />
            <p className="mt-2 text-xs text-muted tabular-nums">
              {share >= 1
                ? "The cap is reached. Raise it below, or it starts again tomorrow."
                : `${usd(left)} left today.`}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 divide-x divide-border border-t border-border">
          {stats.map((x) => (
            <div key={x.label} className="min-w-0 px-4 py-3.5 sm:px-6">
              <dt className="eyebrow truncate">{x.label}</dt>
              <dd
                className={cn(
                  "mt-1 text-[22px] leading-7 font-semibold tracking-tight tabular-nums",
                  x.bad && "text-bad",
                )}
              >
                {x.value}
              </dd>
            </div>
          ))}
        </dl>
      </SettingsCard>
      <AiSettingsForm s={settings} />
      <AiSpendCard rows={spend} />
      <SettingsCard
        title="Recent runs"
        description="The last 25 things the AI did, newest first, with what each one cost."
        flush
      >
        {status.runs.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted sm:px-5">None yet.</p>
        ) : (
          <div
            tabIndex={0}
            role="region"
            aria-label="Recent AI runs"
            className="max-h-[30rem] overflow-y-auto focus-visible:outline-offset-[-2px]"
          >
            <ul className="divide-y divide-border text-[13px]">
              {status.runs.map((r) => (
                <li
                  key={r.id}
                  className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/50 sm:px-5"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", r.error ? "bg-bad" : "bg-good")}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium first-letter:uppercase">
                        {r.purpose.replace(/_/g, " ")}
                      </span>
                      <span
                        className={cn(
                          "block truncate text-xs",
                          r.error ? "text-bad" : "text-muted",
                        )}
                      >
                        {r.error ?? r.model}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs whitespace-nowrap text-muted tabular-nums">
                    {r.cost_cents !== null ? (
                      <span className="block font-medium text-text-2">
                        {r.cost_cents.toFixed(2)}¢
                      </span>
                    ) : null}
                    <span title={r.created_at.slice(0, 16).replace("T", " ")}>
                      {timeAgo(r.created_at, now)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
