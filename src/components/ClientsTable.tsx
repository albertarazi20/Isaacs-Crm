"use client";

import Link from "next/link";
import { ActiveBadge } from "./ActiveBadge";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CardMeta } from "@/lib/data/cardMeta";
import {
  activeCount,
  applyFilters,
  facetsOf,
  type ClientFilters,
  type QuietFilter,
} from "@/lib/data/clientFilters";
import type { ClientCard } from "@/lib/data/types";
import { CLIENT_HEADER, clientRows, toCsv } from "@/lib/export/csv";
import { timeAgo } from "@/lib/format";
import { bookedToday } from "@/lib/mca/booked";
import { formatUS } from "@/lib/mca/phone";
import { reminderText } from "@/lib/mca/reminder";
import { CORE_STAGES, STAGE_GROUPS, stageDef, type StageKey } from "@/lib/mca/stages";
import { useApp } from "./app-context";
import { ClientCards, DueText } from "./ClientCards";
import { useToast } from "./overlay";
import { SnoozeMenu } from "./power/SnoozeMenu";
import { ReminderTag } from "./ReminderTag";
import { Glyph } from "./shell/icons";
import { NewLeadButton } from "./shell/NewLead";
import { StageBadge } from "./StageBadge";
import { Avatar, Badge, Button, cn, EmptyState, IconButton, Input, Select } from "./ui";

type SortKey = "due" | "name" | "touch" | "newest" | "active";
const SORTS: readonly SortKey[] = ["due", "name", "touch", "newest", "active"];
const GROUPS = ["all", "prospecting", "application", "exit"] as const;
const QUIETS: readonly QuietFilter[] = ["any", "30", "90", "180", "never"];
/** Rows drawn at first; the rest arrive a page at a time so a book of hundreds still opens at once. */
const PAGE = 50;

/** Everything that narrows or orders the list. It lives in the address bar, so a view can be bookmarked or sent. */
interface View {
  f: ClientFilters;
  /** A bucket id, "none" (in no bucket) or "all". */
  bucket: string;
  /** A rep's id or "all". */
  owner: string;
  /** Only merchants already handed off. */
  brought: boolean;
  sort: SortKey;
}

const URL_KEYS = [
  "q",
  "group",
  "stage",
  "source",
  "state",
  "industry",
  "min",
  "quiet",
  "bucket",
  "owner",
  "brought",
  "sort",
] as const;

function pick<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function readView(p: { get(key: string): string | null }): View {
  const min = Number(p.get("min"));
  return {
    f: {
      term: p.get("q") ?? "",
      group: pick(p.get("group"), GROUPS, "all"),
      stage: pick<StageKey | "all">(
        p.get("stage"),
        ["all", ...CORE_STAGES.map((s) => s.key)],
        "all",
      ),
      source: p.get("source") ?? "all",
      state: p.get("state") ?? "all",
      industry: p.get("industry") ?? "all",
      minWanted: Number.isFinite(min) && min > 0 ? min : 0,
      quiet: pick(p.get("quiet"), QUIETS, "any"),
    },
    bucket: p.get("bucket") ?? "all",
    owner: p.get("owner") ?? "all",
    brought: p.get("brought") === "1",
    sort: pick(p.get("sort"), SORTS, "due"),
  };
}

function writeView(v: View): void {
  const next = new URLSearchParams(window.location.search);
  for (const k of URL_KEYS) next.delete(k);
  const put = (k: (typeof URL_KEYS)[number], value: string, fallback: string) => {
    if (value !== fallback) next.set(k, value);
  };
  put("q", v.f.term.trim(), "");
  put("group", v.f.group, "all");
  put("stage", v.f.stage, "all");
  put("source", v.f.source, "all");
  put("state", v.f.state, "all");
  put("industry", v.f.industry, "all");
  put("min", String(v.f.minWanted), "0");
  put("quiet", v.f.quiet, "any");
  put("bucket", v.bucket, "all");
  put("owner", v.owner, "all");
  put("brought", v.brought ? "1" : "0", "0");
  put("sort", v.sort, "due");
  const qs = next.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  if (url === `${window.location.pathname}${window.location.search}`) return;
  try {
    window.history.replaceState(null, "", url);
  } catch {
    /* a browser may throttle rapid history writes while someone types; the next change catches up */
  }
}

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

/** One choice in the row of stage groups: a pill with its count. */
function GroupChip({
  active,
  count,
  tone = "accent",
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  tone?: "accent" | "good";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition duration-150 active:scale-[0.97] sm:h-8",
        active
          ? "bg-surface text-text shadow-card"
          : "text-muted hover:bg-surface/60 hover:text-text",
      )}
    >
      {children}
      <span
        className={cn(
          "rounded-full px-1.5 text-[11px] tabular-nums",
          active
            ? tone === "good"
              ? "bg-good-soft text-good"
              : "bg-accent-soft text-accent"
            : "bg-surface-3 text-muted",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// One grid for the header and every row, so the columns line up without a table's rigid layout:
// merchant, stage, [bucket from 1280], next follow-up, last touch, [owner from 1400], actions.
const COLS =
  "grid items-center gap-x-4 px-4 sm:px-5 grid-cols-[minmax(0,2.3fr)_minmax(0,1.5fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_112px] xl:grid-cols-[minmax(0,2.3fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_112px] min-[87.5rem]:grid-cols-[minmax(0,2.3fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1fr)_112px]";

function SortHead({
  label,
  sortKey,
  current,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  onSort: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <div role="columnheader" aria-sort={active ? "ascending" : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
        className={cn(
          "eyebrow -mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 whitespace-nowrap transition duration-150 hover:text-text active:scale-[0.97]",
          active && "text-text",
        )}
      >
        {label}
        <Glyph
          name="chevronDown"
          strokeWidth={2.2}
          className={cn("size-3 transition", active ? "opacity-100" : "opacity-0")}
        />
      </button>
    </div>
  );
}

export function ClientsTable({
  cards,
  meta,
}: {
  cards: ClientCard[];
  /** Bucket, owner and hand-off by client id. */
  meta: Record<string, CardMeta>;
}) {
  const { today, nowMs, timezone } = useApp();
  const toast = useToast();
  const params = useSearchParams();
  const [view, setView] = useState<View>(() => readView(params));
  const [showMore, setShowMore] = useState(() => {
    const v = readView(params);
    return activeCount({ ...v.f, group: "all" }) > 0 || v.bucket !== "all" || v.owner !== "all";
  });
  const [limit, setLimit] = useState(PAGE);
  const { f, bucket, owner, brought, sort } = view;

  /** Any change to the view starts the list from its first page again. */
  const change = (patch: Partial<View>) => {
    setView((prev) => ({ ...prev, ...patch }));
    setLimit(PAGE);
  };
  const set = <K extends keyof ClientFilters>(key: K, value: ClientFilters[K]) =>
    change({ f: { ...f, [key]: value } });

  useEffect(() => writeView(view), [view]);

  const facets = useMemo(() => facetsOf(cards), [cards]);
  const { buckets, owners, noBucket } = useMemo(() => {
    const b = new Map<string, string>();
    const o = new Map<string, string>();
    let none = 0;
    for (const c of cards) {
      const m = meta[c.id];
      if (!m) continue;
      if (m.bucket_id && m.bucket_name) b.set(m.bucket_id, m.bucket_name);
      else none += 1;
      o.set(m.owner_id, m.owner_name || "Unnamed");
    }
    const sorted = (map: Map<string, string>) =>
      [...map].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name));
    return { buckets: sorted(b), owners: sorted(o), noBucket: none };
  }, [cards, meta]);

  const narrowing =
    activeCount({ ...f, group: "all" }) + (bucket !== "all" ? 1 : 0) + (owner !== "all" ? 1 : 0);
  const anyFilter = narrowing > 0 || f.group !== "all" || brought || f.term.trim() !== "";

  const rows = useMemo(() => {
    const list = applyFilters(cards, f, nowMs).filter((c) => {
      const m = meta[c.id];
      if (bucket === "none" ? Boolean(m?.bucket_id) : bucket !== "all" && m?.bucket_id !== bucket)
        return false;
      if (owner !== "all" && m?.owner_id !== owner) return false;
      if (brought && !m?.brought_in_at) return false;
      return true;
    });
    const by: Record<SortKey, (a: ClientCard, b: ClientCard) => number> = {
      due: (a, b) =>
        (a.next_due_on ?? "9999").localeCompare(b.next_due_on ?? "9999") ||
        a.business_name.localeCompare(b.business_name),
      name: (a, b) => a.business_name.localeCompare(b.business_name),
      touch: (a, b) => (b.last_touch_at ?? "").localeCompare(a.last_touch_at ?? ""),
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
      // the merchant's own last move (reply, open, document, signature), most recent first; never-active last
      active: (a, b) =>
        (meta[b.id]?.active_at ?? "").localeCompare(meta[a.id]?.active_at ?? "") ||
        a.business_name.localeCompare(b.business_name),
    };
    return [...list].sort(by[sort]);
  }, [cards, meta, f, bucket, owner, brought, nowMs, sort]);

  // How many sit in each group, for the chips.
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: cards.length, brought: 0 };
    for (const c of cards) {
      const g = stageDef(c.stage).group;
      out[g] = (out[g] ?? 0) + 1;
      if (meta[c.id]?.brought_in_at) out.brought = (out.brought ?? 0) + 1;
    }
    return out;
  }, [cards, meta]);

  const shown = rows.slice(0, limit);
  const clearAll = () => change({ ...readView(new URLSearchParams()), sort });

  async function copyPhone(c: ClientCard) {
    try {
      await navigator.clipboard.writeText(formatUS(c.phone));
      toast({ message: `Copied ${formatUS(c.phone)}`, tone: "success" });
    } catch {
      toast({ message: "Couldn't copy. Select the number and copy it by hand.", tone: "error" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="glass z-20 rounded-2xl border border-border p-2 shadow-card lg:sticky lg:top-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative order-1 block min-w-0 flex-1 basis-40 sm:min-w-52">
            <span className="sr-only">Search merchants</span>
            <Glyph
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              className="rounded-full pl-9"
              type="search"
              placeholder="Search name, business, phone, email"
              value={f.term}
              onChange={(e) => set("term", e.target.value)}
            />
          </label>

          {/* On a phone the groups are one swipeable row under the search, not three wrapped lines. */}
          <div
            className="order-3 flex w-full gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-2/70 p-1 md:order-2 md:w-auto"
            role="group"
            aria-label="Filter by group"
          >
            {[{ key: "all" as const, label: "All" }, ...STAGE_GROUPS].map((g) => (
              <GroupChip
                key={g.key}
                active={f.group === g.key && !brought}
                count={counts[g.key] ?? 0}
                onClick={() => change({ f: { ...f, group: g.key }, brought: false })}
              >
                {g.label}
              </GroupChip>
            ))}
            <GroupChip
              active={brought}
              tone="good"
              count={counts.brought ?? 0}
              onClick={() => change({ f: { ...f, group: "all" }, brought: !brought })}
            >
              Brought in
            </GroupChip>
          </div>

          <div className="order-2 flex items-center md:order-3">
            <Button
              size="sm"
              aria-expanded={showMore}
              onClick={() => setShowMore((v) => !v)}
              className={cn(showMore && "border-border-strong bg-surface-3")}
            >
              <Glyph name="filter" className="size-3.5 text-muted" />
              Filters
              {narrowing > 0 ? (
                <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent tabular-nums">
                  {narrowing}
                </span>
              ) : null}
            </Button>
          </div>
        </div>

        {showMore ? (
          <div className="mt-2 animate-fade border-t border-border px-1 pt-3 pb-1">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 2xl:grid-cols-8">
              <Select
                aria-label="Bucket"
                value={bucket}
                onChange={(e) => change({ bucket: e.target.value })}
              >
                <option value="all">Any bucket</option>
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {noBucket > 0 ? <option value="none">In no bucket</option> : null}
              </Select>
              <Select
                aria-label="Owner"
                value={owner}
                onChange={(e) => change({ owner: e.target.value })}
              >
                <option value="all">Any owner</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
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
              <Select
                aria-label="State"
                value={f.state}
                onChange={(e) => set("state", e.target.value)}
              >
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
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" disabled={!anyFilter} onClick={clearAll}>
                Clear filters
              </Button>
              <Button size="sm" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
                <Glyph name="sheet" className="size-3.5 text-muted" />
                Download these {rows.length} (CSV)
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-xs text-muted tabular-nums" aria-live="polite">
          {rows.length === cards.length
            ? `${cards.length} merchant${cards.length === 1 ? "" : "s"}`
            : `${rows.length} of ${cards.length} merchants`}
        </p>
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="max-sm:sr-only">Sort</span>
          <Select
            className="h-10 w-auto min-w-0 rounded-full bg-surface pr-8 text-[13px] sm:h-8"
            aria-label="Sort by"
            value={sort}
            onChange={(e) => change({ sort: e.target.value as SortKey })}
          >
            <option value="due">Next follow-up</option>
            <option value="name">Name</option>
            <option value="touch">Last contacted</option>
            <option value="newest">Newest first</option>
            <option value="active">Most active</option>
          </Select>
        </label>
      </div>

      {rows.length === 0 ? (
        cards.length === 0 ? (
          <EmptyState title="No merchants yet" action={<NewLeadButton />}>
            Add your first lead. A name and a number is enough to start the clock.
          </EmptyState>
        ) : (
          <EmptyState
            title="No matches"
            action={
              <Button size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            }
          >
            Try a shorter search or a different filter.
          </EmptyState>
        )
      ) : (
        <>
          {/* A phone gets stacked rows with the name, stage and when to call; the grid is for wider screens. */}
          <ClientCards rows={shown} meta={meta} />

          <div
            role="table"
            aria-label="Merchants"
            className="rounded-2xl border border-border bg-surface text-[13px] max-md:hidden"
          >
            <div role="rowgroup">
              <div
                role="row"
                className={cn(COLS, "h-10 rounded-t-2xl border-b border-border bg-surface-2/40")}
              >
                <SortHead
                  label="Merchant"
                  sortKey="name"
                  current={sort}
                  onSort={(k) => change({ sort: k })}
                />
                <div role="columnheader" className="eyebrow">
                  Stage
                </div>
                <div role="columnheader" className="eyebrow hidden xl:block">
                  Bucket
                </div>
                <SortHead
                  label="Next follow-up"
                  sortKey="due"
                  current={sort}
                  onSort={(k) => change({ sort: k })}
                />
                <SortHead
                  label="Last touch"
                  sortKey="touch"
                  current={sort}
                  onSort={(k) => change({ sort: k })}
                />
                <div role="columnheader" className="eyebrow hidden min-[87.5rem]:block">
                  Owner
                </div>
                <div role="columnheader">
                  <span className="sr-only">Actions</span>
                </div>
              </div>
            </div>
            <div role="rowgroup" className="divide-y divide-border">
              {shown.map((c) => {
                const m = meta[c.id];
                const booked = bookedToday(c, today, timezone);
                return (
                  <div
                    key={c.id}
                    role="row"
                    className={cn(
                      COLS,
                      "group relative min-h-[52px] py-1.5 transition-colors duration-150 last:rounded-b-2xl hover:bg-surface-2/50 focus-within:bg-surface-2/50",
                    )}
                  >
                    <div role="cell" className="flex min-w-0 items-center gap-3">
                      <Avatar name={c.business_name} size={32} />
                      <div className="min-w-0">
                        <Link
                          href={`/clients/${c.id}`}
                          className="block truncate font-semibold tracking-tight after:absolute after:inset-0 group-hover:text-accent-strong"
                        >
                          {c.business_name}
                        </Link>
                        <p className="truncate text-xs text-muted">
                          {[c.contact_name, c.phone ? formatUS(c.phone) : ""]
                            .filter(Boolean)
                            .join(" · ") || "No contact on file"}
                        </p>
                      </div>
                    </div>
                    <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
                      <StageBadge stage={c.stage} />
                      {m?.brought_in_at ? (
                        <Badge tone="good">
                          <Glyph name="check" className="size-3" strokeWidth={2.4} />
                          Brought in
                        </Badge>
                      ) : (
                        <ActiveBadge at={m?.active_at} nowMs={nowMs} />
                      )}
                    </div>
                    <div role="cell" className="hidden min-w-0 truncate text-text-2 xl:block">
                      {m?.bucket_name ?? <span className="text-muted">None</span>}
                    </div>
                    <div
                      role="cell"
                      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
                    >
                      <DueText card={c} />
                      {c.scheduled_call_at ? (
                        <ReminderTag
                          text={reminderText(
                            c.scheduled_call_at,
                            c.reminder_channel,
                            timezone,
                            today,
                          )}
                        />
                      ) : null}
                    </div>
                    <div role="cell" className="truncate text-muted tabular-nums">
                      {c.last_touch_at ? timeAgo(c.last_touch_at, new Date(nowMs)) : "Never"}
                    </div>
                    <div
                      role="cell"
                      className="hidden min-w-0 items-center gap-2 text-text-2 min-[87.5rem]:flex"
                    >
                      {m ? (
                        <>
                          <Avatar name={m.owner_name || "?"} size={22} />
                          <span className="truncate">{m.owner_name || "Unnamed"}</span>
                        </>
                      ) : null}
                    </div>
                    <div
                      role="cell"
                      className="relative z-10 flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 has-[[open]]:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      {c.phone ? (
                        <IconButton
                          label={`Copy ${c.business_name}'s phone number`}
                          onClick={() => void copyPhone(c)}
                        >
                          <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            className="size-4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="9" y="9" width="11" height="11" rx="2.5" />
                            <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
                          </svg>
                        </IconButton>
                      ) : null}
                      {booked ? null : <SnoozeMenu card={c} compact />}
                      <Link
                        href={`/clients/${c.id}`}
                        aria-label={`Open ${c.business_name}`}
                        title="Open"
                        className="inline-flex size-8 items-center justify-center rounded-full text-muted transition duration-150 hover:bg-surface-2 hover:text-text active:scale-95"
                      >
                        <Glyph name="arrowUpRight" className="size-4" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {rows.length > shown.length ? (
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Button size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown.length)} more
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLimit(rows.length)}>
                Show all {rows.length}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
