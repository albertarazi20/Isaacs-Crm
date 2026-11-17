"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  blastAction,
  moveToBucketAction,
  pauseEnrollmentAction,
  removeFromBucketAction,
} from "@/app/buckets-actions";
import { handOffAction, undoHandOffAction } from "@/app/followup-actions";
import { useApp } from "@/components/app-context";
import { FormDialog, useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { NewLeadButton } from "@/components/shell/NewLead";
import { Avatar, Button, EmptyState, IconButton, Input, Kbd, Select, cn } from "@/components/ui";
import type { BucketMember, BucketRow, TemplateRow } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";
import { formatDate, timeAgo } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import type { MemberMeta } from "@/lib/messaging/memberMeta";
import { mergeValues, resolveMergeFields } from "@/lib/messaging/merge";
import { isReadyBucket } from "./bucketCopy";
import { MemberDrawer, type MemberActions } from "./MemberDrawer";
import {
  Ico,
  MemberChips,
  NEXT_TONE,
  copyUploadLink,
  nextUp,
  noUsableEmail,
  rowActionLabel,
} from "./memberParts";

type Filter = "all" | "due" | "replied" | "quiet" | "no_email" | "paused";
const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "due", label: "Due today" },
  { id: "replied", label: "Replied" },
  { id: "quiet", label: "Quiet 7 days" },
  { id: "no_email", label: "No usable email" },
  { id: "paused", label: "Paused" },
];

/** One grid for the header and every row, so the columns line up. A phone stacks the same cells. */
const GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 md:grid-cols-[auto_minmax(0,2.1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.7fr)_132px] md:gap-x-4";

/** Why a blast skipped a merchant, in words (src/lib/send/enqueue.ts and queueBlast give the codes). */
const SKIP_WORDS: Record<string, string> = {
  duplicate: "already queued or sent today",
  brought_in: "handed off",
  opted_out: "opted out",
  no_address: "no email address",
  suppressed: "address blocked",
  dnc: "do not contact",
};

/** The lead lines of one bucket: search, filter, check, blast, move, pause, hand off, and a sheet per merchant. */
export function BucketMembers({
  bucket,
  members,
  meta,
  buckets,
  templates,
  steps,
}: {
  bucket: BucketRow;
  members: BucketMember[];
  /** Each lead's latest reply tag and the day a pause lifts, by client id. */
  meta: Record<string, MemberMeta>;
  buckets: BucketRow[];
  templates: TemplateRow[];
  /** The bucket's sequence, so a row can say what goes out next. */
  steps: readonly SequenceStep[];
}) {
  const { today, nowMs, senderName } = useApp();
  const router = useRouter();
  const run = useRun();
  const toast = useToast();
  const ready = isReadyBucket(bucket);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [tz, setTz] = useState("");
  const [query, setQuery] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmBlast, setConfirmBlast] = useState(false);
  const searchRef = useRef<HTMLLabelElement>(null);

  // "/" jumps to the search box, unless something is being typed or a sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      searchRef.current?.querySelector("input")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zones = useMemo(() => [...new Set(members.map((m) => m.tz_label))].sort(), [members]);
  const counts = useMemo(() => {
    const is = (m: BucketMember, f: Filter) => matches(m, f, today, nowMs);
    return Object.fromEntries(
      FILTERS.map((f) => [f.id, members.filter((m) => is(m, f.id)).length]),
    ) as Record<Filter, number>;
  }, [members, today, nowMs]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members.filter((m) => {
      if (tz && m.tz_label !== tz) return false;
      if (!matches(m, filter, today, nowMs)) return false;
      if (!needle) return true;
      return [m.business_name, m.contact_name, m.email, m.phone, m.state].some((v) =>
        v.toLowerCase().includes(needle),
      );
    });
  }, [members, filter, tz, query, today, nowMs]);
  const picked = shown.filter((m) => checked.has(m.client_id));
  const ids = picked.map((m) => m.client_id);
  const allShown = shown.length > 0 && picked.length === shown.length;
  const opened = openId ? (members.find((m) => m.client_id === openId) ?? null) : null;
  const narrowed = filter !== "all" || tz !== "" || query.trim() !== "";

  function toggleAll() {
    setChecked((cur) => {
      const next = new Set(cur);
      if (allShown) for (const m of shown) next.delete(m.client_id);
      else for (const m of shown) next.add(m.client_id);
      return next;
    });
  }
  const toggle = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearFilters = () => {
    setFilter("all");
    setTz("");
    setQuery("");
  };

  async function act(label: string, p: Parameters<typeof run>[0]) {
    setBusy(true);
    const ok = await run(p, label);
    setBusy(false);
    if (ok) {
      setChecked(new Set());
      router.refresh();
    }
  }

  // Hand off: the merchant is marked brought in and the chase stops. The toast carries the way back.
  // Undo puts each merchant back in the bucket they were taken out of, at the same step; one with no bucket to go
  // back to gets a follow-up for tomorrow instead. The toast says which happened.
  async function undoHandOff(list: readonly BucketMember[]) {
    const back: { name: string; bucket: string }[] = [];
    let toFollowUp = 0;
    for (const m of list) {
      const r = await undoHandOffAction({ clientId: m.client_id }).catch(() => null);
      if (!r?.ok) {
        toast({ message: r ? r.error : "Couldn't reach the server", tone: "error" });
        continue;
      }
      if (!r.data.undone) continue;
      if (r.data.bucket) back.push({ name: m.business_name, bucket: r.data.bucket });
      else toFollowUp += 1;
    }
    const parts: string[] = [];
    const only = back.length === 1 ? back[0] : undefined;
    if (only) parts.push(`${only.name} is back in ${only.bucket}, at the step it stopped on.`);
    else if (back.length > 1)
      parts.push(
        `${back.length} merchants are back in their buckets, at the step each stopped on.`,
      );
    if (toFollowUp > 0)
      parts.push(
        toFollowUp === 1
          ? "One had no bucket to go back to, so it has a follow-up for tomorrow."
          : `${toFollowUp} had no bucket to go back to, so each has a follow-up for tomorrow.`,
      );
    if (parts.length > 0)
      toast({
        message: `Hand-off${back.length + toFollowUp === 1 ? "" : "s"} undone. ${parts.join(" ")}`,
      });
    router.refresh();
  }
  async function handOff(list: readonly BucketMember[]) {
    if (list.length === 0) return;
    setBusy(true);
    const done: BucketMember[] = [];
    let failed: string | null = null;
    for (const m of list) {
      const r = await handOffAction({ clientId: m.client_id }).catch(() => null);
      if (r?.ok) done.push(m);
      else failed = r ? r.error : "Couldn't reach the server. Check your connection";
    }
    setBusy(false);
    setOpenId(null);
    if (failed) toast({ message: failed, tone: "error" });
    if (done.length === 0) return;
    toast({
      message:
        done.length === 1
          ? `${done[0]?.business_name ?? "Merchant"} handed off`
          : `${done.length} merchants handed off`,
      tone: "success",
      action: { label: "Undo", onClick: () => void undoHandOff(done) },
    });
    setChecked(new Set());
    router.refresh();
  }

  async function uploadLink(m: BucketMember) {
    const r = await copyUploadLink(m.client_id);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({
      message: r.copied ? `Upload link for ${m.business_name} copied. Good for 2 hours` : r.url,
      tone: r.copied ? "success" : "info",
    });
  }

  const pause = (list: readonly BucketMember[], paused: boolean, until?: ISODate) =>
    act(
      until ? `Paused until ${formatDate(until, today)}` : paused ? "Paused" : "Resumed",
      pauseEnrollmentAction({
        clientIds: list.map((m) => m.client_id),
        paused,
        ...(until ? { until } : {}),
      }),
    );
  const actions: MemberActions = {
    onHandOff: (m) => void handOff([m]),
    onPause: (m, paused, until) => void pause([m], paused, until),
    onMove: (m, bucketId) =>
      void act("Moved", moveToBucketAction({ clientIds: [m.client_id], bucketId })),
    onRemove: (m) => void act("Removed", removeFromBucketAction({ clientIds: [m.client_id] })),
  };

  // The blast confirm shows the template merged for the first checked merchant (P2-14), so what goes out is
  // seen before it goes. Links are only known at send time, so they show as placeholders here.
  const blastTemplate = confirmBlast ? templates.find((x) => x.id === templateId) : undefined;
  const blastFirst = confirmBlast ? picked[0] : undefined;
  const blastPreview =
    blastTemplate && blastFirst
      ? (() => {
          const values = mergeValues({
            contactName: blastFirst.contact_name,
            businessName: blastFirst.business_name,
            senderName,
            applicationLink: "[application link]",
            wantedAmountCents: blastFirst.wanted_amount_cents,
            uploadLink: "[upload link]",
          });
          return {
            subject: resolveMergeFields(blastTemplate.subject, values),
            body: resolveMergeFields(blastTemplate.body, values),
          };
        })()
      : null;
  const blastBlank = blastPreview
    ? [...new Set([...blastPreview.subject.missing, ...blastPreview.body.missing])]
    : [];

  async function blast() {
    if (!templateId || ids.length === 0) return;
    const why = (reason: string | undefined) => (reason ? (SKIP_WORDS[reason] ?? reason) : "");
    setConfirmBlast(false);
    setBusy(true);
    const r = await blastAction({ templateId, clientIds: ids });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({
      message: `${r.data.queued} queued${r.data.skipped.length ? `, ${r.data.skipped.length} skipped (${why(r.data.skipped[0]?.reason)})` : ""}`,
      tone: "success",
    });
    setChecked(new Set());
    router.refresh();
  }

  if (members.length === 0)
    return (
      <EmptyState title="Nobody in this bucket yet" action={<NewLeadButton />}>
        {ready
          ? "A merchant lands here by itself once the application and every document are in."
          : "Merchants land here from New lead, your sheets and the document rules."}
      </EmptyState>
    );

  const anyPaused = picked.some((m) => m.paused);
  const anyRunning = picked.some((m) => !m.paused);

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-border bg-surface">
        {/* What is shown: search, the filters with their counts, the time zone. */}
        <div className="flex flex-wrap items-center gap-2 p-3 sm:px-4">
          <label ref={searchRef} className="relative w-full sm:w-64">
            <span className="sr-only">Search this bucket</span>
            <Glyph
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, phone"
              className="rounded-full pr-9 pl-9 sm:h-8 sm:text-[13px]"
            />
            <span className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 sm:block">
              <Kbd>/</Kbd>
            </span>
          </label>
          <div
            role="group"
            aria-label="Show"
            className="-mx-3 flex min-w-0 flex-1 gap-1 overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:px-0"
          >
            {FILTERS.map((f) => {
              const on = filter === f.id;
              const n = counts[f.id];
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition duration-150 active:scale-[0.97] sm:h-8",
                    on
                      ? "border-accent/40 bg-accent-soft text-accent"
                      : "border-transparent text-muted hover:bg-surface-2 hover:text-text",
                    !on && n === 0 && "opacity-60",
                  )}
                >
                  {f.label}
                  <span className="text-[11px] tabular-nums opacity-80">{n}</span>
                </button>
              );
            })}
          </div>
          {zones.length > 1 ? (
            <Select
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              className="w-full rounded-full sm:h-8 sm:w-auto sm:text-[13px]"
              aria-label="Time zone"
            >
              <option value="">Every time zone</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          ) : null}
        </div>

        {/* Column heads; on a phone this row is just "check all". */}
        <div className={cn(GRID, "border-y border-border bg-surface-3/50 px-3 py-2 sm:px-4")}>
          {/* a 40px target on a phone around the 17px box */}
          <label className="-m-3 inline-flex size-10 cursor-pointer items-center justify-center sm:m-0 sm:size-auto">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={allShown}
              onChange={toggleAll}
              aria-label="Check every row shown"
            />
          </label>
          <span className="eyebrow">
            <span className="md:hidden">
              {ids.length ? `${ids.length} checked` : `Check all ${shown.length}`}
            </span>
            <span className="hidden md:inline">Merchant</span>
          </span>
          <span className="eyebrow hidden md:block">Status</span>
          <span className="eyebrow hidden md:block">Last touch</span>
          <span className="eyebrow hidden md:block">Next up</span>
          <span className="eyebrow text-right tabular-nums">
            {shown.length === members.length
              ? members.length
              : `${shown.length} of ${members.length}`}
          </span>
        </div>

        {shown.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-semibold">Nobody matches</p>
            <p className="mt-1 text-sm text-muted">
              {members.length} {members.length === 1 ? "merchant is" : "merchants are"} in this
              bucket, none under this search and filter.
            </p>
            <Button size="sm" className="mt-4" onClick={clearFilters}>
              Show everyone
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((m) => {
              const on = checked.has(m.client_id);
              const next = nextUp(m, steps, today);
              const touched = m.last_touch_at
                ? timeAgo(m.last_touch_at, new Date(nowMs))
                : "Never touched";
              return (
                <li
                  key={m.enrollment_id}
                  className={cn(
                    GRID,
                    "group relative px-3 py-2.5 transition-colors duration-150 sm:px-4",
                    on ? "bg-accent-soft/40" : "hover:bg-surface-2/50",
                  )}
                >
                  <label className="relative z-10 -m-3 inline-flex size-10 cursor-pointer items-center justify-center sm:m-0 sm:size-auto">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={on}
                      onChange={() => toggle(m.client_id)}
                      aria-label={`Check ${m.business_name}`}
                    />
                  </label>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={m.business_name} size={34} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-text">
                        {m.business_name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {[m.contact_name, m.email || m.phone || "no email or phone"]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </div>
                  {/* The whole row opens the merchant's sheet; the checkbox and quick actions sit above it. */}
                  <button
                    type="button"
                    aria-label={`Actions for ${m.business_name}`}
                    aria-haspopup="dialog"
                    onClick={() => setOpenId(m.client_id)}
                    className="absolute inset-0 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  />
                  <MemberChips
                    m={m}
                    meta={meta[m.client_id]}
                    today={today}
                    className="col-span-2 col-start-2 md:col-span-1 md:col-start-3"
                  />
                  <div className="hidden min-w-0 md:col-start-4 md:block">
                    <p className="truncate text-[13px] text-text-2">{touched}</p>
                    <p className="truncate text-xs text-muted">
                      Added {timeAgo(m.entered_at, new Date(nowMs))}
                    </p>
                  </div>
                  <div className="col-span-2 col-start-2 min-w-0 md:col-span-1 md:col-start-5">
                    <p className="truncate text-[13px] text-text-2">
                      <span className="font-medium text-text">{next.step}</span> · {next.title}
                    </p>
                    <p className="truncate text-xs text-muted" title={next.date ?? undefined}>
                      <span className={cn("font-medium", NEXT_TONE[next.tone])}>{next.when}</span>
                      {" · "}
                      {m.steps_sent} sent
                      <span className="md:hidden"> · {touched.toLowerCase()}</span>
                    </p>
                  </div>
                  <div className="relative z-10 col-start-3 row-start-1 flex items-center justify-end md:col-start-6">
                    {ready ? (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handOff([m])}
                        aria-label={`Hand off ${m.business_name}`}
                      >
                        Hand off
                      </Button>
                    ) : (
                      <>
                        <span className="hidden items-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 md:flex [@media(hover:none)]:hidden">
                          <IconButton
                            label={`Hand off ${m.business_name}`}
                            disabled={busy}
                            onClick={() => void handOff([m])}
                          >
                            <Glyph name="flag" className="size-4" />
                          </IconButton>
                          <IconButton
                            label={rowActionLabel.copyLink(m)}
                            onClick={() => void uploadLink(m)}
                          >
                            <Glyph name="link" className="size-4" />
                          </IconButton>
                          <IconButton
                            label={rowActionLabel.pause(m)}
                            disabled={busy}
                            onClick={() => void pause([m], !m.paused)}
                          >
                            <Ico name={m.paused ? "play" : "pause"} />
                          </IconButton>
                          <Link
                            href={`/clients/${m.client_id}`}
                            aria-label={`Open ${m.business_name}`}
                            title="Open merchant"
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition duration-150 hover:bg-surface-2 hover:text-text active:scale-95"
                          >
                            <Glyph name="arrowUpRight" className="size-4" />
                          </Link>
                        </span>
                        <Ico
                          name="chevron"
                          className="pointer-events-none size-4 text-muted md:hidden"
                        />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {narrowed && shown.length > 0 ? (
        <p className="px-1 text-xs text-muted">
          Showing {shown.length} of {members.length}.{" "}
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={clearFilters}
          >
            Show everyone
          </button>
        </p>
      ) : null}

      {/* Checked rows bring up the bulk bar: it floats over the list and stays in reach while you scroll. */}
      {ids.length > 0 ? (
        <div className="sticky bottom-3 z-20 flex justify-center sm:bottom-5">
          <div
            role="toolbar"
            aria-label="Checked merchants"
            className="glass-strong flex w-full max-w-full animate-pop flex-wrap items-center gap-2 rounded-3xl border border-border-strong p-2 shadow-pop sm:w-auto sm:rounded-full sm:pl-4"
          >
            <span className="order-1 flex items-center gap-1 pl-2 text-[13px] font-semibold tabular-nums sm:order-none sm:pl-0">
              {ids.length} checked
              <IconButton label="Uncheck all" onClick={() => setChecked(new Set())}>
                <Glyph name="x" className="size-4" />
              </IconButton>
            </span>
            <span aria-hidden className="hidden h-5 w-px bg-border-strong sm:block" />
            <div className="order-3 flex w-full items-center gap-2 sm:order-none sm:w-auto">
              <Select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="min-w-0 flex-1 rounded-full sm:h-8 sm:w-44 sm:flex-none sm:text-[13px]"
                aria-label="Blast template"
              >
                <option value="">Blast template…</option>
                {templates
                  .filter((t) => !t.archived)
                  .map((t) => (
                    <option key={t.id} value={t.id} disabled={!t.approved}>
                      {t.name}
                      {t.approved ? "" : " (needs approval)"}
                    </option>
                  ))}
              </Select>
              <Button
                variant={ready ? "secondary" : "primary"}
                size="sm"
                disabled={busy || !templateId}
                onClick={() => setConfirmBlast(true)}
              >
                <Glyph name="send" className="size-3.5" />
                Blast {ids.length}
              </Button>
            </div>
            <div className="order-4 flex w-full items-center gap-2 sm:order-none sm:w-auto">
              <Select
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
                className="min-w-0 flex-1 rounded-full sm:h-8 sm:w-40 sm:flex-none sm:text-[13px]"
                aria-label="Move to bucket"
              >
                <option value="">Move to…</option>
                {buckets
                  .filter((b) => b.id !== bucket.id)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </Select>
              <Button
                size="sm"
                disabled={busy || !moveTo}
                onClick={() =>
                  void act("Moved", moveToBucketAction({ clientIds: ids, bucketId: moveTo }))
                }
              >
                Move
              </Button>
            </div>
            <div className="order-5 flex w-full items-center gap-1 sm:order-none sm:w-auto">
              {anyRunning ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void pause(
                      picked.filter((m) => !m.paused),
                      true,
                    )
                  }
                >
                  <Ico name="pause" className="size-3.5" />
                  Pause
                </Button>
              ) : null}
              {anyPaused ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void pause(
                      picked.filter((m) => m.paused),
                      false,
                    )
                  }
                >
                  <Ico name="play" className="size-3.5" />
                  Resume
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act("Removed from the bucket", removeFromBucketAction({ clientIds: ids }))
                }
              >
                Remove
              </Button>
            </div>
            <Button
              size="sm"
              className="order-2 ml-auto sm:order-none sm:ml-0"
              variant={ready ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => void handOff(picked)}
            >
              <Glyph name="flag" className="size-3.5" />
              Hand off {ids.length}
            </Button>
          </div>
        </div>
      ) : null}

      <MemberDrawer
        member={opened}
        meta={opened ? meta[opened.client_id] : undefined}
        bucket={bucket}
        buckets={buckets}
        steps={steps}
        busy={busy}
        actions={actions}
        onClose={() => setOpenId(null)}
      />

      {blastTemplate && blastFirst && blastPreview ? (
        <FormDialog
          title={`Blast "${blastTemplate.name}" to ${ids.length} merchant${ids.length === 1 ? "" : "s"}`}
          onClose={() => setConfirmBlast(false)}
          onSubmit={() => void blast()}
          busy={busy}
          submitLabel={`Send to ${ids.length}`}
          wide
        >
          <p className="text-sm text-muted">
            Each one goes out in the merchant&apos;s local window, under the daily cap. Links fill
            in when it sends. This is how it reads for {blastFirst.business_name}:
          </p>
          <div className="rounded-2xl border border-border bg-surface-2 p-4 text-sm">
            <p className="font-semibold">{blastPreview.subject.text || "(no subject)"}</p>
            <p className="mt-2 whitespace-pre-wrap">{blastPreview.body.text}</p>
          </div>
          {blastBlank.length > 0 ? (
            <p className="text-sm text-warn">
              Blank for this merchant: {blastBlank.join(", ")}. A merchant with a blank field is
              skipped and paused, never sent half-filled.
            </p>
          ) : null}
        </FormDialog>
      ) : null}
    </div>
  );
}

function matches(m: BucketMember, filter: Filter, today: ISODate, nowMs: number): boolean {
  switch (filter) {
    case "due":
      return !m.paused && m.next_due_on !== null && m.next_due_on <= today;
    case "replied":
      return m.reply_waiting;
    case "quiet":
      return !m.last_touch_at || nowMs - new Date(m.last_touch_at).getTime() > 7 * 86400e3;
    case "no_email":
      return noUsableEmail(m);
    case "paused":
      return m.paused;
    default:
      return true;
  }
}
