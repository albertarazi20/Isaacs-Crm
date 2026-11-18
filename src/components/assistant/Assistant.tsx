"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { addNoteAction, sendEmailAction, setFollowUpAction } from "@/app/actions";
import {
  deleteThreadAction,
  listThreadsAction,
  loadRecommendationsAction,
  loadThreadAction,
  openPreparedAction,
} from "@/app/assistant-actions";
import {
  moveToBucketAction as moveMerchantsToBucketAction,
  pauseEnrollmentAction,
} from "@/app/buckets-actions";
import { handOffAction } from "@/app/followup-actions";
import { useApp } from "@/components/app-context";
import { Dialog, Drawer, useCall, useToast } from "@/components/overlay";
import { Glyph, type GlyphName } from "@/components/shell/icons";
import {
  Button,
  buttonClass,
  cn,
  Field,
  IconButton,
  Input,
  Kbd,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { gmailComposeHref } from "@/lib/mca/phone";
import { formatDate, timeAgo } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { PLAN_MY_DAY, STARTERS } from "@/lib/assistant/prompts";
import type { Recommendation } from "@/lib/assistant/recommendations";
import type { ShownItem, ThreadSummary } from "@/lib/assistant/run";
import type { ShownAction } from "@/lib/assistant/tools";
import type { AssistantState } from "@/lib/leads/assistant";
import { Markdown } from "./Markdown";
import { RecommendationCards } from "./RecommendationCards";

interface OpenOptions {
  /** Put this in the composer, or send it straight away with `send`. */
  prompt?: string;
  /** What the person's bubble says when a long brief is sent for them ("Plan my day"). */
  label?: string;
  send?: boolean;
  /** Start a new conversation first (a recommendation always does). */
  fresh?: boolean;
  /** Open what the assistant prepared in the background (a brain_preps id) with its buttons live. */
  prepId?: string;
}
const AssistantContext = createContext<(o?: OpenOptions) => void>(() => undefined);

/** Open the assistant from anywhere: `useAssistant()({ prompt, send: true })`. */
export const useAssistant = () => useContext(AssistantContext);

type ToolChip = { label: string; done: boolean };
type Item =
  | { kind: "user"; text: string; label?: string }
  | {
      kind: "assistant";
      text: string;
      actions: ShownAction[];
      tools: ToolChip[];
      streaming: boolean;
      notice?: string;
      error?: string;
      /** From a conversation reopened from history: its buttons may be out of date, so only Open and Copy work. */
      earlier?: boolean;
      /** The answer was handed back unfinished after the automatic continues: offer "Keep going". */
      canContinue?: boolean;
    };

type Status = "idle" | "running" | "done" | "failed";

const ACTION_ICON: Record<ShownAction["type"], GlyphName | "pause" | "copy"> = {
  open: "arrowUpRight",
  hand_off: "flag",
  set_follow_up: "clock",
  add_note: "file",
  pause: "pause",
  move_to_bucket: "bucket",
  send_email: "mail",
  copy: "copy",
};

function ActionIcon({ type }: { type: ShownAction["type"] }) {
  const name = ACTION_ICON[type];
  if (name === "pause")
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="currentColor">
        <rect x="6.5" y="5" width="3.5" height="14" rx="1.2" />
        <rect x="14" y="5" width="3.5" height="14" rx="1.2" />
      </svg>
    );
  if (name === "copy")
    return (
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      >
        <rect x="8" y="8" width="12" height="12" rx="2.5" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </svg>
    );
  return <Glyph name={name} className="size-4" />;
}

const PAGE_NAMES: [string, string][] = [
  ["/follow-up", "Follow Up"],
  ["/clients", "Merchants"],
  ["/today", "Call list"],
  ["/dial", "Power dial"],
  ["/import", "Import a file"],
  ["/trash", "Trash"],
  ["/alerts", "Alerts"],
  ["/settings/email", "Settings, Email"],
  ["/settings/buckets", "Settings, Buckets & templates"],
  ["/settings/sheets", "Settings, Lead sources"],
  ["/settings", "Settings"],
];
function pageName(href: string): string {
  if (href === "/" || href.startsWith("/?")) return "Overview";
  return (
    PAGE_NAMES.find(
      ([p]) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`),
    )?.[1] ?? href
  );
}

/** What an action does, in a few words, under its label. */
function actionDetail(a: ShownAction, today: string): string {
  const day = (d: string) => (d === today ? "today" : formatDate(d as ISODate, today));
  switch (a.type) {
    case "open":
      return `Go to ${pageName(a.href)}`;
    case "hand_off":
      return `${a.merchant_name}: mark brought in, stop the chase`;
    case "set_follow_up":
      return `${a.merchant_name}: next follow-up ${day(a.date)}`;
    case "add_note":
      return `${a.merchant_name}: add to the timeline`;
    case "pause":
      return `${a.merchant_name}: pause emails${a.until ? ` until ${day(a.until)}` : ""}`;
    case "move_to_bucket":
      return `${a.merchant_name}: move to ${a.bucket_name}`;
    case "send_email":
      return `To ${a.to ?? a.merchant_name}: ${a.subject}`;
    case "copy":
      return a.text.length > 70 ? `${a.text.slice(0, 70)}…` : a.text;
  }
}

function ActionCard({
  action,
  status,
  onRun,
  today,
  earlier = false,
}: {
  action: ShownAction;
  status: Status;
  onRun: () => void;
  today: string;
  /** From a reopened conversation: anything that changes a merchant waits for a fresh answer. */
  earlier?: boolean;
}) {
  const done = status === "done";
  const stale = earlier && !done && action.type !== "copy" && action.type !== "open";
  return (
    <li>
      <button
        type="button"
        onClick={onRun}
        disabled={
          stale ||
          status === "running" ||
          (done && action.type !== "copy" && action.type !== "open")
        }
        className={cn(
          "group flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition duration-150 active:scale-[0.99]",
          done
            ? "border-good/30 bg-good-soft/60"
            : status === "failed"
              ? "border-bad/30 bg-bad-soft/50"
              : "border-border bg-surface hover:border-accent/50 hover:bg-surface-3",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
            done
              ? "bg-good-soft text-good ring-good/25"
              : "bg-accent-soft text-accent ring-accent/25",
          )}
        >
          {done ? (
            <Glyph name="check" className="size-4" strokeWidth={2.2} />
          ) : (
            <ActionIcon type={action.type} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{action.label}</span>
          <span className="block truncate text-[12px] text-muted">
            {stale
              ? "From an earlier conversation. Ask again to act on it."
              : actionDetail(action, today)}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold",
            done
              ? "text-good"
              : status === "running"
                ? "text-muted"
                : status === "failed"
                  ? "text-bad"
                  : "bg-surface-2 text-text-2 group-hover:bg-accent group-hover:text-accent-fg",
          )}
        >
          {stale
            ? "Earlier"
            : done
              ? action.type === "copy"
                ? "Copied"
                : action.type === "send_email"
                  ? "Sent"
                  : "Done"
              : status === "running"
                ? "Working…"
                : status === "failed"
                  ? "Try again"
                  : action.type === "copy"
                    ? "Copy"
                    : action.type === "open"
                      ? "Open"
                      : action.type === "send_email"
                        ? "Review"
                        : "Do it"}
        </span>
      </button>
    </li>
  );
}

/**
 * The email the assistant wrote, in full and editable, before anything goes out. Send goes from the person's own
 * Gmail through the app's normal send (contact rules, the daily cap, the touch logged); without Gmail it opens there.
 */
function EmailReview({
  action,
  gmailConnected,
  onClose,
  onSent,
}: {
  action: Extract<ShownAction, { type: "send_email" }>;
  gmailConnected: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const call = useCall();
  const [subject, setSubject] = useState(action.subject);
  const [body, setBody] = useState(action.body);
  const [busy, setBusy] = useState(false);
  const to = action.to ?? "";
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Email ${action.merchant_name ?? "the merchant"}`}
      footer={
        <>
          <a
            className={buttonClass("ghost", "md", "mr-auto")}
            href={gmailComposeHref({ to, subject, body })}
            target="_blank"
            rel="noreferrer"
          >
            Open in Gmail instead
          </a>
          {gmailConnected ? (
            <Button
              variant="primary"
              disabled={busy || !subject.trim() || !body.trim()}
              onClick={async () => {
                setBusy(true);
                const sent = await call(
                  sendEmailAction({ clientId: action.merchant_id, subject, body }),
                  "Sent from your Gmail",
                );
                setBusy(false);
                if (sent) onSent();
              }}
            >
              {busy ? "Sending…" : "Send from my Gmail"}
            </Button>
          ) : (
            <a className={buttonClass("primary", "md")} href="/api/auth/google?purpose=gmail">
              Connect Gmail to send
            </a>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="To">
          <Input value={to} readOnly />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message">
          <Textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">
          Written by the assistant. Read it, change anything, and send it yourself.
        </p>
      </div>
    </Dialog>
  );
}

/** The person's words. A long brief sent for them shows its short name, with the brief one click away. */
function UserBubble({ text, label }: { text: string; label?: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > 220;
  return (
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[14px] leading-relaxed text-text">
      {label && !full ? (
        <p className="font-medium">{label}</p>
      ) : (
        <p className={cn("whitespace-pre-wrap", long && !full && "line-clamp-3")}>{text}</p>
      )}
      {label || long ? (
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="mt-1 text-[12px] font-medium text-muted transition hover:text-text"
        >
          {full ? "Show less" : label ? "Show the brief" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

function Orb({ size = 28, live }: { size?: number; live?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "bg-brand relative inline-flex shrink-0 items-center justify-center rounded-full shadow-glow",
        live && "animate-breathe",
      )}
    >
      <Glyph name="sparkles" className="size-[55%] text-white" strokeWidth={2} />
    </span>
  );
}

/**
 * The assistant: Claude Opus 5.5 reading this CRM for the person and setting up actions they run with one click.
 * One sheet for the whole app (⌘J), opened from the sidebar, the phone bar, the command palette, or a
 * recommendation ("Plan it").
 */
export function AssistantProvider({
  state,
  children,
}: {
  /** Whether it can run: the key, the switch in Settings, today's budget. */
  state: AssistantState;
  children: ReactNode;
}) {
  const router = useRouter();
  const call = useCall();
  const toast = useToast();
  const { nowMs, today, gmailConnected } = useApp();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [reviewing, setReviewing] = useState<Extract<ShownAction, { type: "send_email" }> | null>(
    null,
  );
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const pending = useRef<{ prompt: string; label?: string } | null>(null);

  const patchLast = useCallback(
    (fn: (a: Extract<Item, { kind: "assistant" }>) => Extract<Item, { kind: "assistant" }>) =>
      setItems((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.kind !== "assistant") return cur;
        return [...cur.slice(0, -1), fn(last)];
      }),
    [],
  );

  /** A new question (text), or null to keep going with the answer that was handed back unfinished. */
  const run = useCallback(
    async (text: string | null, label?: string) => {
      const message = text === null ? null : text.trim();
      if (message === "" || busy) return;
      setBusy(true);
      setView("chat");
      if (message !== null) {
        setDraft("");
        setItems((cur) => [
          ...cur,
          { kind: "user", text: message, label },
          { kind: "assistant", text: "", actions: [], tools: [], streaming: true },
        ]);
      } else {
        patchLast((a) => ({ ...a, streaming: true, canContinue: false, notice: undefined }));
      }
      const controller = new AbortController();
      abort.current = controller;
      let thread = threadId;
      let next: string | null = message;
      // the text this request streamed, and where the current model call's text began: a call the server stops
      // (the time limit, an unreadable tool input) is run again, so its text is taken back out
      let streamed = "";
      let callStart = 0;
      let more = false;
      try {
        // a long turn is handed back after ~30 s (a hosted request has 60); carry on a few times without asking
        for (let round = 0; round < 5; round++) {
          callStart = streamed.length;
          const res = await fetch("/api/assistant", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: thread, message: next, title: label ?? null }),
            signal: controller.signal,
          });
          // a redirect to the login page (the session ended) answers 200 with a web page: say so in words
          if (res.redirected || res.status === 401)
            throw new Error("Your session ended. Sign in again.");
          if (!res.ok || !res.body) {
            const err = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(err?.error ?? "The assistant could not be reached");
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          more = false;
          let finished = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf("\n");
            while (nl >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf("\n");
              if (!line) continue;
              const e = JSON.parse(line) as
                | { t: "thread"; id: string }
                | { t: "text"; d: string }
                | { t: "tool"; name: string; label: string }
                | { t: "actions"; actions: ShownAction[] }
                | { t: "notice"; message: string }
                | { t: "discard" }
                | { t: "done"; threadId: string; more: boolean }
                | { t: "error"; message: string };
              if (e.t === "thread") {
                thread = e.id;
                setThreadId(e.id);
              } else if (e.t === "text") {
                streamed += e.d;
                patchLast((a) => ({
                  ...a,
                  text: a.text + e.d,
                  tools: a.tools.map((t) => ({ ...t, done: true })),
                }));
              } else if (e.t === "tool") {
                if (streamed && !streamed.endsWith("\n\n")) streamed += "\n\n";
                callStart = streamed.length;
                patchLast((a) => ({
                  ...a,
                  // an answer written before a tool call is a progress note; keep it, start the rest on a new line
                  text: a.text && !a.text.endsWith("\n\n") ? `${a.text}\n\n` : a.text,
                  tools: [
                    ...a.tools.map((t) => ({ ...t, done: true })),
                    { label: e.label, done: false },
                  ],
                }));
              } else if (e.t === "actions") {
                patchLast((a) => ({ ...a, actions: [...a.actions, ...e.actions] }));
              } else if (e.t === "notice") {
                patchLast((a) => ({ ...a, notice: e.message }));
              } else if (e.t === "discard") {
                const cut = streamed.length - callStart;
                streamed = streamed.slice(0, callStart);
                if (cut > 0)
                  patchLast((a) => ({
                    ...a,
                    text: a.text.slice(0, Math.max(0, a.text.length - cut)),
                  }));
              } else if (e.t === "error") {
                patchLast((a) => ({ ...a, error: e.message }));
                finished = true;
              } else if (e.t === "done") {
                more = e.more;
                finished = true;
              }
            }
          }
          if (!finished)
            throw new Error("The answer was cut off. Ask again to pick up where it stopped.");
          if (!more) break;
          next = null;
        }
      } catch (err) {
        if (!controller.signal.aborted)
          patchLast((a) => ({
            ...a,
            error: err instanceof Error ? err.message : "The assistant could not be reached",
          }));
      } finally {
        const stopped = controller.signal.aborted;
        patchLast((a) => ({
          ...a,
          streaming: false,
          tools: a.tools.map((t) => ({ ...t, done: true })),
          // still unfinished after the automatic continues: the person decides whether it carries on
          canContinue: !stopped && more && !a.error,
          notice: stopped
            ? "Stopped."
            : more && !a.error
              ? "This one is taking a while. Keep going to let it finish."
              : a.notice,
        }));
        abort.current = null;
        setBusy(false);
        router.refresh();
      }
    },
    [busy, patchLast, router, threadId],
  );
  const send = useCallback((text: string, label?: string) => run(text, label), [run]);

  const reset = useCallback(() => {
    abort.current?.abort();
    setThreadId(null);
    setItems([]);
    setStatus({});
    setView("chat");
  }, []);

  /** What the assistant prepared in the background: its buttons stay live unless the merchant has moved on since (then they show as earlier). */
  const openPrepared = useCallback(
    async (prepId: string) => {
      const r = await call(openPreparedAction({ id: prepId }));
      if (!r) return;
      setThreadId(r.threadId);
      setStatus({});
      setItems(
        r.items.map((i: ShownItem): Item =>
          i.role === "user"
            ? { kind: "user", text: i.text, label: "Prepared for you" }
            : {
                kind: "assistant",
                text: i.text,
                actions: i.actions,
                tools: [],
                streaming: false,
                earlier: r.stale,
              },
        ),
      );
      setView("chat");
      router.refresh();
    },
    [call, router],
  );

  const show = useCallback(
    (o: OpenOptions = {}) => {
      // a fresh ask stops whatever is still streaming, so it never lands in the old conversation
      if (o.fresh || o.prepId) reset();
      setOpen(true);
      setRecs(null);
      if (o.prepId) void openPrepared(o.prepId);
      void loadRecommendationsAction()
        .then((r) => setRecs(r.ok ? r.data : []))
        .catch(() => setRecs([]));
      if (o.prompt) {
        if (o.send && state.ready) pending.current = { prompt: o.prompt, label: o.label };
        else setDraft(o.prompt);
      }
    },
    [reset, state.ready, openPrepared],
  );

  // a prompt handed over by open({ send: true }) goes out once the sheet has rendered (after a reset, if any)
  useEffect(() => {
    if (!open || !pending.current || busy) return;
    const p = pending.current;
    pending.current = null;
    void send(p.prompt, p.label);
  }, [open, busy, send]);

  // ⌘J / Ctrl+J anywhere; the shell's buttons ask with an event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        show();
      }
    };
    const onAsk = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener("crm:assistant", onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crm:assistant", onAsk);
    };
  }, [show]);

  // keep the newest words in view while they stream, unless the person scrolled up to read
  useEffect(() => {
    const el = scroller.current?.closest("[data-drawer-body]") ?? null;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [items]);

  async function runAction(a: ShownAction) {
    if (a.type === "open") {
      setOpen(false);
      router.push(a.href);
      return;
    }
    if (a.type === "send_email") {
      setReviewing(a);
      return;
    }
    setStatus((s) => ({ ...s, [a.id]: "running" }));
    let ok = false;
    if (a.type === "copy") {
      try {
        await navigator.clipboard.writeText(a.text);
        ok = true;
        toast({ message: "Copied", tone: "success" });
      } catch {
        toast({ message: "Couldn't copy: select the text and copy it instead", tone: "error" });
      }
    } else if (a.type === "hand_off") {
      ok =
        (await call(
          handOffAction({ clientId: a.merchant_id }),
          `${a.merchant_name} handed off`,
        )) !== null;
    } else if (a.type === "set_follow_up") {
      ok =
        (await call(
          setFollowUpAction({ clientId: a.merchant_id, dueOn: a.date }),
          "Follow-up set",
        )) !== null;
    } else if (a.type === "add_note") {
      ok =
        (await call(addNoteAction({ clientId: a.merchant_id, body: a.note }), "Note added")) !==
        null;
    } else if (a.type === "pause") {
      ok =
        (await call(
          pauseEnrollmentAction({ clientIds: [a.merchant_id], paused: true, until: a.until }),
          "Paused",
        )) !== null;
    } else if (a.type === "move_to_bucket") {
      ok =
        (await call(
          moveMerchantsToBucketAction({ clientIds: [a.merchant_id], bucketId: a.bucket_id }),
          `Moved to ${a.bucket_name}`,
        )) !== null;
    }
    setStatus((s) => ({ ...s, [a.id]: ok ? "done" : "failed" }));
    if (ok && a.type !== "copy") router.refresh();
  }

  async function openHistory() {
    setView("history");
    setThreads(null);
    const r = await call(listThreadsAction());
    setThreads(r ?? []);
  }

  async function openThread(t: ThreadSummary) {
    // an answer still streaming would write into the conversation opened under it
    if (busy) return;
    const r = await call(loadThreadAction({ id: t.id }));
    if (!r) return;
    setThreadId(t.id);
    setStatus({});
    setItems(
      r.map((i: ShownItem): Item =>
        i.role === "user"
          ? { kind: "user", text: i.text }
          : {
              kind: "assistant",
              text: i.text,
              actions: i.actions,
              tools: [],
              streaming: false,
              earlier: true,
            },
      ),
    );
    setView("chat");
  }

  async function removeThread(t: ThreadSummary) {
    if (!(await call(deleteThreadAction({ id: t.id })))) return;
    setThreads((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    if (threadId === t.id) reset();
  }

  const empty = items.length === 0;

  return (
    <AssistantContext.Provider value={show}>
      {children}
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        wide
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <span className="live-dot text-accent" /> Claude Opus 5.5
          </span>
        }
        title="Assistant"
        subtitle="Reads your merchants, plans the work, and sets up the steps. Nothing happens until you click."
        headerAside={
          <>
            <IconButton
              label="Past conversations"
              onClick={() => void openHistory()}
              disabled={busy}
            >
              <Glyph name="clock" className="size-4" />
            </IconButton>
            <IconButton label="New conversation" onClick={reset} disabled={busy}>
              <Glyph name="plus" className="size-4" />
            </IconButton>
          </>
        }
        footer={
          view === "chat" ? (
            <form
              className="w-full"
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              {!state.ready ? (
                <p className="mb-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                  {state.reason}. The recommendations still work: open them to do the steps by hand.
                </p>
              ) : null}
              <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-3 p-1.5 pl-3 shadow-[inset_0_1px_2px_var(--shadow-c1)] transition focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
                <textarea
                  ref={input}
                  aria-label="Ask the assistant"
                  autoFocus
                  value={draft}
                  rows={1}
                  disabled={!state.ready}
                  placeholder={
                    state.ready
                      ? "Ask about a merchant, your day, a bucket, an email to write…"
                      : "Not available"
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send(draft);
                    }
                  }}
                  className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] text-text outline-none! [field-sizing:content] placeholder:text-muted disabled:cursor-not-allowed"
                />
                {busy ? (
                  <button
                    type="button"
                    aria-label="Stop"
                    onClick={() => abort.current?.abort()}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text transition hover:bg-border active:scale-95"
                  >
                    <span className="size-3 rounded-[3px] bg-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label="Send"
                    disabled={!state.ready || !draft.trim()}
                    className="bg-brand inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white shadow-glow transition hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
                  >
                    <Glyph name="send" className="size-4" strokeWidth={2} />
                  </button>
                )}
              </div>
              <p className="mt-1.5 hidden items-center gap-1.5 px-1 text-[11px] text-muted sm:flex">
                <Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line,{" "}
                <Kbd>⌘J</Kbd> opens this anywhere
              </p>
            </form>
          ) : undefined
        }
      >
        <div ref={scroller}>
          {view === "history" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="eyebrow">Past conversations</p>
                <button
                  type="button"
                  onClick={() => setView("chat")}
                  className="text-[13px] font-medium text-accent hover:text-accent-strong"
                >
                  Back
                </button>
              </div>
              {threads === null ? (
                <div className="space-y-2" aria-busy>
                  <Skeleton className="h-12 w-full rounded-xl" />
                  <Skeleton className="h-12 w-full rounded-xl" />
                </div>
              ) : threads.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">No conversations yet.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
                  {threads.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 pr-2">
                      <button
                        type="button"
                        onClick={() => void openThread(t)}
                        className="min-w-0 flex-1 px-4 py-3 text-left transition hover:bg-surface-2/50"
                      >
                        <span className="block truncate text-[13.5px] font-medium">
                          {t.title || "Untitled"}
                        </span>
                        <span className="block text-[12px] text-muted">
                          {timeAgo(t.updated_at, new Date(nowMs))}
                        </span>
                      </button>
                      <IconButton
                        label={`Delete "${t.title || "Untitled"}"`}
                        onClick={() => void removeThread(t)}
                      >
                        <Glyph name="trash" className="size-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : empty ? (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <Orb size={44} />
                <div>
                  <p className="text-[17px] font-semibold tracking-tight">
                    What should we work on?
                  </p>
                  <p className="text-[13px] text-muted">
                    Pick a recommendation, plan the day, or ask anything about your merchants.
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={!state.ready || busy}
                onClick={() => void send(PLAN_MY_DAY, "Plan my day")}
                className="ring-brand bg-brand-soft flex w-full items-center gap-3 rounded-2xl border border-border px-4 py-3.5 text-left transition duration-150 hover:border-accent/50 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Glyph name="target" className="size-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">Plan my day</span>
                  <span className="block text-[12.5px] text-muted">
                    An ordered plan from your call list, replies and files that are nearly done.
                  </span>
                </span>
                <Glyph name="arrowRight" className="size-4 text-muted" />
              </button>
              <section className="space-y-2.5">
                <p className="eyebrow">Recommended now</p>
                {recs === null ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-busy>
                    <Skeleton className="h-28 w-full rounded-2xl" />
                    <Skeleton className="h-28 w-full rounded-2xl" />
                  </div>
                ) : recs.length === 0 ? (
                  <p className="text-[13px] text-muted">Nothing needs you right now.</p>
                ) : (
                  <RecommendationCards
                    compact
                    items={recs}
                    ready={state.ready && !busy}
                    onPlan={(r) => void send(r.prompt, r.title)}
                  />
                )}
              </section>
              <section className="space-y-2.5">
                <p className="eyebrow">Or ask</p>
                <div className="flex flex-wrap gap-2">
                  {STARTERS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      disabled={!state.ready || busy}
                      onClick={() => void send(s.prompt, s.label)}
                      className="h-10 rounded-full border border-border bg-surface px-3.5 text-[13px] font-medium text-text-2 transition duration-150 hover:border-accent/50 hover:text-text active:scale-[0.97] disabled:opacity-50 sm:h-9"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <ol className="space-y-5" aria-live="polite">
              {items.map((it, i) =>
                it.kind === "user" ? (
                  <li key={i} className="flex justify-end">
                    <UserBubble text={it.text} label={it.label} />
                  </li>
                ) : (
                  <li key={i} className="flex gap-3">
                    <Orb live={it.streaming} />
                    <div className="min-w-0 flex-1 space-y-3 pt-0.5">
                      {it.tools.length > 0 ? (
                        <ul className="flex flex-wrap gap-1.5">
                          {it.tools.map((t, ti) => (
                            <li
                              key={ti}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px]",
                                t.done ? "text-muted" : "text-text-2",
                              )}
                            >
                              {t.done ? (
                                <Glyph
                                  name="check"
                                  className="size-3 text-good"
                                  strokeWidth={2.2}
                                />
                              ) : (
                                <span className="size-3 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
                              )}
                              {t.label}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {it.text ? (
                        <Markdown text={it.text} />
                      ) : it.streaming && it.tools.length === 0 ? (
                        <p className="inline-flex items-center gap-2 text-[13px] text-muted">
                          <span className="size-3 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
                          Thinking
                        </p>
                      ) : null}
                      {it.actions.length > 0 ? (
                        <div className="space-y-2">
                          <p className="eyebrow">I can do these for you</p>
                          <ul className="space-y-2">
                            {it.actions.map((a) => (
                              <ActionCard
                                key={a.id}
                                action={a}
                                status={status[a.id] ?? "idle"}
                                onRun={() => void runAction(a)}
                                today={today}
                                earlier={it.earlier}
                              />
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {it.notice ? <p className="text-[12.5px] text-muted">{it.notice}</p> : null}
                      {it.canContinue && !busy && i === items.length - 1 ? (
                        <Button variant="secondary" size="sm" onClick={() => void run(null)}>
                          <Glyph name="sparkles" className="size-3.5 text-accent" />
                          Keep going
                        </Button>
                      ) : null}
                      {it.error ? (
                        <p className="rounded-xl border border-bad/25 bg-bad-soft px-3 py-2 text-[13px] text-bad">
                          {it.error}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ),
              )}
            </ol>
          )}
        </div>
      </Drawer>
      {reviewing ? (
        <EmailReview
          action={reviewing}
          gmailConnected={gmailConnected}
          onClose={() => setReviewing(null)}
          onSent={() => {
            setStatus((st) => ({ ...st, [reviewing.id]: "done" }));
            setReviewing(null);
            router.refresh();
          }}
        />
      ) : null}
    </AssistantContext.Provider>
  );
}

/** Ask the assistant panel (mounted once in the layout) to open. */
export const openAssistant = () => window.dispatchEvent(new Event("crm:assistant"));
