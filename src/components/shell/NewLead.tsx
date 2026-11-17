"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadStagedRowsAction } from "@/app/intake-actions";
import { BulkIntake } from "@/components/intake/BulkIntake";
import { IntakeForm } from "@/components/intake/IntakeForm";
import { Drawer } from "@/components/overlay";
import { cn, Kbd, Skeleton } from "@/components/ui";
import type { BucketRow } from "@/lib/buckets/queries";
import type { AssistantState } from "@/lib/leads/assistant";
import type { StagedRow } from "@/lib/leads/staged";
import { Glyph } from "./icons";

type Tab = "one" | "sheet";
const NewLeadContext = createContext<(tab?: Tab) => void>(() => undefined);

/** Open the New lead sheet from anywhere in the app. */
export const useNewLead = () => useContext(NewLeadContext);

/** True when a key press belongs to something the person is typing into, or a sheet is already open. */
function busyElsewhere(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.closest("input, textarea, select, [contenteditable=true]")) return true;
  return Boolean(document.querySelector("dialog[open]"));
}

/**
 * Adding a lead is not a page. This holds the one sheet every "New lead" button opens, over whatever you are
 * looking at: one lead by hand (phone first, the sheet autofills), or the rows your Google Sheets already staged.
 * Press N anywhere to open it.
 */
export function NewLeadProvider({
  buckets,
  assistant,
  children,
}: {
  buckets: BucketRow[];
  assistant: AssistantState;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const linked = params.get("new-lead") === "1";
  const [asked, setAsked] = useState(false);
  const [tab, setTab] = useState<Tab>("one");
  const [staged, setStaged] = useState<{ rows: StagedRow[]; total: number } | null>(null);
  const [stagedError, setStagedError] = useState<string | null>(null);
  // a fresh form each time the sheet opens
  const [round, setRound] = useState(0);
  const open = asked || linked;
  const defaultBucket = useMemo(
    () => buckets.find((b) => b.key === "interested") ?? buckets[0] ?? null,
    [buckets],
  );

  const loadStaged = useCallback(async () => {
    setStagedError(null);
    try {
      const res = await loadStagedRowsAction();
      if (res.ok) setStaged(res.data);
      else setStagedError(res.error);
    } catch {
      setStagedError("Couldn't reach the server — check your connection");
    }
  }, []);

  const show = useCallback(
    (which: Tab = "one") => {
      setTab(which);
      setRound((n) => n + 1);
      setAsked(true);
      void loadStaged();
    },
    [loadStaged],
  );
  const close = useCallback(() => {
    setAsked(false);
    if (linked) router.replace(pathname);
  }, [linked, pathname, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (busyElsewhere(e.target)) return;
      e.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "one", label: "One lead" },
    { key: "sheet", label: "From your sheets", count: staged?.total },
  ];

  return (
    <NewLeadContext.Provider value={show}>
      {children}
      <Drawer
        open={open}
        onClose={close}
        wide={tab === "sheet"}
        eyebrow="New lead"
        title="Bring a merchant in"
        subtitle="Phone first. The bucket sends its first email the moment you add them, then keeps following up."
      >
        <div className="space-y-5">
          <div
            role="tablist"
            aria-label="How to add"
            className="inline-flex gap-0.5 rounded-full border border-border bg-surface-2/70 p-1"
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition duration-150",
                  tab === t.key
                    ? "bg-surface text-text shadow-card"
                    : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                {t.label}
                {t.count ? (
                  <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent tabular-nums">
                    {t.count}
                  </span>
                ) : null}
              </button>
            ))}
            <Link
              href="/import"
              onClick={close}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-muted transition duration-150 hover:bg-surface/60 hover:text-text"
            >
              Import a file
              <Glyph name="arrowUpRight" className="size-3.5" />
            </Link>
          </div>

          {tab === "one" ? (
            <IntakeForm
              key={round}
              buckets={buckets}
              defaultBucketId={defaultBucket?.id ?? null}
              assistant={assistant}
            />
          ) : stagedError ? (
            <p className="rounded-2xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
              {stagedError}
            </p>
          ) : staged ? (
            <BulkIntake
              key={`${round}-${staged.total}`}
              rows={staged.rows}
              total={staged.total}
              buckets={buckets}
              defaultBucketId={defaultBucket?.id ?? null}
            />
          ) : (
            <div className="space-y-3" aria-busy>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          )}
        </div>
      </Drawer>
    </NewLeadContext.Provider>
  );
}

/** The button. `full` is the sidebar's wide pill, `icon` the phone bar's round one, `inline` sits in a page. */
export function NewLeadButton({
  variant = "inline",
  className,
}: {
  variant?: "full" | "icon" | "inline";
  className?: string;
}) {
  const open = useNewLead();
  if (variant === "icon")
    return (
      <button
        type="button"
        aria-label="New lead"
        onClick={() => open()}
        className={cn(
          "bg-brand inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white shadow-glow transition duration-150 hover:brightness-110 active:scale-95",
          className,
        )}
      >
        <Glyph name="plus" className="size-5" strokeWidth={2.2} />
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => open()}
      aria-keyshortcuts="N"
      className={cn(
        "bg-brand group inline-flex items-center gap-2 rounded-full text-sm font-semibold text-white shadow-glow transition duration-150 [text-shadow:0_1px_1px_rgb(20_10_60/0.35)] hover:brightness-110 active:scale-[0.97]",
        variant === "full" ? "h-11 w-full justify-between pr-2 pl-4" : "h-10 px-4 sm:h-9",
        className,
      )}
    >
      <span className="inline-flex items-center gap-2">
        <Glyph name="plus" className="size-[18px]" strokeWidth={2.2} />
        New lead
      </span>
      {variant === "full" ? (
        <Kbd className="border-white/25 bg-white/15 text-white shadow-none">N</Kbd>
      ) : null}
    </button>
  );
}
