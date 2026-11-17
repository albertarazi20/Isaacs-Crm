"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { logTouchAction, sendEmailAction } from "@/app/actions";
import type { ISODate } from "@/lib/mca/dates";
import { formatDate } from "@/lib/format";
import { emailBody, emailSubject, textTemplate } from "@/lib/mca/templates";
import {
  gmailComposeHref,
  normalizeUS,
  phoneProblem,
  smsHref,
  telHref,
  voiceCallHref,
  voiceTextHref,
} from "@/lib/mca/phone";
import {
  OUTCOMES_BY_KIND,
  outcomeLabel,
  suggestAfterEmail,
  suggestNextFollowUp,
  type TouchKind,
  type TouchOutcome,
} from "@/lib/mca/touch";
import {
  CONTACT_STATUS_LABELS,
  contactAllowed,
  quietHours,
  type ContactStatus,
} from "@/lib/mca/contact";
import type { StageKey } from "@/lib/mca/stages";
import { useApp } from "./app-context";
import { Icon } from "./client/icons";
import { Dialog, useCall, useToast } from "./overlay";
import { TimerPicker } from "./TimerPicker";
import { Badge, Button, buttonClass, cn, Field, Input, Textarea } from "./ui";
import { HintChips } from "./messaging/HintChips";
import { SnippetPicker, type PickedSnippet } from "./messaging/SnippetPicker";
import { useMessagingContext } from "./messaging/useMessagingContext";
import { recordTextSent, useTextCount } from "./messaging/useTextCount";
import {
  appendSignature,
  describeLeftovers,
  effectiveSignature,
  leftoverFields,
  mergeValues,
} from "@/lib/messaging/merge";
import { textCountWarning } from "@/lib/messaging/textCounter";

export interface ContactTarget {
  id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  stage: StageKey;
  /** Where the merchant is — for quiet-hours warnings. Free text ("TX", "Texas"); unknown means no warning. */
  state?: string;
  contact_status?: ContactStatus;
}

const PENDING_KEY = "isaac:pending-touch";
const PENDING_EVENT = "isaac:pending-touch";
const PENDING_MAX_AGE_MS = 6 * 3_600_000;

interface PendingTouch {
  clientId: string;
  stage: StageKey;
  name: string;
  kind: TouchKind;
  at: number;
}

function setPending(p: PendingTouch): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* private mode: the in-memory event below still opens the prompt */
  }
  window.dispatchEvent(new CustomEvent<PendingTouch>(PENDING_EVENT, { detail: p }));
}

function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing stored */
  }
}

function readPending(): PendingTouch | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingTouch;
    return Date.now() - p.at < PENDING_MAX_AGE_MS ? p : null;
  } catch {
    return null;
  }
}

const isTouchDevice = () => window.matchMedia("(pointer: coarse)").matches;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Call / Text / Email for one client. Every use ends in the one-tap outcome prompt, so the timer never goes stale. */
export function ContactActions({
  client,
  size = "sm",
  suggestedText,
  explain,
}: {
  client: ContactTarget;
  size?: "sm" | "md";
  /** A ready-made message for the Text dialog to start from (win-back uses a reason-aware one). */
  suggestedText?: string;
  /**
   * Say in words, under the buttons, why Call and Text are greyed out for a phone number that cannot
   * be dialed. "touch" shows it on phones only (no tooltips there; cards stay as tall as before on a
   * desktop). The reason is always in the buttons' tooltip too.
   */
  explain?: "always" | "touch";
}) {
  const { senderName } = useApp();
  const toast = useToast();
  const whyId = useId();
  const [textOpen, setTextOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const e164 = normalizeUS(client.phone);
  const phoneWhy = phoneProblem(client.phone);
  const status = client.contact_status ?? "ok";
  const callOk = contactAllowed(status, "call");
  const textOk = contactAllowed(status, "text");
  const emailOk = contactAllowed(status, "email");

  function call() {
    if (!e164)
      return toast({ message: "No valid phone number on file for this client", tone: "error" });
    const quiet = quietHours(client.state ?? "");
    if (quiet) {
      toast({
        message: `It's ${quiet.localTime} where ${client.business_name} is — a call now may not be welcome`,
      });
    }
    if (isTouchDevice()) {
      window.location.href = telHref(e164);
    } else {
      void copy(e164);
      window.open(voiceCallHref(e164), "_blank", "noopener");
      toast({ message: `${e164} copied — paste it into Google Voice if it doesn't dial` });
    }
    setPending({
      clientId: client.id,
      stage: client.stage,
      name: client.business_name,
      kind: "call",
      at: Date.now(),
    });
  }

  // A blocked contact status wins: that is the reason that matters. Otherwise say what is wrong with the number.
  const callWhy = callOk.ok ? phoneWhy : callOk.reason;
  const textWhy = textOk.ok ? phoneWhy : textOk.reason;
  const showWhy = explain !== undefined && phoneWhy !== null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size={size}
        variant="secondary"
        onClick={call}
        aria-label={`Call ${client.business_name}`}
        aria-describedby={showWhy && !e164 ? whyId : undefined}
        disabled={!e164 || !callOk.ok}
        title={callWhy ?? undefined}
      >
        <Icon name="phone" className="text-muted" />
        Call
      </Button>
      <Button
        size={size}
        variant="secondary"
        onClick={() => setTextOpen(true)}
        aria-label={`Text ${client.business_name}`}
        aria-describedby={showWhy && !e164 ? whyId : undefined}
        disabled={!e164 || !textOk.ok}
        title={textWhy ?? undefined}
      >
        <Icon name="message" className="text-muted" />
        Text
      </Button>
      <Button
        size={size}
        variant="secondary"
        onClick={() => setEmailOpen(true)}
        aria-label={`Email ${client.business_name}`}
        disabled={!emailOk.ok}
        title={emailOk.ok ? undefined : emailOk.reason}
      >
        <Icon name="mail" className="text-muted" />
        Email
      </Button>
      {status !== "ok" ? <Badge tone="bad">{CONTACT_STATUS_LABELS[status]}</Badge> : null}
      {showWhy ? (
        <p
          id={whyId}
          className={cn(
            // w-0 + min-w-full: its own line, but it never widens the buttons' row.
            "w-0 min-w-full text-xs text-warn",
            explain === "touch" && "pointer-fine:hidden",
          )}
        >
          {phoneWhy}
        </p>
      ) : null}
      <TextDialog
        open={textOpen}
        onClose={() => setTextOpen(false)}
        client={client}
        senderName={senderName}
        suggestedText={suggestedText}
      />
      <EmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        client={client}
        senderName={senderName}
      />
    </div>
  );
}

function TextDialog({
  open,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  client: ContactTarget;
  senderName: string;
  suggestedText?: string;
}) {
  // The body mounts fresh on every open, so its state always starts from the template.
  return open ? <TextDialogBody {...rest} /> : null;
}

function TextDialogBody({
  onClose,
  client,
  senderName,
  suggestedText,
}: {
  onClose: () => void;
  client: ContactTarget;
  senderName: string;
  suggestedText?: string;
}) {
  const toast = useToast();
  const { today } = useApp();
  const e164 = normalizeUS(client.phone);
  const quiet = quietHours(client.state ?? "");
  const [message, setMessage] = useState(
    () =>
      suggestedText ??
      textTemplate({
        contactName: client.contact_name,
        businessName: client.business_name,
        stage: client.stage,
        senderName,
      }),
  );
  const ctx = useMessagingContext(client.id);
  const textsToday = useTextCount(today);
  const countWarning = textCountWarning(textsToday);
  if (!e164) return null;
  const values = mergeValues({
    contactName: client.contact_name,
    businessName: client.business_name,
    senderName,
    applicationLink: ctx?.applicationLink ?? "",
    wantedAmountCents: ctx?.wantedAmountCents ?? null,
  });
  const leftover = describeLeftovers(message, {
    applicationLinkSet: Boolean(ctx?.applicationLink),
  });

  // A text can't be called back, so an unfilled {field} blocks sending, exactly as it does for email.
  const blocked = leftoverFields(message).length > 0;
  const blockedReason = "Fill in the highlighted fields first";

  const sent = () => {
    recordTextSent(today);
    setPending({
      clientId: client.id,
      stage: client.stage,
      name: client.business_name,
      kind: "text",
      at: Date.now(),
    });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Text ${client.contact_name || client.business_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={sent}
            disabled={blocked}
            title={blocked ? blockedReason : undefined}
          >
            I sent it →
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {quiet ? (
          <p role="note" className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
            It&apos;s {quiet.localTime} where {client.business_name} is. Texts before 8 AM or after
            9 PM are unwelcome and can be a compliance problem — consider waiting.
          </p>
        ) : null}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="text-message" className="text-[12px] font-medium text-text-2">
              Message
            </label>
            <SnippetPicker
              kind="text"
              ctx={ctx}
              values={values}
              onPick={(p: PickedSnippet) => setMessage(p.body)}
            />
          </div>
          <Textarea
            id="text-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
          />
          {leftover ? (
            <p role="alert" className="rounded-lg bg-warn-soft p-2 text-sm text-warn">
              {leftover}
            </p>
          ) : null}
        </div>
        {countWarning ? (
          <p role="note" className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
            {countWarning}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {blocked ? (
            <>
              <span
                aria-disabled="true"
                title={blockedReason}
                className={buttonClass("secondary", "md", "pointer-events-none opacity-50")}
              >
                Open in Messages (phone)
              </span>
              <span
                aria-disabled="true"
                title={blockedReason}
                className={buttonClass("secondary", "md", "pointer-events-none opacity-50")}
              >
                Open Google Voice
              </span>
            </>
          ) : (
            <>
              <a className={buttonClass("secondary", "md")} href={smsHref(e164, message)}>
                Open in Messages (phone)
              </a>
              <a
                className={buttonClass("secondary", "md")}
                href={voiceTextHref(e164)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  void copy(message).then(
                    (ok) => ok && toast({ message: "Message copied — paste it into Google Voice" }),
                  );
                }}
              >
                Open Google Voice
              </a>
            </>
          )}
          <Button
            onClick={() =>
              void copy(e164).then((ok) =>
                toast({
                  message: ok ? `${e164} copied` : "Couldn't copy",
                  tone: ok ? "info" : "error",
                }),
              )
            }
          >
            Copy number
          </Button>
        </div>
        <p className="text-xs text-muted">
          Google Voice has no official link for a new text, so the number or message is copied for
          you to paste. When you&apos;re done, tap “I sent it” and log the result.
        </p>
      </div>
    </Dialog>
  );
}

function EmailDialog({
  open,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  client: ContactTarget;
  senderName: string;
}) {
  return open ? <EmailDialogBody {...rest} /> : null;
}

function EmailDialogBody({
  onClose,
  client,
  senderName,
}: {
  onClose: () => void;
  client: ContactTarget;
  senderName: string;
}) {
  const { today, gmailConnected, gmailNeedsReconnect } = useApp();
  const call = useCall();
  const template = {
    contactName: client.contact_name,
    businessName: client.business_name,
    stage: client.stage,
    senderName,
  };
  const [subject, setSubject] = useState(() => emailSubject(template));
  // No "Thanks, Name" at the end of the starting text: the signature below it does that job.
  const [body, setBody] = useState(() => emailBody(template, { signOff: false }));
  const [next, setNext] = useState<ISODate>(() => suggestAfterEmail(today, client.stage));
  const [busy, setBusy] = useState(false);
  const [reconnect, setReconnect] = useState(gmailNeedsReconnect);
  const ctx = useMessagingContext(client.id);
  const to = client.email.trim();
  const values = mergeValues({
    contactName: client.contact_name,
    businessName: client.business_name,
    senderName,
    applicationLink: ctx?.applicationLink ?? "",
    wantedAmountCents: ctx?.wantedAmountCents ?? null,
  });
  const signature = effectiveSignature(ctx?.signature ?? "", senderName);
  // What actually goes out: the message with the signature on the end, once.
  const fullBody = appendSignature(body, signature);
  const leftoverText = `${subject}\n${body}`;
  const leftover = describeLeftovers(leftoverText, {
    applicationLinkSet: Boolean(ctx?.applicationLink),
  });
  // Until the signature has loaded the email would go out with the stand-in one, so wait for it.
  const loading = ctx === null;
  const blocked = loading || leftoverFields(leftoverText).length > 0;
  const blockedReason = loading
    ? "Loading your signature…"
    : "Fill in the highlighted fields first";

  async function send() {
    setBusy(true);
    const res = await sendEmailAction({
      clientId: client.id,
      subject,
      body: fullBody,
      nextDueOn: next,
    });
    setBusy(false);
    if (!res.ok && res.reconnect) setReconnect(true);
    const card = await call(
      Promise.resolve(res),
      `Sent — next follow-up ${formatDate(next, today)}`,
    );
    if (card) onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={`Email ${client.contact_name || client.business_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {to && blocked ? (
            <span
              aria-disabled="true"
              title={blockedReason}
              className={buttonClass("secondary", "md", "pointer-events-none opacity-50")}
            >
              Open in Gmail instead
            </span>
          ) : to ? (
            <a
              className={buttonClass("secondary", "md")}
              href={gmailComposeHref({ to, subject, body: fullBody })}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                setPending({
                  clientId: client.id,
                  stage: client.stage,
                  name: client.business_name,
                  kind: "email",
                  at: Date.now(),
                });
                onClose();
              }}
            >
              Open in Gmail instead
            </a>
          ) : null}
          {gmailConnected && !reconnect ? (
            <Button
              variant="primary"
              disabled={busy || !to || blocked}
              title={blocked ? blockedReason : undefined}
              onClick={() => void send()}
            >
              {busy ? "Sending…" : "Send from my Gmail"}
            </Button>
          ) : (
            <a className={buttonClass("primary", "md")} href="/api/auth/google?purpose=gmail">
              {reconnect ? "Reconnect Gmail" : "Connect Gmail to send"}
            </a>
          )}
        </>
      }
    >
      {to ? (
        <div className="space-y-3">
          <Field label="To">
            <Input value={to} readOnly />
          </Field>
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="email-message" className="text-[12px] font-medium text-text-2">
                Message
              </label>
              <SnippetPicker
                kind="email"
                ctx={ctx}
                values={values}
                onPick={(p: PickedSnippet) => {
                  setBody(p.body);
                  if (p.subject !== null) setSubject(p.subject);
                }}
              />
            </div>
            <Textarea
              id="email-message"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {leftover ? (
              <p role="alert" className="rounded-lg bg-warn-soft p-2 text-sm text-warn">
                {leftover}
              </p>
            ) : null}
          </div>
          <div className="rounded-lg border border-dashed border-border-strong p-3">
            <p className="text-[12px] font-medium text-text-2">
              Signature (added to the end automatically)
            </p>
            <p className="mt-1 text-sm whitespace-pre-wrap" data-testid="email-signature">
              {signature}
            </p>
            <Link className="mt-1 inline-block text-xs text-accent underline" href="/settings">
              Change it in Settings
            </Link>
          </div>
          <Field label="Follow up again">
            <TimerPicker value={next} onChange={setNext} today={today} />
          </Field>
          {reconnect ? (
            <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
              Gmail needs to be reconnected (Google expired the permission). “Open in Gmail instead”
              still works.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm">
          No email address on file.{" "}
          <Link className="text-accent underline" href={`/clients/${client.id}`} onClick={onClose}>
            Add one on the client page
          </Link>
          .
        </p>
      )}
    </Dialog>
  );
}

/** One instance lives in the layout. Opens after any Call/Text/Email and survives a phone reload. */
export function PendingTouchPrompt() {
  const { today } = useApp();
  const call = useCall();
  const [pending, setPendingState] = useState<PendingTouch | null>(null);
  const [outcome, setOutcome] = useState<TouchOutcome | null>(null);
  const [note, setNote] = useState("");
  const [next, setNext] = useState<ISODate>(today);
  const [pickedDate, setPickedDate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const show = (p: PendingTouch | null) => {
      setPendingState(p);
      if (p) {
        setOutcome(null);
        setNote("");
        setPickedDate(false);
        setNext(suggestNextFollowUp(null, today, p.stage));
      }
    };
    show(readPending());
    const onEvent = (e: Event) => show((e as CustomEvent<PendingTouch>).detail);
    const onVisible = () => document.visibilityState === "visible" && show(readPending());
    window.addEventListener(PENDING_EVENT, onEvent);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PENDING_EVENT, onEvent);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [today]);

  function choose(o: TouchOutcome) {
    setOutcome(o);
    if (!pickedDate) setNext(suggestNextFollowUp(o, today, pending?.stage));
  }

  function close() {
    clearPending();
    setPendingState(null);
  }

  async function save() {
    if (!pending) return;
    setBusy(true);
    const card = await call(
      logTouchAction({
        clientId: pending.clientId,
        kind: pending.kind,
        outcome,
        body: note,
        nextDueOn: next,
      }),
      `Logged — next follow-up ${formatDate(next, today)}`,
    );
    setBusy(false);
    if (card) close();
  }

  const verb = pending?.kind === "call" ? "call" : pending?.kind === "text" ? "text" : "email";
  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      title={`How did the ${verb} with ${pending?.name ?? ""} go?`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Skip (don&apos;t log)
          </Button>
          <Button
            variant="primary"
            disabled={busy || (pending?.kind !== "email" && outcome === null)}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Log it"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {pending?.kind !== "email" ? (
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Outcome">
            {(pending ? OUTCOMES_BY_KIND[pending.kind] : []).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={outcome === o}
                onClick={() => choose(o)}
                className={cn(
                  "h-11 rounded-lg border text-sm font-medium transition sm:h-10",
                  outcome === o
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-border bg-surface text-text-2 hover:border-border-strong hover:bg-surface-3 hover:text-text",
                )}
              >
                {outcomeLabel(pending?.kind ?? "call", o)}
              </button>
            ))}
          </div>
        ) : null}
        <Field label="Notes (what he said, what he wants)">
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </Field>
        <HintChips
          note={note}
          today={today}
          stage={pending?.stage}
          selected={pickedDate ? next : null}
          heading="Follow up on"
          onPick={(d) => {
            setNext(d);
            setPickedDate(true);
          }}
        />
        <Field label="Follow up again">
          <TimerPicker
            value={next}
            today={today}
            onChange={(d) => {
              setNext(d);
              setPickedDate(true);
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}
