"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { importClientsAction } from "@/app/actions";
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
import { Icon } from "./client/icons";
import { useCall, useToast } from "./overlay";
import { Badge, Button, buttonClass, Card, cn, Field, Input, Select, Textarea } from "./ui";

const TH = "px-3 py-2 font-semibold";
const TD = "px-3 py-2";

function StepTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
      {hint ? <p className="mt-0.5 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

const SAMPLE =
  "Business,Owner,Phone,Amount,Status,Follow up,Notes\nMike's Pizza,Mike Ross,(305) 555-0101,50k,Interested,,Wants it for payroll";

export function ImportWizard() {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<ImportField, number | null> | null>(null);
  const [spreadDays, setSpreadDays] = useState(10);
  const [defaultSource, setDefaultSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

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
      return setFileError("That file is over 5 MB — split it into smaller files.");
    setMapping(null);
    setFileName(file.name);
    setText(await file.text());
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
      parts.push(`${r.skippedDoNotContact} match a do-not-contact merchant — not added`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    if (stoppedAt !== null)
      parts.push(
        `stopped after ${stoppedAt} of ${all} rows — choose the same file again to finish; rows already added are skipped`,
      );
    toast({
      message: parts.join(" · "),
      tone: r.failed.length || stoppedAt !== null ? "error" : "success",
    });
    if (r.failed.length === 0 && stoppedAt === null) router.push("/clients");
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 sm:p-5">
        <StepTitle
          hint={
            <>
              In Excel or Google Sheets: File → Download → CSV. Any column order works — you&apos;ll
              check the matching below.
            </>
          }
        >
          1. Choose your spreadsheet
        </StepTitle>
        {/* The browser's own file control is unstyled; the real input hides inside a button-looking label. */}
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={cn(
              buttonClass("secondary", "md"),
              "cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent",
            )}
          >
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="sr-only"
            />
            <Icon name="file" className="text-muted" /> Choose a spreadsheet
          </label>
          <span className="min-w-0 truncate text-sm text-muted" aria-live="polite">
            {fileName ?? "No file chosen yet"}
          </span>
        </div>
        {fileError ? (
          <p role="alert" className="text-sm text-bad">
            {fileError}
          </p>
        ) : null}
        <details>
          <summary className="flex min-h-10 cursor-pointer items-center text-sm text-muted select-none hover:text-text sm:min-h-8">
            …or paste rows here
          </summary>
          <Textarea
            className="mt-2 font-mono text-xs"
            rows={6}
            placeholder={SAMPLE}
            value={text}
            onChange={(e) => {
              setMapping(null);
              setFileName(null);
              setText(e.target.value);
            }}
          />
        </details>
        {parsed?.error ? (
          <p role="alert" className="text-sm text-bad">
            {parsed.error}
          </p>
        ) : null}
      </Card>

      {parsed && !parsed.error && effective ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <StepTitle
            hint={
              <>
                {parsed.records.length} {parsed.records.length === 1 ? "row" : "rows"} found. Fix
                any column that was guessed wrong.
              </>
            }
          >
            2. Check the columns
          </StepTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {IMPORT_FIELDS.map((f) => (
              <Field key={f} label={FIELD_LABELS[f]}>
                <Select
                  value={effective[f] ?? ""}
                  onChange={(e) =>
                    setMapping({
                      ...effective,
                      [f]: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">— none —</option>
                  {parsed.header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `(column ${i + 1})`}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <Field
            label="Where is this list from?"
            hint="Applied to rows with no source column. Reports use it to show which lead sources pay."
          >
            <Input
              className="sm:max-w-sm"
              placeholder="e.g. Lead vendor, Oct 2026"
              maxLength={100}
              value={defaultSource}
              onChange={(e) => setDefaultSource(e.target.value)}
            />
          </Field>
          <Field
            label="Rows with no follow-up date get one spread over the next…"
            hint="So you start with a manageable list, not 400 calls due tomorrow."
          >
            <Select
              className="sm:w-48"
              value={spreadDays}
              onChange={(e) => setSpreadDays(Number(e.target.value))}
            >
              {[5, 10, 20, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Field>
        </Card>
      ) : null}

      {built ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <StepTitle>3. Review and import</StepTitle>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={built.rows.length > 0 ? "good" : "bad"}>
              {built.rows.length} ready to import
            </Badge>
            {built.duplicatesInFile > 0 ? (
              <Badge tone="warn">{built.duplicatesInFile} repeated phone numbers skipped</Badge>
            ) : null}
            {built.doNotContact > 0 ? (
              <Badge tone="bad">{built.doNotContact} marked do-not-contact — not imported</Badge>
            ) : null}
            {built.problems.length > 0 ? (
              <Badge tone="warn">{built.problems.length} to look at</Badge>
            ) : null}
            <span className="text-xs text-muted">
              Clients whose phone is already in your CRM are skipped automatically.
            </span>
          </div>

          {built.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead className="bg-surface-2/60 text-[11px] font-semibold tracking-wide text-muted uppercase">
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
                    <tr key={r.line} className="transition hover:bg-surface-3">
                      <td className={cn(TD, "font-medium")}>{r.businessName}</td>
                      <td className={cn(TD, "text-muted")}>{r.contactName}</td>
                      <td className={cn(TD, "text-muted tabular-nums")}>{r.phone}</td>
                      <td className={cn(TD, "text-right text-muted tabular-nums")}>
                        {r.wantedAmount}
                      </td>
                      <td className={TD}>{stageDef(foldStage(r.stage)).label}</td>
                      <td className={cn(TD, "tabular-nums")}>{formatDate(r.followUpOn, today)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {built.problems.length > 0 ? (
            <details>
              <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium text-warn select-none sm:min-h-8">
                Things to look at ({built.problems.length})
              </summary>
              <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm text-muted">
                {built.problems.slice(0, 50).map((p, i) => (
                  <li key={i}>
                    Line {p.line}: {p.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="flex justify-end">
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
    </div>
  );
}
