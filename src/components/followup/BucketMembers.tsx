"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  blastAction,
  moveToBucketAction,
  pauseEnrollmentAction,
  removeFromBucketAction,
} from "@/app/buckets-actions";
import { useApp } from "@/components/app-context";
import { UploadLinkButton } from "@/components/deals/UploadLinkButton";
import { useRun } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Button, Card, EmptyState, Select, cn } from "@/components/ui";
import type { BucketMember, BucketRow, TemplateRow } from "@/lib/buckets/queries";
import { formatDate, timeAgo } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";

type Filter = "all" | "due" | "replied" | "quiet" | "no_email" | "paused";

/** The lead lines of one bucket: check, blast, move, pause, remove — and the row's own popup. */
export function BucketMembers({
  bucket,
  members,
  buckets,
  templates,
}: {
  bucket: BucketRow;
  members: BucketMember[];
  buckets: BucketRow[];
  templates: TemplateRow[];
}) {
  const { today, nowMs } = useApp();
  const router = useRouter();
  const run = useRun();
  const toast = useToast();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [tz, setTz] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const zones = useMemo(() => [...new Set(members.map((m) => m.tz_label))].sort(), [members]);
  const shown = useMemo(
    () =>
      members.filter((m) => {
        if (tz && m.tz_label !== tz) return false;
        switch (filter) {
          case "due":
            return !m.paused && m.next_due_on !== null && m.next_due_on <= today;
          case "replied":
            return m.reply_waiting;
          case "quiet":
            return (
              !m.last_touch_at || Date.now() - new Date(m.last_touch_at).getTime() > 7 * 86400e3
            );
          case "no_email":
            return !m.email || m.email_opt_out || m.email_bounced;
          case "paused":
            return m.paused;
          default:
            return true;
        }
      }),
    [members, filter, tz, today],
  );
  const ids = [...checked].filter((id) => shown.some((m) => m.client_id === id));
  const allShown = shown.length > 0 && shown.every((m) => checked.has(m.client_id));

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

  async function act(
    label: string,
    p: Promise<Parameters<typeof run>[0] extends Promise<infer R> ? R : never>,
  ) {
    setBusy(true);
    const ok = await run(p, label);
    setBusy(false);
    if (ok) {
      setChecked(new Set());
      router.refresh();
    }
  }

  async function blast() {
    if (!templateId || ids.length === 0) return;
    const t = templates.find((x) => x.id === templateId);
    if (
      !window.confirm(
        `Send “${t?.name}” to ${ids.length} merchant${ids.length === 1 ? "" : "s"}? It goes out in each merchant's local window, under the daily cap.`,
      )
    )
      return;
    setBusy(true);
    const r = await blastAction({ templateId, clientIds: ids });
    setBusy(false);
    if (!r.ok) return toast({ message: r.error, tone: "error" });
    toast({
      message: `${r.data.queued} queued${r.data.skipped.length ? `, ${r.data.skipped.length} skipped (${r.data.skipped[0]?.reason})` : ""}`,
      tone: "success",
    });
    setChecked(new Set());
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={allShown}
            onChange={toggleAll}
            aria-label="Check every row shown"
          />
          {ids.length ? `${ids.length} checked` : "Check all"}
        </label>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="h-9 text-sm"
        >
          <option value="all">Everyone ({members.length})</option>
          <option value="due">Step due today</option>
          <option value="replied">Replied, unanswered</option>
          <option value="quiet">No touch in 7 days</option>
          <option value="no_email">No usable email</option>
          <option value="paused">Paused</option>
        </Select>
        {zones.length > 1 ? (
          <Select value={tz} onChange={(e) => setTz(e.target.value)} className="h-9 text-sm">
            <option value="">Every time zone</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        ) : null}
        <span className="flex-1" />
        <Select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="h-9 text-sm"
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
          variant="primary"
          size="sm"
          disabled={busy || !templateId || ids.length === 0}
          onClick={blast}
        >
          Blast {ids.length || ""}
        </Button>
        <Select
          value={moveTo}
          onChange={(e) => setMoveTo(e.target.value)}
          className="h-9 text-sm"
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
          disabled={busy || !moveTo || ids.length === 0}
          onClick={() => act("Moved", moveToBucketAction({ clientIds: ids, bucketId: moveTo }))}
        >
          Move
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || ids.length === 0}
          onClick={() => act("Removed from the bucket", removeFromBucketAction({ clientIds: ids }))}
        >
          Remove
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={members.length === 0 ? "Nobody in this bucket" : "Nobody matches that filter"}
        >
          {members.length === 0
            ? "Leads land here from intake, the sheets and the stips rules."
            : ""}
        </EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {shown.map((m) => (
              <li
                key={m.enrollment_id}
                className={cn("px-3 py-2.5", checked.has(m.client_id) && "bg-accent-soft/40")}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked.has(m.client_id)}
                    onChange={() => toggle(m.client_id)}
                    aria-label={`Check ${m.business_name}`}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpen(open === m.client_id ? null : m.client_id)}
                  >
                    <span className="block truncate text-sm">
                      <span className="font-semibold">{m.business_name}</span>
                      <span className="text-muted">
                        {" · "}
                        {m.contact_name || "—"} · {m.phone || "no phone"} · {m.email || "no email"}
                        {m.state ? ` · ${m.state}` : ""} ·{" "}
                        <span title={m.timezone}>{m.tz_label}</span>
                        {m.wanted_amount_cents
                          ? ` · wants ${formatMoneyCompact(m.wanted_amount_cents)}`
                          : ""}
                      </span>
                    </span>
                    <span className="block text-xs text-muted">
                      {m.paused ? <span className="text-warn">Paused · </span> : null}
                      {m.reply_waiting ? (
                        <span className="text-bad">Replied — answer them · </span>
                      ) : null}
                      {m.email_opt_out ? (
                        <span className="text-bad">Opted out · </span>
                      ) : m.email_bounced ? (
                        <span className="text-bad">Email bounced · </span>
                      ) : null}
                      Step {m.next_step}
                      {m.next_due_on ? ` due ${formatDate(m.next_due_on, today)}` : ""} ·{" "}
                      {m.steps_sent} sent
                      {m.stips_missing
                        ? ` · ${m.stips_missing} stip${m.stips_missing === 1 ? "" : "s"} missing`
                        : ""}
                      {" · "}
                      {m.last_touch_at
                        ? `touched ${timeAgo(m.last_touch_at, new Date(nowMs))}`
                        : "never touched"}
                      {" · "}in bucket {timeAgo(m.entered_at, new Date(nowMs))}
                    </span>
                  </button>
                </div>
                {open === m.client_id ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
                    <Link
                      href={`/clients/${m.client_id}`}
                      className="inline-flex h-8 items-center rounded-lg bg-accent px-2.5 text-sm font-semibold text-accent-fg"
                    >
                      Open
                    </Link>
                    {m.phone ? (
                      <a
                        href={`tel:${m.phone}`}
                        className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-sm font-semibold"
                      >
                        Call
                      </a>
                    ) : null}
                    <UploadLinkButton clientId={m.client_id} />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          m.paused ? "Resumed" : "Paused",
                          pauseEnrollmentAction({ clientIds: [m.client_id], paused: !m.paused }),
                        )
                      }
                    >
                      {m.paused ? "Resume" : "Pause"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        act("Removed", removeFromBucketAction({ clientIds: [m.client_id] }))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
