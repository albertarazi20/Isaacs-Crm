"use client";

import Link from "next/link";
import { useRef, useState, type DragEvent } from "react";
import { importOfferImageAction, importPastedOfferAction } from "@/app/inbox-actions";
import { Icon } from "@/components/deals/primitives";
import { useCall, useToast } from "@/components/overlay";
import { Button, Card, Field, SectionTitle, Select, Textarea, cn } from "@/components/ui";

export interface ImportLender {
  submissionId: string;
  name: string;
}

interface Landed {
  summary: string;
  event: string;
  unsupported: string[];
  problems: string[];
  from: "text" | "screenshot";
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
/** A server action carries 4 MB at most (next.config.ts); the form fields take a little of it. */
const SEND_LIMIT = 3_500_000;

/** A big screenshot is redrawn smaller as a JPEG; null when it still would not fit or cannot be read. */
async function fitForSending(f: File): Promise<File | null> {
  if (f.size <= SEND_LIMIT) return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
    if (blob && blob.size <= SEND_LIMIT)
      return new File([blob], `${f.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  } catch {
    // an image the browser cannot decode: the caller says so
  }
  return null;
}

/**
 * A manager brings a lender's answer in by hand (S2-15): paste the portal page or email text, or drop a screenshot
 * of it. Either way the terms land in the Review tray as a proposed update, with a link to it; nothing on the deal
 * changes until a manager says yes there. When the AI cannot run, the controls say why instead of failing.
 */
export function ImportFromLender({
  dealId,
  lenders,
  blockedReason,
}: {
  dealId: string;
  lenders: ImportLender[];
  /** Plain words for why the AI cannot run right now (no key, switched off, spend cap); null when it can. */
  blockedReason: string | null;
}) {
  const call = useCall();
  const toast = useToast();
  const [lender, setLender] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"text" | "screenshot" | null>(null);
  const [over, setOver] = useState(false);
  const [landed, setLanded] = useState<Landed | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const off = blockedReason !== null;

  async function readText() {
    setBusy("text");
    const r = await call(
      importPastedOfferAction({ dealId, submissionId: lender || null, text }),
      "Read it — the terms are in the Review tray",
    );
    setBusy(null);
    if (!r) return;
    setLanded({ ...r, from: "text" });
    setText("");
  }

  async function readImage(f: File | undefined) {
    if (!f) return;
    setBusy("screenshot");
    const sized = await fitForSending(f);
    if (!sized) {
      setBusy(null);
      if (file.current) file.current.value = "";
      toast({
        message: "That image is too big to send. Crop it to the terms and try again.",
        tone: "error",
      });
      return;
    }
    const form = new FormData();
    form.append("dealId", dealId);
    if (lender) form.append("submissionId", lender);
    form.append("file", sized, sized.name);
    const r = await call(
      importOfferImageAction(form),
      "Read the screenshot — the terms are in the Review tray",
    );
    setBusy(null);
    if (file.current) file.current.value = "";
    if (r) setLanded({ ...r, from: "screenshot" });
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setOver(false);
    if (off || busy) return;
    void readImage(e.dataTransfer.files[0]);
  }

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle
        aside={
          <Link
            href="/board?tab=review"
            className="text-xs font-medium text-accent hover:underline"
          >
            Review tray
          </Link>
        }
      >
        Import from lender
      </SectionTitle>
      <p className="mt-1 text-xs text-muted">
        Paste a lender&apos;s portal page or email, or drop a screenshot of it. The terms land in
        the Review tray for your yes; nothing on the deal changes by itself.
      </p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Field label="Which lender (optional)" className="lg:col-span-2 lg:max-w-sm">
          <Select
            value={lender}
            onChange={(e) => setLender(e.target.value)}
            disabled={off || busy !== null}
          >
            <option value="">The whole deal</option>
            {lenders.map((l) => (
              <option key={l.submissionId} value={l.submissionId}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-2">
          <Field label="Paste the lender's text">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              disabled={off || busy !== null}
              placeholder="The offer page or email, as plain text"
              maxLength={20000}
            />
          </Field>
          <Button
            variant="secondary"
            disabled={off || busy !== null || text.trim().length < 20}
            onClick={() => void readText()}
          >
            <Icon name="sparkles" className="size-3.5 text-muted" />
            {busy === "text" ? "Reading…" : "Read the text"}
          </Button>
        </div>
        <div className="space-y-1">
          <span className="block text-[12px] font-medium text-text-2">Or drop a screenshot</span>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              if (!off) setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cn(
              "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center text-sm transition",
              over ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3",
              (off || busy !== null) && "cursor-not-allowed opacity-60 hover:bg-transparent",
            )}
          >
            <Icon name="upload" className="size-5 text-muted" />
            <span className="font-medium">
              {busy === "screenshot"
                ? "Reading the screenshot…"
                : "Drop an image here, or choose one"}
            </span>
            <span className="text-xs text-muted">PNG, JPEG, WebP or GIF</span>
            <input
              ref={file}
              type="file"
              accept={ACCEPT}
              aria-label="Screenshot of the lender's page"
              className="sr-only"
              disabled={off || busy !== null}
              onChange={(e) => void readImage(e.target.files?.[0])}
            />
          </label>
        </div>
      </div>
      {off ? (
        <p className="mt-3 text-xs text-muted" data-ai-blocked>
          {blockedReason}
        </p>
      ) : null}
      {landed ? (
        <div
          role="status"
          data-import-landed={landed.from}
          className="mt-4 rounded-lg border border-border bg-surface-2 p-3 text-sm"
        >
          <p className="font-semibold">
            In the Review tray
            <span className="ml-1.5 text-xs font-normal text-muted">
              read from the {landed.from}, as {landed.event.replace(/_/g, " ")}
            </span>
          </p>
          <p className="mt-0.5 text-text-2">{landed.summary}</p>
          {landed.unsupported.length + landed.problems.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-warn">
              {[...landed.unsupported, ...landed.problems].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <Link
            href="/board?tab=review"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            Open the Review tray
            <Icon name="arrow-right" className="size-3.5" />
          </Link>
        </div>
      ) : null}
    </Card>
  );
}
