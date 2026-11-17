"use client";

import { useRef, useState } from "react";
import { Glyph } from "@/components/shell/icons";
import { buttonClass, cn } from "@/components/ui";

type Result =
  | { filename: string; ok: true; label: string; duplicate: boolean; confidence: number }
  | { filename: string; ok: false; error: string };

interface Wanted {
  kind: string;
  period: string | null;
  label: string;
}

/** One file on its way: its own bar while it travels, then what the server made of it. */
interface Item {
  id: string;
  name: string;
  size: number;
  /** 0..1 of this file's bytes sent. */
  progress: number;
  state: "sending" | "checking" | "done" | "failed";
  note: string;
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.csv,.xlsx,.docx";
const MAX_FILES = 10;
const wantedKey = (w: Wanted) => `${w.kind}-${w.period ?? ""}`;

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Posts the form and reports how many bytes have left the device, so each file can show its own progress. */
function post(
  url: string,
  form: FormData,
  onProgress: (fraction: number) => void,
): Promise<{ results?: Result[]; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as { results?: Result[]; error?: string });
      } catch {
        resolve({});
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(form);
  });
}

/** The big control on the merchant's phone: one tap opens the picker; a desktop can drop files on it too. */
export function UploadForm({ token, wanted: initialWanted }: { token: string; wanted: Wanted[] }) {
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const batch = useRef(0);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // what the link asked for when it opened, and what it still asks for now
  const [asked] = useState(initialWanted);
  const [open, setOpen] = useState(() => new Set(initialWanted.map(wantedKey)));

  const patch = (ids: readonly string[], fn: (it: Item, i: number) => Item) =>
    setItems((cur) =>
      cur.map((it) => {
        const i = ids.indexOf(it.id);
        return i === -1 ? it : fn(it, i);
      }),
    );

  /** After files land, ask the link what it still needs, so the checklist ticks itself off. */
  async function refreshWanted() {
    try {
      const r = await fetch(`/api/upload/${token}`, { cache: "no-store" });
      if (!r.ok) return;
      const body = (await r.json()) as { wanted?: Wanted[] };
      if (body.wanted) setOpen(new Set(body.wanted.map(wantedKey)));
    } catch {
      // The checklist is a courtesy; the files themselves already arrived.
    }
  }

  async function send(files: FileList | File[]) {
    const all = Array.from(files);
    if (all.length === 0 || busy) return;
    const list = all.slice(0, MAX_FILES);
    setNotice(
      all.length > MAX_FILES
        ? `Only the first ${MAX_FILES} files were sent. Add the rest when these finish.`
        : null,
    );
    const round = ++batch.current;
    const ids = list.map((_, i) => `${round}-${i}`);
    const total = list.reduce((n, f) => n + f.size, 0) || 1;
    const starts = list.map((_, i) => list.slice(0, i).reduce((n, f) => n + f.size, 0));
    setItems((cur) => [
      ...list.map((f, i) => ({
        id: ids[i] ?? `${round}-${i}`,
        name: f.name,
        size: f.size,
        progress: 0,
        state: "sending" as const,
        note: "",
      })),
      ...cur,
    ]);
    setBusy(true);
    setError(null);
    // on a phone the list sits below the fold: bring it up so the progress is seen
    requestAnimationFrame(() =>
      listRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    try {
      const form = new FormData();
      for (const f of list) form.append("file", f, f.name);
      const body = await post(`/api/upload/${token}`, form, (fraction) => {
        const sent = fraction * total;
        patch(ids, (it, i) => {
          const p = Math.max(0, Math.min(1, (sent - (starts[i] ?? 0)) / (it.size || 1)));
          return { ...it, progress: p, state: p >= 1 ? "checking" : "sending" };
        });
      });
      if (body.results) {
        const results = body.results;
        patch(ids, (it, i) => {
          const r = results[i];
          if (!r) return { ...it, state: "failed", note: "No answer for this file. Try it again." };
          return r.ok
            ? {
                ...it,
                progress: 1,
                state: "done",
                note: r.duplicate ? "Already received" : `Received as ${r.label.toLowerCase()}`,
              }
            : { ...it, state: "failed", note: r.error };
        });
        void refreshWanted();
      } else {
        const message = body.error ?? "Something went wrong. Try again.";
        setError(message);
        patch(ids, (it) => ({ ...it, state: "failed", note: "Not sent" }));
      }
    } catch {
      setError("The upload did not go through. Check your connection and try again.");
      patch(ids, (it) => ({ ...it, state: "failed", note: "Not sent" }));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const received = items.filter((it) => it.state === "done").length;
  const still = asked.filter((w) => open.has(wantedKey(w))).length;

  return (
    <section className="mt-7 space-y-4">
      {asked.length > 0 ? (
        <div className="rounded-3xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight">Still needed</h2>
            <span className="text-xs font-medium text-muted tabular-nums">
              {still === 0 ? "All here" : `${still} of ${asked.length} to go`}
            </span>
          </div>
          <ul className="mt-3 space-y-0.5">
            {asked.map((w) => {
              const here = !open.has(wantedKey(w));
              return (
                <li key={wantedKey(w)} className="flex min-h-11 items-center gap-3 text-[15px]">
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full transition duration-200",
                      here
                        ? "bg-good-soft text-good ring-1 ring-good/25"
                        : "border-[1.5px] border-border-strong",
                    )}
                  >
                    {here ? <Glyph name="check" className="size-3.5" strokeWidth={2.4} /> : null}
                  </span>
                  <span className={cn("min-w-0", here ? "text-muted line-through" : "font-medium")}>
                    {w.label}
                  </span>
                  {here ? <span className="sr-only">received</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
        className={cn(
          "relative overflow-hidden rounded-3xl border-[1.5px] border-dashed px-6 py-9 text-center transition duration-200 sm:py-11",
          over
            ? "bg-brand-soft scale-[1.01] border-accent"
            : "border-border-strong bg-surface-3/50 hover:border-accent/60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "bg-brand-soft mx-auto flex size-16 items-center justify-center rounded-full text-accent ring-1 ring-accent/25 transition duration-200",
            over && "-translate-y-1",
          )}
        >
          <Glyph name="upload" className="size-7" />
        </span>
        <p className="mt-4 text-[17px] font-semibold tracking-tight">
          {over ? "Let go to send" : "Add your documents"}
        </p>
        <p className="mt-1 text-sm text-muted">
          <span className="sm:hidden">Take a photo or pick files from your phone.</span>
          <span className="max-sm:hidden">Drop files here, or pick them from your computer.</span>
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className={buttonClass("primary", "lg", "mt-6 h-13 w-full text-base sm:w-auto sm:px-9")}
        >
          {busy ? "Sending…" : "Choose files"}
        </button>
        <p className="mt-4 text-xs text-muted">
          PDF, photo, spreadsheet or Word. Up to 25 MB each.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => e.target.files && void send(e.target.files)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-2xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad"
        >
          <Glyph name="alert" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
          {notice}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div ref={listRef} className="scroll-mb-6 rounded-3xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <h2 className="text-[15px] font-semibold tracking-tight">Your files</h2>
            <span className="text-xs font-medium text-muted tabular-nums" aria-live="polite">
              {received} of {items.length} received
            </span>
          </div>
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li key={it.id} className="flex animate-fade items-center gap-3 px-5 py-3.5">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-2xl ring-1 transition duration-200",
                    it.state === "done"
                      ? "bg-good-soft text-good ring-good/25"
                      : it.state === "failed"
                        ? "bg-bad-soft text-bad ring-bad/25"
                        : "bg-accent-soft text-accent ring-accent/25",
                  )}
                >
                  <Glyph
                    name={it.state === "done" ? "check" : it.state === "failed" ? "alert" : "file"}
                    className="size-[18px]"
                    strokeWidth={it.state === "done" ? 2.2 : 1.75}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium">{it.name}</p>
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {it.state === "sending"
                        ? `${Math.round(it.progress * 100)}%`
                        : sizeOf(it.size)}
                    </span>
                  </div>
                  {it.state === "sending" || it.state === "checking" ? (
                    <div className="mt-2">
                      <div
                        role="progressbar"
                        aria-label={`Sending ${it.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(it.progress * 100)}
                        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
                      >
                        <div
                          className="bg-brand h-full origin-left rounded-full transition-transform duration-300 ease-out"
                          style={{ transform: `scaleX(${Math.max(0.03, it.progress)})` }}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-muted">
                        {it.state === "checking" ? "Sent. Filing it now…" : "Sending…"}
                      </p>
                    </div>
                  ) : (
                    <p
                      className={cn(
                        "mt-0.5 text-[13px]",
                        it.state === "done" ? "text-good" : "text-bad",
                      )}
                    >
                      {it.note}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {received > 0 && !busy ? (
            <p className="border-t border-border px-5 py-3.5 text-[13px] text-text-2">
              Got them. You can add more, or close this page when you are done.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
