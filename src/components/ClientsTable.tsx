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
import { STAGE_GROUPS, STAGES, type StageKey } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
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

export function ClientsTable({ cards }: { cards: ClientCard[] }) {
  const { today, nowMs } = useApp();
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-72"
          type="search"
          placeholder="Search name, business, phone, email…"
          aria-label="Search clients"
          value={f.term}
          onChange={(e) => set("term", e.target.value)}
        />
        <Select
          className="w-48"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="due">Next follow-up</option>
          <option value="name">Name</option>
          <option value="touch">Last contacted</option>
          <option value="newest">Newest first</option>
        </Select>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by group">
          {[{ key: "all" as const, label: "All" }, ...STAGE_GROUPS].map((g) => (
            <button
              key={g.key}
              type="button"
              aria-pressed={f.group === g.key}
              onClick={() => set("group", g.key)}
              className={cn(
                "h-8 rounded-lg border px-2.5 text-sm font-medium",
                f.group === g.key
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <Button size="sm" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
          More filters{narrowing > 0 ? ` (${narrowing})` : ""}
        </Button>
        <span className="ml-auto text-sm text-muted">
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
            {STAGES.map((st) => (
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

      {rows.length === 0 ? (
        <EmptyState title={cards.length === 0 ? "No clients yet" : "No matches"}>
          {cards.length === 0
            ? "Press “+ Add client” to start."
            : "Try a shorter search or a different filter."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border text-xs font-medium text-muted uppercase">
              <tr>
                <th className="px-3 py-2">Business</th>
                <th className="px-3 py-2">Merchant</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2 text-right">Wants</th>
                <th className="px-3 py-2">Next follow-up</th>
                <th className="px-3 py-2">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const overdue = c.next_due_on !== null && c.next_due_on < today;
                return (
                  <tr
                    key={c.id}
                    className="border-b border-border last:border-0 hover:bg-surface-2/60"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/clients/${c.id}`}
                        className="font-semibold hover:text-accent hover:underline"
                      >
                        {c.business_name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {c.contact_name}
                      {c.phone ? <span className="block text-xs">{formatUS(c.phone)}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <StageBadge stage={c.stage} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoneyCompact(c.wanted_amount_cents)}
                    </td>
                    <td className="px-3 py-2">
                      {c.next_due_on ? (
                        <Badge
                          tone={overdue ? "bad" : c.next_due_on === today ? "warn" : "neutral"}
                        >
                          {relativeDay(c.next_due_on, today)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">
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
