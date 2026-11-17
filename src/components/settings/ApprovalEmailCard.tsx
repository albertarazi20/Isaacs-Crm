"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type DragEvent } from "react";
import { clearApprovalDesignAction, saveApprovalDesignAction } from "@/app/approval-actions";
import {
  APPROVAL_FIELD_HELP,
  APPROVAL_FIELDS,
  checkDesign,
  subjectFromHtml,
  type ApprovalField,
} from "@/lib/approvals/html";
import { Dialog, useCall, useToast } from "../overlay";
import { Button, cn, Field, Input, Textarea } from "../ui";
import {
  byteSize,
  emailName,
  emailTitle,
  formatHours,
  formatKb,
  hasDesign,
  isHtmlFile,
  type ApprovalEmailView,
} from "./approvalCadence";
import { ApprovalPreview } from "./ApprovalPreview";
import { ICON, Icon, SettingsCard, StatusChip } from "./primitives";

/** The schema takes up to 400,000 characters; the check itself refuses a design past 200 KB with its reason. */
const MAX_FILE_BYTES = 400_000;

interface Draft {
  html: string;
  fileName: string;
  from: "file" | "paste";
}

/** Which fields the design uses (a tick) and which it could (plain), each with what it fills in as hover text. */
function FieldChips({ used }: { used: readonly ApprovalField[] }) {
  return (
    <ul aria-label="Fields" className="flex flex-wrap gap-1.5">
      {APPROVAL_FIELDS.map((f) => {
        const on = used.includes(f);
        return (
          <li
            key={f}
            title={APPROVAL_FIELD_HELP[f]}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full px-2 font-mono text-[11px] ring-1 ring-inset",
              on
                ? "bg-accent-soft text-accent ring-accent/25"
                : "bg-surface-2 text-muted ring-border",
            )}
          >
            {on ? <Icon d={ICON.check} className="size-3" /> : null}
            {f}
            <span className="sr-only">
              {on ? ", used" : ", not used"}: {APPROVAL_FIELD_HELP[f]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A check's findings: what blocks the save (red) and what to know before it goes out (amber). */
function Findings({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {errors.length > 0 ? (
        <div className="rounded-xl border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-bad">
          <p className="flex items-center gap-1.5 font-semibold">
            <Icon d={ICON.alert} className="size-3.5" />
            {errors.length === 1
              ? "Fix this before saving"
              : `Fix these ${errors.length} before saving`}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn">
          <p className="font-semibold">Good to know</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One email of the sequence: its subject, its design (a dropped or chosen .html file, or pasted HTML), the live check
 * that runs before anything is saved, and the preview. The saved design is kept here after a save, so the card never
 * flashes back to the old one while the page refreshes.
 */
export function ApprovalEmailCard({ email }: { email: ApprovalEmailView }) {
  const call = useCall();
  const toast = useToast();
  const router = useRouter();
  const pasteId = useId();
  const dropHintId = useId();
  const step = email.step;
  const name = emailName(step);

  const [base, setBase] = useState(() => ({
    html: email.html,
    subject: email.subject,
    fileName: email.fileName,
  }));
  const [subject, setSubject] = useState(email.subject);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [paste, setPaste] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [savedWarnings, setSavedWarnings] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const html = draft?.html ?? base.html;
  const fileName = draft ? draft.fileName : base.fileName;
  const hasHtml = html.trim() !== "";
  const titleSubject = useMemo(() => subjectFromHtml(html), [html]);
  // the server's rule: an empty subject box takes the design's <title>
  const effectiveSubject = subject.trim() || titleSubject;
  const check = useMemo(
    () => (hasHtml ? checkDesign(html, effectiveSubject) : null),
    [hasHtml, html, effectiveSubject],
  );
  const ready = hasDesign(base);
  const dirty = draft !== null || subject.trim() !== base.subject.trim();
  const blocked = check !== null && check.errors.length > 0;
  const canSave = hasHtml && dirty && !blocked && busy === null;
  const size = hasHtml ? byteSize(html) : 0;
  // what the save said that the live check does not already show (scripts taken out, say)
  const savedNotes = savedWarnings.filter((w) => !check?.warnings.includes(w));

  function startDraft(next: Draft) {
    setDraft(next);
    setSavedWarnings([]);
    setFileError(null);
    // a new design with no subject typed: start from the design's own <title>
    if (subject.trim() === "") {
      const t = subjectFromHtml(next.html);
      if (t) setSubject(t);
    }
  }

  async function takeFile(file: File | undefined) {
    if (!file) return;
    if (!isHtmlFile(file.name, file.type)) {
      setFileError(
        `${file.name} is not an .html file. Save the email from your design tool as HTML and choose that file.`,
      );
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError(`${file.name} is ${formatKb(file.size)}. Keep a design under 200 KB.`);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileError(`${file.name} could not be read. Try choosing it again.`);
      return;
    }
    setPaste("");
    startDraft({ html: text, fileName: file.name, from: "file" });
  }

  function onPaste(value: string) {
    setPaste(value);
    if (value.trim() === "") {
      if (draft?.from === "paste") setDraft(null);
      return;
    }
    startDraft({ html: value, fileName: "", from: "paste" });
  }

  function discard() {
    setDraft(null);
    setPaste("");
    setFileError(null);
    setSubject(base.subject);
  }

  async function save() {
    if (!canSave || !check) return;
    setBusy("save");
    const res = await call(
      saveApprovalDesignAction({ step, subject: subject.trim(), html, fileName }),
    );
    setBusy(null);
    if (!res) return;
    setBase({ html: check.html, subject: res.subject, fileName });
    setSubject(res.subject);
    setDraft(null);
    setPaste("");
    setSavedWarnings(res.warnings);
    toast({ message: `${name} saved`, tone: "success" });
    router.refresh();
  }

  async function clear() {
    setBusy("clear");
    const ok = await call(
      clearApprovalDesignAction({ step }).then((r) =>
        r.ok ? { ok: true as const, data: true } : r,
      ),
    );
    setBusy(null);
    setConfirmClear(false);
    if (!ok) return;
    setBase({ html: "", subject: "", fileName: "" });
    setSubject("");
    setDraft(null);
    setPaste("");
    setSavedWarnings([]);
    toast({ message: `${name}: design removed`, tone: "success" });
    router.refresh();
  }

  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    void takeFile(e.dataTransfer.files[0]);
  };

  return (
    <SettingsCard
      id={`approval-email-${step}`}
      title={emailTitle(step)}
      description={
        step === 1
          ? "Goes the moment an approval is marked, inside the merchant's daytime."
          : `Goes ${formatHours(email.delayHours)} after ${emailName(step - 1)} was sent, inside the merchant's daytime.`
      }
      aside={
        ready ? (
          <StatusChip tone="good">Design ready</StatusChip>
        ) : (
          <StatusChip tone="warn">No design yet</StatusChip>
        )
      }
      footer={
        <>
          {ready ? (
            <Button
              size="sm"
              variant="ghost"
              className="mr-auto hover:bg-bad-soft"
              disabled={busy !== null}
              onClick={() => setConfirmClear(true)}
            >
              {/* the ghost button's own ink would win over a text-bad on the button itself */}
              <span className="text-bad">Remove design</span>
            </Button>
          ) : null}
          {dirty ? (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={discard}>
              Discard changes
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : `Save ${name}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[176px_minmax(0,1fr)]">
        {hasHtml && check ? (
          <ApprovalPreview
            html={check.html}
            subject={effectiveSubject}
            name={name}
            unsaved={draft !== null}
          />
        ) : (
          <div className="flex h-[220px] w-[176px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2/50 px-4 text-center text-xs text-muted">
            <Icon d={ICON.mail} className="size-5" />
            No design yet
          </div>
        )}
        <div className="min-w-0 space-y-3">
          <Field
            label="Subject line"
            hint="Fields work here too, like {{first_name}}. Left empty, it is the design's <title>."
          >
            <Input
              value={subject}
              maxLength={200}
              placeholder={titleSubject || "Congrats {{first_name}}, you're approved"}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          {hasHtml ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-text-2">
                <Icon d={ICON.sheet} className="size-3.5" />
                <span className="truncate">
                  {fileName || (draft?.from === "paste" ? "Pasted HTML" : "Saved design")}
                </span>
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{formatKb(size)}</span>
              {draft ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-medium text-accent">Not saved yet</span>
                </>
              ) : email.updated && ready ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{email.updated}</span>
                </>
              ) : null}
            </p>
          ) : null}
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-text-2">
              {check ? "Fields in this design" : "Fields you can use"}
            </p>
            <FieldChips used={check?.used ?? []} />
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        <label
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            "flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-4 text-center transition duration-150",
            "has-[:focus-visible]:border-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring",
            dragging
              ? "border-accent bg-accent-soft"
              : "border-border-strong hover:border-accent/60 hover:bg-surface-2/60",
          )}
        >
          <input
            type="file"
            accept=".html,.htm,text/html"
            className="sr-only"
            aria-describedby={dropHintId}
            onChange={(e) => {
              const input = e.currentTarget;
              void takeFile(input.files?.[0]).finally(() => {
                // the same file chosen again (after an edit in the design tool) must still count as a change
                input.value = "";
              });
            }}
          />
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent"
          >
            <Icon d={ICON.upload} />
          </span>
          <span className="text-sm font-medium">
            {hasHtml ? "Drop a new design here, or " : "Drop the email's .html file here, or "}
            <span className="text-accent underline-offset-2 hover:underline">choose a file</span>
          </span>
          <span id={dropHintId} className="text-xs text-muted">
            An .html or .htm file. Under 100 KB, so Gmail shows all of it.
          </span>
        </label>

        {fileError ? (
          <p role="alert" className="text-[13px] text-bad">
            {fileError}
          </p>
        ) : null}

        <details className="group rounded-xl border border-border">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-text-2 transition select-none hover:text-text focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <Icon
              d={ICON.chevronDown}
              className="size-3.5 -rotate-90 transition-transform duration-150 group-open:rotate-0"
            />
            Paste HTML instead
          </summary>
          <div className="border-t border-border p-3">
            <label htmlFor={pasteId} className="text-[12px] font-medium text-text-2">
              The email&apos;s HTML
            </label>
            <Textarea
              id={pasteId}
              rows={8}
              spellCheck={false}
              value={paste}
              placeholder="<!DOCTYPE html>…"
              className="mt-1.5 font-mono text-xs"
              onChange={(e) => onPaste(e.target.value)}
            />
          </div>
        </details>

        <div aria-live="polite" className="space-y-2">
          {check ? <Findings errors={check.errors} warnings={check.warnings} /> : null}
          {savedNotes.length > 0 && !draft ? (
            <p className="rounded-xl border border-good/30 bg-good-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-good">
              Saved. {savedNotes.join(" ")}
            </p>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={`Remove the design for ${name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={busy === "clear"} onClick={() => void clear()}>
              {busy === "clear" ? "Removing…" : "Remove design"}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">
          Approvals that reach {name} wait there until it has a design again. The subject line goes
          too{base.fileName ? `, and ${base.fileName} is not kept here` : ""}.
        </p>
      </Dialog>
    </SettingsCard>
  );
}
