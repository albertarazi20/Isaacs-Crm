"use client";

import Link from "next/link";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { importClientsAction } from "@/app/actions";
import type { ImportResult } from "@/lib/data/import";
import { chunk, emptyImportResult, IMPORT_BATCH, mergeImportResults } from "@/lib/import/batches";
import { parseCsv } from "@/lib/import/csv";
import {
  buildRows,
  FIELD_LABELS,
  guessMapping,
  IMPORT_FIELDS,
  type ImportField,
} from "@/lib/import/map";
import { foldStage, stageDef } from "@/lib/mca/stages";
import { formatDate } from "@/lib/format";
import { useApp } from "./app-context";
import { useCall, useToast } from "./overlay";
import { Glyph } from "./shell/icons";
import {
  Button,
  buttonClass,
  Card,
  cn,
  Field,
  Input,
  Meter,
  Select,
  Textarea,
  TONE_TEXT,
  type Tone,
} from "./ui";

const TH = "eyebrow px-3 py-2.5 text-left first:pl-4 last:pr-4";
const TD = "px-3 py-2.5 first:pl-4 last:pr-4";

const STEPS = [
  { n: 1, label: "Upload", hint: "Choose your spreadsheet" },
  { n: 2, label: "Match columns", hint: "Check what goes where" },
  { n: 3, label: "Review and import", hint: "Look before it lands" },
] as const;
type Step = 1 | 2 | 3 | 4;

/** The numbered steps across the top. A finished step is a check you can press to go back to it. */
function Stepper({
  step,
  reach,
  onGo,
}: {
  step: Step;
  /** The furthest step the file allows right now. */
  reach: Step;
  onGo: (s: Step) => void;
}) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label="Import steps">
      {STEPS.map((s, i) => {
        const done = step > s.n;
        const current = step === s.n;
        const canGo = step !== 4 && s.n <= reach && !current;
        return (
          <li key={s.n} className={cn("flex items-center gap-2 sm:gap-3", i > 0 && "flex-1")}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-3 flex-1",
                  done || current ? "bg-accent/50" : "bg-border",
                )}
              />
            ) : null}
            <button
              type="button"
              disabled={!canGo}
              aria-current={current ? "step" : undefined}
              onClick={() => onGo(s.n)}
              className="group flex items-center gap-2.5 rounded-full text-left transition duration-150 enabled:active:scale-[0.97] disabled:cursor-default"
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums transition duration-200",
                  current
                    ? "bg-brand text-white shadow-glow"
                    : done
                      ? "bg-accent-soft text-accent ring-1 ring-accent/30 ring-inset"
                      : "bg-surface-2 text-muted ring-1 ring-border ring-inset",
                )}
              >
                {done ? <Glyph name="check" className="size-4" strokeWidth={2.4} /> : s.n}
              </span>
              <span className={cn("min-w-0", !current && "max-sm:hidden")}>
                <span
                  className={cn(
                    "block text-[13px] leading-tight font-semibold whitespace-nowrap",
                    current ? "text-text" : "text-text-2 group-enabled:group-hover:text-text",
                  )}
                >
                  {s.label}
                </span>
                <span className="block text-xs leading-tight whitespace-nowrap text-muted max-lg:hidden">
                  {s.hint}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-[-0.02em]">{children}</h2>
      {hint ? <p className="mt-1 max-w-2xl text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

/** One number in a summary row. */
function Figure({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <p className="eyebrow truncate">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-[26px] leading-none font-semibold tracking-[-0.03em] tabular-nums",
          value > 0 ? TONE_TEXT[tone] : "text-muted",
          value > 0 && tone === "neutral" && "text-text",
        )}
      >
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}

const SAMPLE =
  "Business,Owner,Phone,Amount,Status,Follow up,Notes\nMike's Pizza,Mike Ross,(305) 555-0101,50k,Interested,,Wants it for payroll";

export function ImportWizard() {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<ImportField, number | null> | null>(null);
  const [spreadDays, setSpreadDays] = useState(10);
  const [defaultSource, setDefaultSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [at, setAt] = useState<Step>(1);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{
    r: ImportResult;
    stoppedAt: number | null;
    all: number;
  } | null>(null);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      const all = parseCsv(text);
      const [header, ...records] = all;
      return header ? { header, records, error: null } : null;
    } catch (e) {
      return {
        header: [] as string[],
        records: [] as string[][],
        error: e instanceof Error ? e.message : "Couldn't read that file",
      };
    }
  }, [text]);

  const effective = useMemo(
    () => mapping ?? (parsed ? guessMapping(parsed.header) : null),
    [mapping, parsed],
  );
  const built = useMemo(
    () =>
      parsed && effective && !parsed.error
        ? buildRows(parsed.records, effective, { today, spreadDays, defaultSource })
        : null,
    [parsed, effective, today, spreadDays, defaultSource],
  );

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    if (file.size > 5_000_000)
      return setFileError("That file is over 5 MB. Split it into smaller files.");
    setMapping(null);
    setFileName(file.name);
    const body = await file.text();
    setText(body);
    // a readable file goes straight to the column check
    if (body.trim()) setAt(2);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files[0]);
  }

  function startOver() {
    setText("");
    setFileName(null);
    setFileError(null);
    setMapping(null);
    setResult(null);
    setAt(1);
  }

  async function submit() {
    if (!built || built.rows.length === 0) return;
    setBusy(true);
    const all = built.rows.length;
    let r = emptyImportResult();
    let stoppedAt: number | null = null;
    for (const [i, slice] of chunk(built.rows, IMPORT_BATCH).entries()) {
      setProgress({ done: i * IMPORT_BATCH, total: all });
      const got = await call(importClientsAction({ rows: slice }));
      if (!got) {
        stoppedAt = i * IMPORT_BATCH;
        break;
      }
      r = mergeImportResults(r, got);
    }
    setProgress(null);
    setBusy(false);
    const parts = [`Imported ${r.created} client${r.created === 1 ? "" : "s"}`];
    if (r.skippedExisting) parts.push(`${r.skippedExisting} already in your CRM`);
    if (r.skippedDoNotContact)
      parts.push(`${r.skippedDoNotContact} match a do-not-contact merchant and were not added`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    if (stoppedAt !== null)
      parts.push(
        `stopped after ${stoppedAt} of ${all} rows. Choose the same file again to finish; rows already added are skipped`,
      );
    toast({
      message: parts.join(" · "),
      tone: r.failed.length || stoppedAt !== null ? "error" : "success",
    });
    setResult({ r, stoppedAt, all });
    setAt(4);
  }

  const ready = Boolean(parsed && !parsed.error && effective);
  // the furthest step the file allows; the step shown never runs ahead of it
  const reach: Step = ready ? (built ? 3 : 2) : 1;
  const step: Step = at === 4 && result ? 4 : at > reach ? reach : at;
  const sample = parsed?.records[0] ?? [];

  return (
    <div className="space-y-4">
      <div className="glass rounded-2xl border border-border px-4 py-3 shadow-card sm:px-5">
        <Stepper step={step} reach={reach} onGo={setAt} />
      </div>

      {step === 1 ? (
        <Card className="animate-fade space-y-4 p-4 sm:p-6">
          <StepTitle
            hint={
              <>
                In Excel or Google Sheets: File, Download, CSV. Any column order works. You&apos;ll
                check the matching on the next step.
              </>
            }
          >
            Choose your spreadsheet
          </StepTitle>
          {/* The browser's own file control is unstyled; the real input hides inside the drop zone, which is its label. */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition duration-200 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent sm:py-14",
              dragging
                ? "bg-brand-soft scale-[1.01] border-accent"
                : "border-border-strong/70 bg-surface-3/40 hover:border-accent/60 hover:bg-surface-3",
            )}
          >
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="sr-only"
            />
            <span
              aria-hidden
              className="bg-brand-soft flex size-14 items-center justify-center rounded-2xl text-accent ring-1 ring-accent/25 transition duration-200 group-hover:-translate-y-0.5"
            >
              <Glyph name="upload" className="size-6" />
            </span>
            <span>
              <span className="block text-[15px] font-semibold">
                {dragging ? "Drop it to read it" : "Drop a CSV here"}
              </span>
              <span className="mt-1 block text-sm text-muted">
                or <span className="font-medium text-accent">choose a spreadsheet</span> from your
                computer. Up to 5 MB.
              </span>
            </span>
            <span
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs",
                fileName ? "bg-good-soft text-good" : "bg-surface-2 text-muted",
              )}
              aria-live="polite"
            >
              <Glyph name={fileName ? "check" : "file"} className="size-3.5 shrink-0" />
              <span className="truncate">{fileName ?? "No file chosen yet"}</span>
            </span>
          </label>
          {fileError ? (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">
              {fileError}
            </p>
          ) : null}
          <details className="group rounded-2xl border border-border bg-surface-3/40">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-[13px] font-medium text-text-2 select-none hover:text-text [&::-webkit-details-marker]:hidden">
              Or paste rows here
              <Glyph
                name="chevronDown"
                className="size-4 text-muted transition duration-150 group-open:rotate-180"
              />
            </summary>
            <div className="px-3 pb-3">
              <Textarea
                className="font-mono text-xs"
                rows={6}
                aria-label="Paste rows"
                placeholder={SAMPLE}
                value={text}
                onChange={(e) => {
                  setMapping(null);
                  setFileName(null);
                  setText(e.target.value);
                }}
              />
            </div>
          </details>
          {parsed?.error ? (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">
              {parsed.error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted tabular-nums" aria-live="polite">
              {ready && parsed
                ? `${parsed.records.length} ${parsed.records.length === 1 ? "row" : "rows"} found`
                : ""}
            </p>
            <Button variant="primary" disabled={!ready} onClick={() => setAt(2)}>
              Continue
              <Glyph name="arrowRight" className="size-4" />
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 && parsed && effective ? (
        <Card className="animate-fade space-y-5 p-4 sm:p-6">
          <StepTitle
            hint={
              <>
                {parsed.records.length} {parsed.records.length === 1 ? "row" : "rows"} found. Fix
                any column that was guessed wrong.
              </>
            }
          >
            Check the columns
          </StepTitle>
          <div className="overflow-hidden rounded-2xl border border-border">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-x-3 border-b border-border bg-surface-2/40 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
              <span className="eyebrow">In the CRM</span>
              <span className="eyebrow">Your column</span>
              <span className="eyebrow max-sm:hidden">First row</span>
            </div>
            <div className="divide-y divide-border">
              {IMPORT_FIELDS.map((f) => {
                const col = effective[f];
                const value = col === null ? "" : (sample[col] ?? "");
                return (
                  <label
                    key={f}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-x-3 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/50 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)]"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          col === null ? "bg-border-strong" : "bg-good",
                        )}
                      />
                      <span className="truncate">{FIELD_LABELS[f]}</span>
                    </span>
                    <Select
                      value={col ?? ""}
                      onChange={(e) =>
                        setMapping({
                          ...effective,
                          [f]: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">Not in this file</option>
                      {parsed.header.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `(column ${i + 1})`}
                        </option>
                      ))}
                    </Select>
                    <span className="truncate text-[13px] text-muted max-sm:hidden">
                      {value || (col === null ? "" : "Empty")}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Where is this list from?"
              hint="Applied to rows with no source column, so you can tell your lists apart later."
            >
              <Input
                placeholder="e.g. Lead vendor, Oct 2026"
                maxLength={100}
                value={defaultSource}
                onChange={(e) => setDefaultSource(e.target.value)}
              />
            </Field>
            <Field
              label="Spread rows with no follow-up date over the next"
              hint="So you start with a manageable list, not 400 calls due tomorrow."
            >
              <Select value={spreadDays} onChange={(e) => setSpreadDays(Number(e.target.value))}>
                {[5, 10, 20, 30, 60].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setAt(1)}>
              Back
            </Button>
            <Button variant="primary" disabled={!built} onClick={() => setAt(3)}>
              Review {built ? built.rows.length : 0} rows
              <Glyph name="arrowRight" className="size-4" />
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 3 && built ? (
        <Card className="animate-fade space-y-5 p-4 sm:p-6">
          <StepTitle hint="Merchants whose phone is already in your CRM are skipped automatically.">
            Review and import
          </StepTitle>
          <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4 sm:divide-y-0">
            <Figure label="Ready to import" value={built.rows.length} tone="good" />
            <Figure label="Repeated phones" value={built.duplicatesInFile} tone="warn" />
            <Figure label="Do not contact" value={built.doNotContact} tone="bad" />
            <Figure label="To look at" value={built.problems.length} tone="warn" />
          </div>
          {built.rows.length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="border-b border-border bg-surface-2/40">
                    <tr>
                      <th className={TH}>Business</th>
                      <th className={TH}>Merchant</th>
                      <th className={TH}>Phone</th>
                      <th className={cn(TH, "text-right")}>Wants</th>
                      <th className={TH}>Stage</th>
                      <th className={TH}>Follow up</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {built.rows.slice(0, 8).map((r) => (
                      <tr
                        key={r.line}
                        className="transition-colors duration-150 hover:bg-surface-2/50"
                      >
                        <td className={cn(TD, "font-medium")}>{r.businessName}</td>
                        <td className={cn(TD, "text-text-2")}>{r.contactName}</td>
                        <td className={cn(TD, "text-muted tabular-nums")}>{r.phone}</td>
                        <td className={cn(TD, "text-right text-muted tabular-nums")}>
                          {r.wantedAmount}
                        </td>
                        <td className={cn(TD, "text-text-2")}>
                          {stageDef(foldStage(r.stage)).label}
                        </td>
                        <td className={cn(TD, "tabular-nums")}>
                          {formatDate(r.followUpOn, today)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {built.rows.length > 8 ? (
                <p className="border-t border-border bg-surface-3/40 px-4 py-2 text-xs text-muted tabular-nums">
                  Showing the first 8 of {built.rows.length.toLocaleString("en-US")} rows.
                </p>
              ) : null}
            </div>
          ) : null}

          {built.problems.length > 0 ? (
            <details className="group rounded-2xl border border-warn/25 bg-warn-soft/50">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-[13px] font-semibold text-warn select-none [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2">
                  <Glyph name="alert" className="size-4" />
                  Things to look at ({built.problems.length})
                </span>
                <Glyph
                  name="chevronDown"
                  className="size-4 transition duration-150 group-open:rotate-180"
                />
              </summary>
              <ul className="max-h-48 space-y-1 overflow-y-auto px-4 pb-3 text-[13px] text-text-2">
                {built.problems.slice(0, 50).map((p, i) => (
                  <li key={i}>
                    <span className="text-muted tabular-nums">Line {p.line}:</span> {p.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {busy && progress && progress.total > IMPORT_BATCH ? (
            <Meter
              label="Rows imported"
              value={Math.min(progress.done + IMPORT_BATCH, progress.total)}
              max={progress.total}
              tone="brand"
            />
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" disabled={busy} onClick={() => setAt(2)}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={busy || built.rows.length === 0}
              onClick={() => void submit()}
            >
              {busy
                ? progress && progress.total > IMPORT_BATCH
                  ? `Importing ${Math.min(progress.done + IMPORT_BATCH, progress.total)} of ${progress.total}…`
                  : "Importing…"
                : `Import ${built.rows.length} client${built.rows.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 4 && result ? (
        <Card className="ring-brand animate-pop space-y-5 p-4 sm:p-6">
          <div className="flex items-start gap-4">
            <span
              aria-hidden
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-full",
                result.r.failed.length || result.stoppedAt !== null
                  ? "bg-warn-soft text-warn"
                  : "bg-brand text-white shadow-glow",
              )}
            >
              <Glyph
                name={result.r.failed.length || result.stoppedAt !== null ? "alert" : "check"}
                className="size-6"
                strokeWidth={2.2}
              />
            </span>
            <StepTitle
              hint={
                result.stoppedAt !== null
                  ? `It stopped after ${result.stoppedAt} of ${result.all} rows. Choose the same file again to finish; rows already added are skipped.`
                  : "Every new merchant has a follow-up date, so nobody falls through."
              }
            >
              {result.stoppedAt !== null ? "The import stopped early" : "Import finished"}
            </StepTitle>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-2xl border border-border sm:grid-cols-4 sm:divide-y-0">
            <Figure label="Imported" value={result.r.created} tone="good" />
            <Figure label="Already in your CRM" value={result.r.skippedExisting} tone="neutral" />
            <Figure label="Do not contact" value={result.r.skippedDoNotContact} tone="bad" />
            <Figure label="Failed" value={result.r.failed.length} tone="bad" />
          </div>
          {result.r.failed.length > 0 ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-2xl border border-bad/25 bg-bad-soft/50 px-4 py-3 text-[13px] text-text-2">
              {result.r.failed.slice(0, 50).map((p, i) => (
                <li key={i}>
                  <span className="text-muted tabular-nums">Line {p.line}:</span> {p.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={startOver}>
              Import another file
            </Button>
            <Link href="/clients" className={buttonClass("primary", "md")}>
              View merchants
              <Glyph name="arrowRight" className="size-4" />
            </Link>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
