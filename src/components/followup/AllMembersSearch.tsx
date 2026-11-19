"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/app-context";
import { copyText } from "@/components/client/parts";
import { useToast } from "@/components/overlay";
import { Glyph } from "@/components/shell/icons";
import { Button, IconButton, Input, Kbd, cn } from "@/components/ui";
import type { BucketMember } from "@/lib/buckets/queries";
import { matchesSearch } from "@/lib/followup/search";
import { formatUS } from "@/lib/mca/phone";
import { DialListDialog } from "./DialList";
import { downloadFile } from "./download";

const SHOWN_MAX = 40;

/**
 * Find anyone in any bucket: type a name, a number, an email, a state, a bucket or a rep. Each result says which bucket
 * the merchant is in, and can be called, copied or opened. A manager can take everything out as one file, or the
 * search result as a dial list.
 */
export function AllMembersSearch({
  members,
  truncated,
  canExport,
}: {
  members: readonly BucketMember[];
  /** The server cut the list at its cap (listAllMembersCapped): more people exist than the search and the file hold. */
  truncated: boolean;
  canExport: boolean;
}) {
  const { today } = useApp();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [dialing, setDialing] = useState(false);
  const box = useRef<HTMLLabelElement>(null);

  // "/" jumps to the search box, unless something is being typed or a sheet is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      box.current?.querySelector("input")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const cut = truncated;
  const needle = query.trim();
  const found = useMemo(
    () => (needle === "" ? [] : members.filter((m) => matchesSearch(m, needle))),
    [members, needle],
  );

  async function copyPhone(m: BucketMember) {
    const ok = await copyText(formatUS(m.phone));
    toast({
      message: ok ? `${formatUS(m.phone)} copied` : "Couldn't copy. Select the number yourself",
      tone: ok ? "success" : "error",
    });
  }

  async function exportEverything() {
    // built on the server (managers only, audited, 20 an hour), from the members this page holds
    let res: Response;
    try {
      res = await fetch("/api/export/followup", {
        method: "POST",
        body: new URLSearchParams({
          bucket: "all",
          ids: members.map((m) => m.client_id).join(","),
        }),
      });
    } catch {
      toast({ message: "Couldn't reach the server. Check your connection", tone: "error" });
      return;
    }
    if (!res.ok) {
      toast({
        message: (await res.text().catch(() => "")) || "The download didn't work. Try again",
        tone: "error",
      });
      return;
    }
    const left = Number(res.headers.get("x-left-out") ?? "0");
    downloadFile(`selective-all-buckets-${today}.csv`, await res.text());
    toast({
      message: cut
        ? `Exported the first ${members.length}. There are more in follow-up than one file holds: export one bucket at a time for the rest`
        : left > 0
          ? `Exported ${members.length - left}. ${left} marked do not contact ${left === 1 ? "was" : "were"} left out`
          : `Exported ${members.length} from every bucket`,
      tone: cut ? "info" : "success",
    });
  }

  return (
    <section aria-label="Find a merchant in any bucket" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label ref={box} className="relative min-w-0 flex-1 basis-72">
          <span className="sr-only">Search every bucket</span>
          <Glyph
            name="search"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${cut ? "the first " : "all "}${members.length} in follow-up: name, number, email, bucket`}
            className="rounded-full pr-9 pl-10"
          />
          {query === "" ? (
            <span className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 sm:block">
              <Kbd>/</Kbd>
            </span>
          ) : null}
        </label>
        {canExport ? (
          <Button onClick={() => void exportEverything()} disabled={members.length === 0}>
            <Glyph name="download" className="size-4 text-muted" />
            Export every bucket
          </Button>
        ) : null}
      </div>

      {needle !== "" ? (
        <div className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <p className="text-[13px] text-muted">
              {found.length === 0
                ? "Nobody matches"
                : `${found.length} ${found.length === 1 ? "match" : "matches"}${found.length > SHOWN_MAX ? `, the first ${SHOWN_MAX} shown` : ""}`}
            </p>
            {found.length > 0 ? (
              <Button size="sm" onClick={() => setDialing(true)}>
                <Glyph name="phone" className="size-3.5 text-muted" />
                Dial list
                <span className="text-[11px] text-muted tabular-nums">{found.length}</span>
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {found.slice(0, SHOWN_MAX).map((m) => (
              <li key={m.client_id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <Link
                  href={`/clients/${m.client_id}`}
                  className="min-w-0 flex-1 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="block truncate text-[13px] font-semibold">
                    {m.business_name}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {[m.contact_name, m.phone ? formatUS(m.phone) : "", m.email, m.state]
                      .filter(Boolean)
                      .join(" · ") || "no email or phone"}
                  </span>
                </Link>
                <Link
                  href={`/follow-up?b=${m.bucket_id}`}
                  className={cn(
                    "shrink-0 rounded-full border border-border bg-surface-3/60 px-2.5 py-1 text-[11.5px] font-medium text-text-2 transition hover:border-accent/40 hover:text-accent",
                    m.paused && "opacity-70",
                  )}
                  title={`Open the ${m.bucket_name} bucket`}
                >
                  {m.bucket_name}
                  {m.paused ? " · paused" : ""}
                </Link>
                {m.phone ? (
                  <IconButton
                    label={`Copy ${m.business_name}'s number`}
                    onClick={() => void copyPhone(m)}
                  >
                    <Glyph name="copy" className="size-4" />
                  </IconButton>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {dialing ? (
        <DialListDialog
          title="Dial list · search results"
          members={found}
          onClose={() => setDialing(false)}
        />
      ) : null}
    </section>
  );
}
