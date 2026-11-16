"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  activeCount,
  applyFilters,
  facetsOf,
  NO_FILTERS,
  type ClientFilters,
  type QuietFilter,
} from "@/lib/data/clientFilters";
import type { ClientCard } from "@/lib/data/types";
import { CLIENT_HEADER, clientRows, toCsv } from "@/lib/export/csv";
import { relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { reminderText } from "@/lib/mca/reminder";
import { CORE_STAGES, STAGE_GROUPS, stageDef, type StageKey } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { Chip } from "./client/primitives";
import { ReminderTag } from "@/components/ReminderTag";
import { ClientCards } from "./ClientCards";
import { StageBadge } from "./StageBadge";
import { Badge, Button, cn, EmptyState, Input, Select } from "./ui";

type SortKey = "due" | "name" | "touch" | "newest";

/** The list as it is filtered right now, as a spreadsheet: a call list for a campaign. */
function downloadCsv(cards: readonly ClientCard[]): void {
  const blob = new Blob([toCsv(CLIENT_HEADER, clientRows(cards))], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isaac-clients-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const TH = "px-3 py-2 font-semibold first:pl-4 last:pr-4";
const TD = "px-3 py-2 first:pl-4 last:pr-4";

export function ClientsTable({ cards }: { cards: ClientCard[] }) {
  const { today, nowMs, timezone } = useApp();
  const [f, setF] = useState<ClientFilters>(NO_FILTERS);
  const [showMore, setShowMore] = useState(false);
  const [sort, setSort] = useState<SortKey>("due");
  const set = <K extends keyof ClientFilters>(key: K, value: ClientFilters[K]) =>
    setF((prev) => ({ ...prev, [key]: value }));
  const facets = useMemo(() => facetsOf(cards), [cards]);
  const narrowing = activeCount(f);

  const rows = useMemo(() => {
    const list = applyFilters(cards, f, nowMs);
    const by: Record<SortKey, (a: ClientCard, b: ClientCard) => number> = {
      due: (a, b) =>
        (a.next_due_on ?? "9999").localeCompare(b.next_due_on ?? "9999") ||
        a.business_name.localeCompare(b.business_name),
      name: (a, b) => a.business_name.localeCompare(b.business_name),
      touch: (a, b) => (b.last_touch_at ?? "").localeCompare(a.last_touch_at ?? ""),
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
    };
    return [...list].sort(by[sort]);
  }, [cards, f, nowMs, sort]);
  // How many sit in each group, for the chips.
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: cards.length };
    for (const c of cards) {
      const g = stageDef(c.stage).group;
      counts[g] = (counts[g] ?? 0) + 1;
    }
    return counts;
  }, [cards]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="order-1 w-full sm:order-none sm:w-72"
          type="search"
          placeholder="Search name, business, phone, email…"
          aria-label="Search clients"
          value={f.term}
          onChange={(e) => set("term", e.target.value)}
        />
        <Select
          className="order-2 min-w-0 flex-1 sm:order-none sm:w-44 sm:flex-none"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="due">Next follow-up</option>
          <option value="name">Name</option>
          <option value="touch">Last contacted</option>
          <option value="newest">Newest first</option>
        </Select>
        {/* On a phone the groups are one swipeable row under the search, not three wrapped lines. */}
        <div
          className="order-4 -mx-4 flex w-[calc(100%+2rem)] gap-1.5 overflow-x-auto px-4 sm:order-none sm:mx-0 sm:w-auto sm:flex-wrap sm:px-0 sm:overflow-visible"
          role="group"
          aria-label="Filter by group"
        >
          {[{ key: "all" as const, label: "All" }, ...STAGE_GROUPS].map((g) => (
            <Chip
              key={g.key}
              active={f.group === g.key}
              count={groupCounts[g.key] ?? 0}
              onClick={() => set("group", g.key)}
            >
              {g.label}
            </Chip>
          ))}
        </div>
        <Button
          size="sm"
          className="order-3 sm:order-none"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          More filters{narrowing > 0 ? ` (${narrowing})` : ""}
        </Button>
        <span className="order-5 ml-auto text-xs text-muted tabular-nums sm:order-none">
          {rows.length} of {cards.length}
        </span>
      </div>

      {showMore ? (
        <div className="grid gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-3 lg:grid-cols-6">
          <Select
            aria-label="Stage"
            value={f.stage}
            onChange={(e) => set("stage", e.target.value as StageKey | "all")}
          >
            <option value="all">Any stage</option>
            {CORE_STAGES.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Source"
            value={f.source}
            onChange={(e) => set("source", e.target.value)}
          >
            <option value="all">Any source</option>
            {facets.sources.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select aria-label="State" value={f.state} onChange={(e) => set("state", e.target.value)}>
            <option value="all">Any state</option>
            {facets.states.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Industry"
            value={f.industry}
            onChange={(e) => set("industry", e.target.value)}
          >
            <option value="all">Any industry</option>
            {facets.industries.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Wants at least"
            value={f.minWanted}
            onChange={(e) => set("minWanted", Number(e.target.value))}
          >
            <option value={0}>Any amount wanted</option>
            {[10_000, 25_000, 50_000, 100_000].map((d) => (
              <option key={d} value={d * 100}>
                Wants ${d / 1000}k or more
              </option>
            ))}
          </Select>
          <Select
            aria-label="Not contacted in"
            value={f.quiet}
            onChange={(e) => set("quiet", e.target.value as QuietFilter)}
          >
            <option value="any">Any last contact</option>
            <option value="30">Not contacted in 30+ days</option>
            <option value="90">Not contacted in 90+ days</option>
            <option value="180">Not contacted in 180+ days</option>
            <option value="never">Never contacted</option>
          </Select>
          <div className="flex flex-wrap gap-2 sm:col-span-3 lg:col-span-6">
            <Button
              size="sm"
              disabled={narrowing === 0}
              onClick={() => setF({ ...NO_FILTERS, term: f.term })}
            >
              Clear filters
            </Button>
            <Button size="sm" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
              Download these {rows.length} (CSV)
            </Button>
          </div>
        </div>
      ) : null}

      {/* A phone gets rows with the name, stage and when to call; the table is for wider screens. */}
      {rows.length > 0 ? <ClientCards rows={rows} /> : null}

      {rows.length === 0 ? (
        <EmptyState title={cards.length === 0 ? "No clients yet" : "No matches"}>
          {cards.length === 0
            ? "Press “+ Add client” to start."
            : "Try a shorter search or a different filter."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface max-sm:hidden">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="bg-surface-2/60 text-[11px] font-semibold tracking-wide text-muted uppercase">
              <tr>
                <th className={TH}>Business</th>
                <th className={TH}>Merchant</th>
                <th className={TH}>Stage</th>
                <th className={cn(TH, "text-right")}>Wants</th>
                <th className={TH}>Next follow-up</th>
                <th className={TH}>Last contact</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => {
                const overdue = c.next_due_on !== null && c.next_due_on < today;
                return (
                  <tr key={c.id} className="transition hover:bg-surface-3">
                    <td className={TD}>
                      <Link
                        href={`/clients/${c.id}`}
                        className="font-semibold hover:text-accent hover:underline"
                      >
                        {c.business_name}
                      </Link>
                    </td>
                    <td className={cn(TD, "text-text-2")}>
                      {c.contact_name}
                      {c.phone ? (
                        <span className="block text-xs text-muted tabular-nums">
                          {formatUS(c.phone)}
                        </span>
                      ) : null}
                    </td>
                    <td className={TD}>
                      <StageBadge stage={c.stage} />
                    </td>
                    <td className={cn(TD, "text-right tabular-nums")}>
                      {formatMoneyCompact(c.wanted_amount_cents)}
                    </td>
                    <td className={TD}>
                      {c.scheduled_call_at ? (
                        <ReminderTag
                          text={reminderText(
                            c.scheduled_call_at,
                            c.reminder_channel,
                            timezone,
                            today,
                          )}
                        />
                      ) : null}{" "}
                      {c.next_due_on ? (
                        <Badge
                          tone={overdue ? "bad" : c.next_due_on === today ? "warn" : "neutral"}
                        >
                          {relativeDay(c.next_due_on, today)}
                        </Badge>
                      ) : c.scheduled_call_at ? null : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-muted")}>
                      {c.last_touch_at ? timeAgo(c.last_touch_at, new Date(nowMs)) : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
