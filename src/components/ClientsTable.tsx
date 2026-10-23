"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ClientCard } from "@/lib/data/types";
import { relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { STAGE_GROUPS, stageDef, type StageGroup } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { StageBadge } from "./StageBadge";
import { Badge, cn, EmptyState, Input, Select } from "./ui";

type SortKey = "due" | "name" | "touch" | "newest";

function matches(c: ClientCard, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const digits = t.replace(/\D/g, "");
  return (
    c.business_name.toLowerCase().includes(t) ||
    c.dba.toLowerCase().includes(t) ||
    c.contact_name.toLowerCase().includes(t) ||
    c.email.toLowerCase().includes(t) ||
    (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits))
  );
}

export function ClientsTable({ cards }: { cards: ClientCard[] }) {
  const { today } = useApp();
  const [term, setTerm] = useState("");
  const [group, setGroup] = useState<StageGroup | "all">("all");
  const [sort, setSort] = useState<SortKey>("due");

  const rows = useMemo(() => {
    const list = cards.filter(
      (c) => matches(c, term) && (group === "all" || stageDef(c.stage).group === group),
    );
    const by: Record<SortKey, (a: ClientCard, b: ClientCard) => number> = {
      due: (a, b) =>
        (a.next_due_on ?? "9999").localeCompare(b.next_due_on ?? "9999") ||
        a.business_name.localeCompare(b.business_name),
      name: (a, b) => a.business_name.localeCompare(b.business_name),
      touch: (a, b) => (b.last_touch_at ?? "").localeCompare(a.last_touch_at ?? ""),
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
    };
    return [...list].sort(by[sort]);
  }, [cards, term, group, sort]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-72"
          type="search"
          placeholder="Search name, business, phone, email…"
          aria-label="Search clients"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
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
              aria-pressed={group === g.key}
              onClick={() => setGroup(g.key)}
              className={cn(
                "h-8 rounded-lg border px-2.5 text-sm font-medium",
                group === g.key
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-sm text-muted">
          {rows.length} of {cards.length}
        </span>
      </div>

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
                      {c.last_touch_at ? timeAgo(c.last_touch_at) : "never"}
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
