"use client";

import Link from "next/link";
import { AskButton, merchantBrief } from "@/components/assistant/AskButton";
import { useState, type ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { copyText } from "@/components/client/parts";
import { Drawer } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Button, IconButton, Input, ProgressRing, Select, buttonClass, cn } from "@/components/ui";
import type { BucketMember, BucketRow } from "@/lib/buckets/queries";
import type { SequenceStep } from "@/lib/followup/bucketBoard";
import { formatDate, timeAgo } from "@/lib/format";
import { addDays, type ISODate } from "@/lib/mca/dates";
import type { MemberMeta } from "@/lib/messaging/memberMeta";
import { formatMoneyCompact } from "@/lib/money";
import { memberMergeValues, stepNote, stepTitle } from "./bucketCopy";
import { Ico, MemberChips, NEXT_TONE, copyUploadLink, nextUp } from "./memberParts";

export interface MemberActions {
  onHandOff: (m: BucketMember) => void;
  onPause: (m: BucketMember, paused: boolean, until?: ISODate) => void;
  onMove: (m: BucketMember, bucketId: string) => void;
  onRemove: (m: BucketMember) => void;
}

/** A value that copies itself: the tick shows right where it was pressed, because a toast would sit under the sheet. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : label}
      className={cn("-my-1.5", done && "text-good hover:text-good")}
      onClick={async () => {
        if (!(await copyText(value))) return;
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Glyph name="check" className="size-4" /> : <Ico name="copy" />}
    </IconButton>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-2">
      <dt className="shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-right text-[13px] font-medium text-text">
        {children}
      </dd>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {aside ? <span className="text-xs text-muted">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Body({
  m,
  meta,
  bucket,
  buckets,
  steps,
  busy,
  actions,
}: {
  m: BucketMember;
  meta: MemberMeta | undefined;
  bucket: BucketRow;
  buckets: BucketRow[];
  steps: readonly SequenceStep[];
  busy: boolean;
  actions: MemberActions;
}) {
  const { today, nowMs } = useApp();
  const [until, setUntil] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [link, setLink] = useState<"idle" | "busy" | "copied" | string>("idle");
  const next = nextUp(m, steps, today);
  const values = memberMergeValues(m);
  const done = Math.min(steps.length, Math.max(0, m.next_step - 1));

  return (
    <div className="space-y-7">
      <MemberChips m={m} meta={meta} today={today} />

      <div className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4">
        <ProgressRing value={steps.length ? done / steps.length : 0} size={52} stroke={5}>
          {done}/{steps.length}
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Next up · {next.step}</p>
          <p className="mt-1 truncate text-sm font-semibold">{next.title}</p>
          <p className={cn("mt-0.5 text-xs font-medium", NEXT_TONE[next.tone])}>
            {next.when}
            {next.date && !m.paused ? <span className="text-muted"> · {next.date}</span> : null}
            <span className="text-muted"> · {m.steps_sent} sent so far</span>
          </p>
        </div>
      </div>

      <Section title="Contact">
        <dl className="divide-y divide-border rounded-2xl border border-border bg-surface px-4">
          <Row label="Contact">{m.contact_name || "No name yet"}</Row>
          <Row label="Email">
            {m.email ? (
              <>
                <span className="truncate">{m.email}</span>
                <CopyValue value={m.email} label="Copy email" />
              </>
            ) : (
              <span className="text-muted">No email</span>
            )}
          </Row>
          <Row label="Phone">
            {m.phone ? (
              <>
                <a href={`tel:${m.phone}`} className="truncate tabular-nums hover:text-accent">
                  {m.phone}
                </a>
                <CopyValue value={m.phone} label="Copy phone" />
              </>
            ) : (
              <span className="text-muted">No phone</span>
            )}
          </Row>
          <Row label="Where">
            <span title={m.timezone}>
              {[m.state, m.tz_label].filter(Boolean).join(" · ") || "Unknown"}
            </span>
          </Row>
          {m.wanted_amount_cents ? (
            <Row label="Asked for">{formatMoneyCompact(m.wanted_amount_cents)}</Row>
          ) : null}
          <Row label="Rep">{m.rep_name}</Row>
          <Row label="Last touch">
            {m.last_touch_at ? timeAgo(m.last_touch_at, new Date(nowMs)) : "Never touched"}
          </Row>
          <Row label={`In ${bucket.name}`}>since {timeAgo(m.entered_at, new Date(nowMs))}</Row>
        </dl>
      </Section>

      {meta?.quote ? (
        <Section title="Their last reply">
          <blockquote className="rounded-2xl border border-border bg-surface px-4 py-3 text-[13px] leading-relaxed text-text-2">
            &ldquo;{meta.quote}&rdquo;
            {meta.supported ? null : (
              <span className="mt-1 block text-xs text-warn">The words could not be checked.</span>
            )}
          </blockquote>
        </Section>
      ) : null}

      <Section
        title="What was sent, what is next"
        aside={steps.length ? `${done} of ${steps.length} done` : undefined}
      >
        {steps.length === 0 ? (
          <p className="text-[13px] text-muted">
            This bucket has no sequence, so nothing goes out on its own.
          </p>
        ) : (
          <ol className="space-y-0">
            {steps.map((s, i) => {
              const state =
                s.step_no < m.next_step ? "done" : s.step_no === m.next_step ? "next" : "later";
              return (
                <li key={s.step_no} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < steps.length - 1 ? (
                    <span
                      aria-hidden
                      className="absolute top-6 bottom-0 left-[11px] w-px bg-border"
                    />
                  ) : null}
                  <span
                    className={cn(
                      "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ring-1",
                      state === "done" && "bg-good-soft text-good ring-good/25",
                      state === "next" && "bg-accent-soft text-accent ring-accent/40",
                      state === "later" && "bg-surface-2 text-muted ring-border",
                    )}
                  >
                    {state === "done" ? (
                      <Glyph name="check" className="size-3.5" strokeWidth={2.4} />
                    ) : (
                      s.step_no
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-[13px] font-medium",
                        state === "later" ? "text-text-2" : "text-text",
                      )}
                    >
                      {stepTitle(s, values)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      Day {s.day_offset} · {stepNote(s)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium",
                      state === "done"
                        ? "text-good"
                        : state === "next"
                          ? NEXT_TONE[next.tone]
                          : "text-muted",
                    )}
                  >
                    {state === "done" ? "Done" : state === "next" ? next.when : "Later"}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section title="Quick actions">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={link === "busy"}
              onClick={async () => {
                setLink("busy");
                const r = await copyUploadLink(m.client_id);
                setLink(r.ok ? (r.copied ? "copied" : r.url) : r.error);
                if (r.ok && r.copied) setTimeout(() => setLink("idle"), 2400);
              }}
            >
              <Glyph name={link === "copied" ? "check" : "link"} className="size-3.5 text-muted" />
              {link === "busy"
                ? "Making the link…"
                : link === "copied"
                  ? "Copied, good for 2 hours"
                  : "Copy upload link"}
            </Button>
            {m.phone ? (
              <a href={`tel:${m.phone}`} className={buttonClass("secondary", "sm")}>
                <Glyph name="phone" className="size-3.5 text-muted" />
                Call
              </a>
            ) : null}
            <Button size="sm" disabled={busy} onClick={() => actions.onPause(m, !m.paused)}>
              <Ico name={m.paused ? "play" : "pause"} className="size-3.5 text-muted" />
              {m.paused ? "Resume" : "Pause"}
            </Button>
          </div>
          {link !== "idle" && link !== "busy" && link !== "copied" ? (
            <p role="status" className="text-xs wrap-anywhere text-text-2">
              {link}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              type="date"
              aria-label="Pause until date"
              min={addDays(today, 1)}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="min-w-0 flex-1 sm:h-8 sm:text-[13px]"
            />
            <Button
              size="sm"
              disabled={busy || until === ""}
              onClick={() => actions.onPause(m, true, until)}
            >
              Pause until
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              aria-label="Move to another bucket"
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="min-w-0 flex-1 sm:h-8 sm:text-[13px]"
            >
              <option value="">Move to another bucket…</option>
              {buckets
                .filter((b) => b.id !== bucket.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
            <Button size="sm" disabled={busy || !moveTo} onClick={() => actions.onMove(m, moveTo)}>
              Move
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-bad hover:text-bad"
            disabled={busy}
            onClick={() => actions.onRemove(m)}
          >
            <Glyph name="x" className="size-3.5" />
            Remove from this bucket
          </Button>
          <p className="text-xs text-muted">
            A pause with a date lifts by itself that day.{" "}
            {until ? `Picked: ${formatDate(until, today)}.` : ""}
          </p>
        </div>
      </Section>
    </div>
  );
}

/** One merchant, opened over the bucket: the essentials and every action, without leaving the list. */
export function MemberDrawer({
  member,
  meta,
  bucket,
  buckets,
  steps,
  busy,
  actions,
  onClose,
}: {
  member: BucketMember | null;
  meta: MemberMeta | undefined;
  bucket: BucketRow;
  buckets: BucketRow[];
  steps: readonly SequenceStep[];
  busy: boolean;
  actions: MemberActions;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={member !== null}
      onClose={onClose}
      eyebrow={bucket.name}
      title={member?.business_name ?? "Merchant"}
      subtitle={member ? member.contact_name || member.email || "No contact name yet" : undefined}
      footer={
        member ? (
          <>
            <Link
              href={`/clients/${member.client_id}`}
              className={buttonClass("secondary", "md", "mr-auto")}
            >
              Open merchant
              <Glyph name="arrowUpRight" className="size-4 text-muted" />
            </Link>
            <AskButton
              text="Next step"
              label={`Next step for ${member.business_name}`}
              prompt={merchantBrief(member.business_name, member.client_id)}
            />
            <Button variant="primary" disabled={busy} onClick={() => actions.onHandOff(member)}>
              <Glyph name="flag" className="size-4" />
              Hand off
            </Button>
          </>
        ) : undefined
      }
    >
      {member ? (
        <Body
          key={member.client_id}
          m={member}
          meta={meta}
          bucket={bucket}
          buckets={buckets}
          steps={steps}
          busy={busy}
          actions={actions}
        />
      ) : null}
    </Drawer>
  );
}
