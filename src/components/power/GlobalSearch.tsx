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
import { Glyph, type GlyphName } from "../shell/icons";
import { useNewLead } from "../shell/NewLead";
import { useModal } from "../overlay";
import { Avatar, cn, Kbd } from "../ui";
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
 * The ⌘K / Ctrl+K command palette over ALL clients (the shell's search field and button open it too). The lightweight client list is fetched when
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
      setError("Couldn't reach the server. Check your connection");
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
    // the sidebar's search field and the phone bar's search button ask for the palette with this event
    window.addEventListener("crm:search", show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crm:search", show);
    };
  }, [show]);

  return (
    <>
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
  const [ref, onNativeClose, onKeyDown, onCancel] = useModal(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-label="Find a merchant"
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="glass-strong mx-auto mt-[10vh] mb-auto w-[calc(100%-1rem)] max-w-xl rounded-3xl border border-border p-0 text-text shadow-pop"
    >
      {children}
    </dialog>
  );
}

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: GlyphName;
  run: () => void;
}
type Item =
  | { type: "row"; id: string; row: DirectoryRow; calling: boolean }
  | { type: "cmd"; id: string; cmd: Command };

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
  const newLead = useNewLead();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // the palette also goes places and starts things: with nothing typed it is a jump list
  const commands = useMemo<Command[]>(() => {
    const to = (href: string) => () => {
      onClose();
      router.push(href);
    };
    return [
      {
        id: "new-lead",
        label: "New lead",
        hint: "Add a merchant",
        icon: "plus",
        run: () => {
          onClose();
          // after this dialog has closed, so the two never fight over the top layer
          setTimeout(() => newLead(), 0);
        },
      },
      {
        id: "assistant",
        label: "Ask the assistant",
        hint: "Ask",
        icon: "sparkles",
        run: () => {
          onClose();
          setTimeout(() => window.dispatchEvent(new Event("crm:assistant")), 0);
        },
      },
      { id: "overview", label: "Overview", hint: "Go to", icon: "overview", run: to("/") },
      { id: "follow", label: "Follow Up", hint: "Go to", icon: "followup", run: to("/follow-up") },
      {
        id: "merchants",
        label: "Merchants",
        hint: "Go to",
        icon: "merchants",
        run: to("/clients"),
      },
      { id: "calls", label: "Call list", hint: "Go to", icon: "list", run: to("/today") },
      { id: "dial", label: "Power dial", hint: "Start", icon: "zap", run: to("/dial") },
      { id: "import", label: "Import a file", hint: "Go to", icon: "upload", run: to("/import") },
      { id: "alerts", label: "Alerts", hint: "Go to", icon: "bell", run: to("/alerts") },
      { id: "settings", label: "Settings", hint: "Go to", icon: "settings", run: to("/settings") },
    ];
  }, [newLead, onClose, router]);

  const result = useMemo(() => (rows ? searchDirectory(rows, query) : null), [rows, query]);
  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const found: Item[] = result
      ? [
          ...result.calling.map((row) => ({
            type: "row" as const,
            id: row.id,
            row,
            calling: true,
          })),
          ...result.matches.map((row) => ({
            type: "row" as const,
            id: row.id,
            row,
            calling: false,
          })),
        ]
      : [];
    const cmds: Item[] =
      result?.kind === "number"
        ? []
        : commands
            .filter((c) => !q || c.label.toLowerCase().includes(q))
            .map((cmd) => ({ type: "cmd" as const, id: cmd.id, cmd }));
    return [...found, ...cmds];
  }, [commands, query, result]);
  const merchants = items.filter((i) => i.type === "row").length;
  const activeIdx = Math.min(active, Math.max(0, items.length - 1));
  const activeItem = items[activeIdx];
  const optionId = (it: Item) => `gs-${it.type === "cmd" ? "cmd" : "opt"}-${it.id}`;
  const activeId = activeItem ? optionId(activeItem) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const go = (it: Item) => {
    if (it.type === "cmd") return it.cmd.run();
    onClose();
    router.push(`/clients/${it.row.id}`);
  };

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const n = items.length;
    if (e.key === "ArrowDown" && n > 0) {
      e.preventDefault();
      setActive((activeIdx + 1) % n);
    } else if (e.key === "ArrowUp" && n > 0) {
      e.preventDefault();
      setActive((activeIdx - 1 + n) % n);
    } else if (e.key === "Enter" && activeItem) {
      e.preventDefault();
      go(activeItem);
    }
  }

  let status = "";
  if (error) status = error;
  else if (!rows) status = "Loading merchants…";
  else if (result?.kind === "empty") status = "Type to search";
  else status = `${merchants} result${merchants === 1 ? "" : "s"}`;

  const optionClass = (selected: boolean, calling = false) =>
    cn(
      "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-100",
      calling ? "bg-accent-soft" : "",
      selected ? "bg-surface-2 ring-1 ring-accent/40 ring-inset" : "hover:bg-surface-2/60",
    );

  return (
    <div className="flex max-h-[76vh] flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 text-muted focus-within:text-accent">
        <SearchIcon />
        <input
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="gs-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Search by name, DBA, merchant, email or phone"
          placeholder="Find a merchant, or jump somewhere…"
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
          className="h-14 flex-1 bg-transparent text-base text-text outline-none! placeholder:text-muted"
        />
        <button
          type="button"
          aria-label="Close search"
          onClick={onClose}
          className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted transition hover:text-text"
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
          <p className="p-3 text-sm text-muted">Loading merchants…</p>
        ) : result?.kind === "empty" ? (
          <p className="px-3 pt-2 pb-3 text-[13px] text-muted">
            Search every merchant by name, DBA, contact, email or phone digits (305555 finds them).
            Type a whole phone number to see who is calling.
          </p>
        ) : merchants === 0 ? (
          <p className="p-3 text-sm text-muted">
            {result?.kind === "number"
              ? "No merchant has that number."
              : `No merchant matches “${query.trim()}”.`}
          </p>
        ) : null}
        {rows && !error && items.length > 0 ? (
          <ul id="gs-list" role="listbox" aria-label="Merchants" className="space-y-0.5">
            {items.map((it, i) => {
              const selected = i === activeIdx;
              const first = it.type === "cmd" && items[i - 1]?.type !== "cmd";
              return (
                <li key={optionId(it)} role="presentation">
                  {first ? (
                    <p className="eyebrow px-3 pt-3 pb-1.5 text-[10px]!">
                      {query.trim() ? "Actions" : "Jump to"}
                    </p>
                  ) : null}
                  <div
                    id={optionId(it)}
                    role="option"
                    aria-selected={selected}
                    className={optionClass(selected, it.type === "row" && it.calling)}
                    onMouseMove={() => i !== activeIdx && setActive(i)}
                    onClick={() => go(it)}
                  >
                    {it.type === "cmd" ? (
                      <>
                        <span
                          aria-hidden
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-3 text-text-2"
                        >
                          <Glyph name={it.cmd.icon} className="size-4" />
                        </span>
                        <span className="flex-1 text-sm font-medium">{it.cmd.label}</span>
                        <span className="text-xs text-muted">{it.cmd.hint}</span>
                      </>
                    ) : it.calling ? (
                      <p className="text-sm font-semibold">{callingYouLine(it.row, nowMs)}</p>
                    ) : (
                      <>
                        <Avatar name={it.row.business_name} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-sm font-semibold">
                            <span className="truncate">{it.row.business_name}</span>
                            {it.row.contact_status !== "ok" ? (
                              <span className="rounded-full bg-bad-soft px-1.5 py-0.5 text-[11px] font-semibold text-bad">
                                {CONTACT_STATUS_LABELS[it.row.contact_status]}
                              </span>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {detailLine(it.row)}
                          </span>
                        </span>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <p className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd> to open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> to close
        </span>
      </p>
    </div>
  );
}
