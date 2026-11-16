"use client";

import { useState, type FormEvent } from "react";
import { askDealAction, askManagerAction } from "@/app/deals-actions";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/deals/primitives";
import { useCall, useToast } from "@/components/overlay";
import { Badge, Button, Card, Field, Input, SectionTitle } from "@/components/ui";
import type { DealAnswer } from "@/lib/deals/ask";
import { eventDomId } from "@/lib/deals/timelineIds";
import { formatDate } from "@/lib/format";

const CONFIDENCE = {
  high: { tone: "good", word: "High confidence" },
  medium: { tone: "warn", word: "Medium confidence" },
  low: { tone: "bad", word: "Low confidence" },
} as const;

/** Scrolls to a timeline row, lights it for a moment, and puts keyboard focus there. */
function jumpTo(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
  el.focus({ preventScroll: true });
  el.dataset.cited = "true";
  window.setTimeout(() => {
    delete el.dataset.cited;
  }, 2800);
  return true;
}

/**
 * "Ask about this deal": a question in plain words, answered from the deal's own timeline. The answer says how
 * sure it is and links to the lines it rests on; a link scrolls to that line in the feed below and lights it.
 * When the timeline does not say, the answer says exactly that. Under it, "Ask manager" sends one line to every
 * manager's alerts, with the deal's context attached.
 */
export function AskDeal({
  dealId,
  blockedReason,
}: {
  dealId: string;
  /** Plain words for why the AI cannot run right now; null when it can. */
  blockedReason: string | null;
}) {
  const { today } = useApp();
  const call = useCall();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<DealAnswer | null>(null);
  const [managerLine, setManagerLine] = useState("");
  const [managerBusy, setManagerBusy] = useState(false);
  const off = blockedReason !== null;

  async function ask(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (off || busy || q.length < 3) return;
    setBusy(true);
    const r = await call(askDealAction({ dealId, question: q }));
    setBusy(false);
    if (!r) return;
    setAsked(q);
    setAnswer(r);
  }

  async function askManager(e: FormEvent) {
    e.preventDefault();
    const q = managerLine.trim();
    if (managerBusy || q === "") return;
    setManagerBusy(true);
    const r = await call(askManagerAction({ dealId, question: q }));
    setManagerBusy(false);
    if (!r) return;
    setManagerLine("");
    toast({
      message:
        r.managers > 0
          ? `Asked ${r.managers} ${r.managers === 1 ? "manager" : "managers"} — they got an alert with this deal`
          : "There is no manager to alert yet",
      tone: r.managers > 0 ? "success" : "info",
    });
  }

  function cite(id: string) {
    if (!jumpTo(id))
      toast({ message: "That line is further back than the feed below shows", tone: "info" });
  }

  const unbacked = answer !== null && !answer.cannotAnswer && answer.citations.length === 0;

  return (
    <Card className="space-y-5 p-4 sm:p-5">
      <div>
        <SectionTitle>Ask about this deal</SectionTitle>
        <form onSubmit={(e) => void ask(e)} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Your question" className="min-w-0 flex-1 basis-64">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Where does this deal stand?"
              maxLength={500}
              disabled={off}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            disabled={off || busy || question.trim().length < 3}
          >
            <Icon name="sparkles" className="size-3.5 text-muted" />
            {busy ? "Reading the timeline…" : "Ask"}
          </Button>
        </form>
        <p className="mt-1.5 text-xs text-muted">
          {blockedReason ?? "Answered from this deal's timeline, with the lines it rests on."}
        </p>
        {answer ? (
          <div
            role="status"
            aria-live="polite"
            data-ask-answer={answer.cannotAnswer ? "unknown" : "answer"}
            className="mt-2 rounded-lg border border-border bg-surface-2 p-3"
          >
            <p className="text-xs text-muted">You asked: {asked}</p>
            {answer.cannotAnswer ? (
              <p className="mt-1 text-sm font-semibold">The timeline does not say.</p>
            ) : null}
            <p className="mt-1 text-sm whitespace-pre-wrap">{answer.answer}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge tone={CONFIDENCE[answer.confidence].tone}>
                {CONFIDENCE[answer.confidence].word}
              </Badge>
              {unbacked ? (
                <span className="text-xs text-bad">
                  No line in the timeline backs this up, so treat it as a guess.
                </span>
              ) : null}
              {answer.dropped > 0 ? (
                <span className="text-xs text-muted">
                  {answer.dropped} {answer.dropped === 1 ? "line" : "lines"} the answer named could
                  not be checked and {answer.dropped === 1 ? "was" : "were"} left out.
                </span>
              ) : null}
            </div>
            {answer.citations.length > 0 ? (
              <div className="mt-3 border-t border-border pt-2">
                <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                  Based on
                </p>
                <ul className="mt-1 space-y-1.5">
                  {answer.citations.map((c) => {
                    const id = eventDomId(c);
                    return (
                      <li key={`${id}-${c.quote}`} className="text-sm">
                        <a
                          href={`#${id}`}
                          data-cite-link={id}
                          onClick={(e) => {
                            e.preventDefault();
                            cite(id);
                          }}
                          className="font-medium text-accent hover:underline"
                        >
                          {c.title}
                        </a>
                        <span className="text-xs text-muted">
                          {" "}
                          · {formatDate(c.at.slice(0, 10), today)}
                        </span>
                        <span className="block text-xs text-text-2">“{c.quote}”</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <form
        onSubmit={(e) => void askManager(e)}
        className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
      >
        <Field label="Ask a manager" className="min-w-0 flex-1 basis-64">
          <Input
            value={managerLine}
            onChange={(e) => setManagerLine(e.target.value)}
            placeholder="What do you need from them?"
            maxLength={300}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          disabled={managerBusy || managerLine.trim() === ""}
        >
          {managerBusy ? "Sending…" : "Ask manager"}
        </Button>
        <p className="basis-full text-xs text-muted">
          One line. Every manager gets an alert with this deal&apos;s context.
        </p>
      </form>
    </Card>
  );
}
