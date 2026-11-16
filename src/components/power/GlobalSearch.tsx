"use client";

import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { loadDirectoryAction } from "@/app/power-actions";
import type { DirectoryRow } from "@/lib/data/overdue";
import { CONTACT_STATUS_LABELS } from "@/lib/mca/contact";
import { useApp } from "../app-context";
import { cn } from "../ui";
import { callingYouLine, detailLine, searchDirectory } from "./search";

/** The directory is re-read when the palette opens and the copy is older than this. */
const FRESH_MS = 30_000;

const noop = () => () => undefined;
/** False on the server and during hydration, true after: portals render only on the client. */
const useMounted = () =>
  useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
/** Server and first paint say ⌘K; a non-Mac browser corrects to Ctrl K right after hydration. */
const useIsMac = () =>
  useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true,
  );

function SearchIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="9" cy="9" r="6" />
      <path d="m14 14 4 4" />
    </svg>
  );
}

/**
 * Header search + ⌘K / Ctrl+K command palette over ALL clients. The lightweight client list is fetched when
 * the palette first opens and kept for the session (per mounted layout, so it can never outlive a log out).
 * Typing a whole phone number answers "who is calling me?" first.
 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchedAt = useRef(0);
  const loading = useRef(false);
  const { nowMs } = useApp();
  // Every action re-renders the layout with a new time: a merchant added or trashed since the copy was taken must
  // not be missed by the very next search (an inbound call from a number he just saved).
  useEffect(() => {
    fetchedAt.current = 0;
  }, [nowMs]);
  const isMac = useIsMac();
  const mounted = useMounted();

  const load = useCallback(async () => {
    if (loading.current || Date.now() - fetchedAt.current < FRESH_MS) return;
    loading.current = true;
    try {
      const res = await loadDirectoryAction();
      if (res.ok) {
        setRows(res.data);
        setError(null);
        fetchedAt.current = Date.now();
      } else {
        setError(res.error);
      }
    } catch {
      setError("Couldn't reach the server — check your connection");
    } finally {
      loading.current = false;
    }
  }, []);

  const show = useCallback(() => {
    setOpen(true);
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label="Find a client"
        aria-keyshortcuts="Control+K Meta+K"
        className="inline-flex h-10 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-text sm:h-9 lg:w-60 lg:border lg:border-border lg:bg-surface-2/60 lg:px-3 lg:hover:border-border-strong lg:hover:bg-surface"
      >
        <SearchIcon />
        <span className="hidden flex-1 text-left lg:inline">Find a client…</span>
        <kbd className="hidden rounded border border-border bg-surface px-1.5 font-sans text-[11px] text-muted lg:inline">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
      {/* In the body, not the header: power-dial mode makes the header inert, and search must still work there. */}
      {mounted
        ? createPortal(
            <PaletteDialog open={open} onClose={() => setOpen(false)}>
              {open ? (
                <Palette
                  rows={rows}
                  error={error}
                  retry={() => void load()}
                  onClose={() => setOpen(false)}
                />
              ) : null}
            </PaletteDialog>,
            document.body,
          )
        : null}
    </>
  );
}

function PaletteDialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label="Find a client"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="mx-auto mt-[8vh] mb-auto w-[calc(100%-1rem)] max-w-xl rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl backdrop:bg-black/50"
    >
      {children}
    </dialog>
  );
}

function Palette({
  rows,
  error,
  retry,
  onClose,
}: {
  rows: DirectoryRow[] | null;
  error: string | null;
  retry: () => void;
  onClose: () => void;
}) {
  const { nowMs } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const result = useMemo(() => (rows ? searchDirectory(rows, query) : null), [rows, query]);
  const options = useMemo(() => (result ? [...result.calling, ...result.matches] : []), [result]);
  const activeIdx = Math.min(active, Math.max(0, options.length - 1));
  const activeRow = options[activeIdx];
  const optionId = (r: DirectoryRow) => `gs-opt-${r.id}`;

  useEffect(() => {
    if (activeRow)
      document.getElementById(optionId(activeRow))?.scrollIntoView({ block: "nearest" });
  }, [activeRow]);

  const go = (row: DirectoryRow) => {
    onClose();
    router.push(`/clients/${row.id}`);
  };

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    if (e.key === "ArrowDown" && n > 0) {
      e.preventDefault();
      setActive((activeIdx + 1) % n);
    } else if (e.key === "ArrowUp" && n > 0) {
      e.preventDefault();
      setActive((activeIdx - 1 + n) % n);
    } else if (e.key === "Enter" && activeRow) {
      e.preventDefault();
      go(activeRow);
    }
  }

  let status = "";
  if (error) status = error;
  else if (!rows) status = "Loading clients…";
  else if (result?.kind === "empty") status = "Type to search";
  else status = `${options.length} result${options.length === 1 ? "" : "s"}`;

  const optionClass = (selected: boolean, calling = false) =>
    cn(
      "cursor-pointer rounded-lg px-3 py-2",
      calling ? "bg-accent-soft" : "",
      selected ? "outline-2 -outline-offset-2 outline-accent" : "hover:bg-surface-2",
    );

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 focus-within:border-accent">
        <SearchIcon />
        <input
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls="gs-list"
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
          aria-label="Search by name, DBA, merchant, email or phone"
          placeholder="Name, DBA, email, or phone digits…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 flex-1 bg-transparent text-base text-text outline-none! placeholder:text-muted/70"
        />
        <button
          type="button"
          aria-label="Close search"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2"
        >
          Esc
        </button>
      </div>

      <div className="overflow-y-auto p-2">
        <p role="status" className="sr-only">
          {status}
        </p>
        {error ? (
          <p className="p-3 text-sm text-bad">
            {error}{" "}
            <button type="button" className="font-semibold underline" onClick={retry}>
              Try again
            </button>
          </p>
        ) : !rows ? (
          <p className="p-3 text-sm text-muted">Loading clients…</p>
        ) : result?.kind === "empty" ? (
          <p className="p-3 text-sm text-muted">
            Search every client by name, DBA, merchant, email or phone digits (305555 finds them).
            Type a whole phone number to see who is calling.
          </p>
        ) : options.length === 0 ? (
          <p className="p-3 text-sm text-muted">
            {result?.kind === "number"
              ? "No client has that number."
              : `No client matches “${query.trim()}”.`}
          </p>
        ) : (
          <ul id="gs-list" role="listbox" aria-label="Clients" className="space-y-1">
            {options.map((row, i) => {
              const calling = i < (result?.calling.length ?? 0);
              return (
                <li
                  key={row.id}
                  id={optionId(row)}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={optionClass(i === activeIdx, calling)}
                  onMouseMove={() => i !== activeIdx && setActive(i)}
                  onClick={() => go(row)}
                >
                  {calling ? (
                    <p className="text-sm font-semibold">{callingYouLine(row, nowMs)}</p>
                  ) : (
                    <>
                      <p className="flex items-center gap-2 text-sm font-semibold">
                        {row.business_name}
                        {row.contact_status !== "ok" ? (
                          <span className="rounded-md bg-bad-soft px-1.5 py-0.5 text-xs font-semibold text-bad">
                            {CONTACT_STATUS_LABELS[row.contact_status]}
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted">{detailLine(row)}</p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        ↑ ↓ to move · Enter to open · Esc to close
      </p>
    </div>
  );
}
