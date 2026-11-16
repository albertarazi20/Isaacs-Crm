"use client";

import { useRef, useState } from "react";

type Result =
  | { filename: string; ok: true; label: string; duplicate: boolean; confidence: number }
  | { filename: string; ok: false; error: string };

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.csv,.xlsx,.docx";

export function UploadForm({ token }: { token: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function send(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of list.slice(0, 10)) form.append("file", f, f.name);
      const r = await fetch(`/api/upload/${token}`, { method: "POST", body: form });
      const body = (await r.json().catch(() => ({}))) as { results?: Result[]; error?: string };
      if (body.results) setResults((prev) => [...body.results!, ...prev]);
      else setError(body.error ?? "Something went wrong. Try again.");
    } catch {
      setError("The upload did not go through. Check your connection and try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="mt-6">
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
        className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${
          over ? "border-text bg-surface" : "border-border"
        }`}
      >
        <p className="text-sm font-medium">Drop files here</p>
        <p className="mt-1 text-xs text-muted">or</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="mt-3 rounded-lg bg-text px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
        >
          {busy ? "Sending…" : "Choose files"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => e.target.files && void send(e.target.files)}
        />
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface">
          {results.map((r, i) => (
            <li
              key={`${r.filename}-${i}`}
              className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
            >
              <span className="min-w-0 truncate">{r.filename}</span>
              {r.ok ? (
                <span className="shrink-0 text-good">
                  ✓ {r.duplicate ? "Already received" : `Received as ${r.label.toLowerCase()}`}
                </span>
              ) : (
                <span className="shrink-0 text-bad">{r.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
