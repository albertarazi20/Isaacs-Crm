"use client";

import { useState } from "react";
import { sendEmailAction } from "@/app/actions";
import type { ClientDetail } from "@/lib/data/types";
import { applicationEmail } from "@/lib/leads/applicationEmail";
import type { MerchantApplication } from "@/lib/leads/application";
import { applyLink } from "@/lib/docs/applyLink";
import { formatDate } from "@/lib/format";
import { contactAllowed } from "@/lib/mca/contact";
import { suggestAfterEmail } from "@/lib/mca/touch";
import type { ISODate } from "@/lib/mca/dates";
import { appendSignature, effectiveSignature } from "@/lib/messaging/merge";
import { useApp } from "../app-context";
import { Dialog, NETWORK_ERROR, useCall, useToast } from "../overlay";
import { TimerPicker } from "../TimerPicker";
import { Badge, Button, buttonClass, Field, Input, Textarea } from "../ui";
import { useMessagingContext } from "../messaging/useMessagingContext";
import { Icon } from "./icons";
import { dateInTz } from "./logic";
import { copyText, Muted, Panel } from "./parts";

/**
 * The merchant's application (plan §13.5): the link to copy or send, and the latest signed one with its PDF.
 * The merchant opens `/apply/<token>` with no sign-in, fills it in and signs; the PDF lands in Documents.
 */
export function ApplicationCard({
  card,
  application,
  appUrl,
  className,
}: {
  card: ClientDetail["card"];
  application: MerchantApplication;
  appUrl: string;
  className?: string;
}) {
  const toast = useToast();
  const { today, timezone } = useApp();
  const [emailOpen, setEmailOpen] = useState(false);
  const link = applyLink(appUrl, application.token);
  const signed = application.latest;
  const emailOk = contactAllowed(card.contact_status ?? "ok", "email");
  const noEmail = card.email.trim() === "";
  const emailWhy = !emailOk.ok ? emailOk.reason : noEmail ? "No email address on file" : undefined;

  async function copy() {
    const ok = await copyText(link);
    toast(
      ok
        ? { message: "Application link copied", tone: "success" }
        : { message: "Couldn't copy. Select the link and press Ctrl+C", tone: "error" },
    );
  }

  return (
    <Panel
      title="Application"
      icon="note"
      className={className}
      aside={
        <Badge tone={signed ? "good" : "neutral"}>{signed ? "Signed" : "Not signed yet"}</Badge>
      }
    >
      <div className="space-y-3">
        {signed ? (
          <div className="space-y-2 rounded-xl bg-good-soft px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="min-w-0 text-[13px] text-good wrap-anywhere">
                <span className="font-semibold">Application signed</span>{" "}
                {formatDate(dateInTz(signed.signed_at, timezone), today)} · signed by{" "}
                <span className="font-medium">{signed.signer_name}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {signed.document_id ? (
                <a
                  href={`/api/docs/${signed.document_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("secondary", "sm")}
                >
                  <Icon name="file" className="text-muted" />
                  Open signed PDF
                </a>
              ) : (
                <span className="text-xs text-muted">The PDF was deleted</span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            Send the link below and the signed application lands in Documents.
          </p>
        )}
        <Field label="Application link">
          <div className="flex flex-col gap-2">
            <Input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 font-mono text-xs"
            />
            <span className="flex gap-2">
              <Button size="sm" onClick={() => void copy()} className="flex-1">
                <Icon name="copy" className="size-3.5 text-muted" />
                Copy link
              </Button>
              <Button
                size="sm"
                onClick={() => setEmailOpen(true)}
                disabled={Boolean(emailWhy)}
                title={emailWhy}
                className="flex-1"
              >
                <Icon name="send" className="size-3.5 text-muted" />
                Email link
              </Button>
            </span>
          </div>
        </Field>
        <Muted>
          The merchant fills it in and signs on their phone, no sign-in. You get an alert when it is
          signed.
        </Muted>
      </div>
      {emailOpen ? (
        <EmailLinkDialog card={card} link={link} onClose={() => setEmailOpen(false)} />
      ) : null}
    </Panel>
  );
}

/** The existing Email flow's send (`sendEmailAction`, from the rep's own Gmail) with the link already in the note. */
function EmailLinkDialog({
  card,
  link,
  onClose,
}: {
  card: ClientDetail["card"];
  link: string;
  onClose: () => void;
}) {
  const { today, senderName, gmailConnected, gmailNeedsReconnect } = useApp();
  const call = useCall();
  const toast = useToast();
  const start = applicationEmail({
    contactName: card.contact_name,
    businessName: card.business_name,
    link,
  });
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [next, setNext] = useState<ISODate>(() => suggestAfterEmail(today, card.stage));
  const [busy, setBusy] = useState(false);
  const [reconnect, setReconnect] = useState(gmailNeedsReconnect);
  const ctx = useMessagingContext(card.id);
  const signature = effectiveSignature(ctx?.signature ?? "", senderName);
  const loading = ctx === null;
  const missingLink = !body.includes(link);

  async function send() {
    setBusy(true);
    let res: Awaited<ReturnType<typeof sendEmailAction>>;
    try {
      res = await sendEmailAction({
        clientId: card.id,
        subject,
        body: appendSignature(body, signature),
        nextDueOn: next,
      });
    } catch {
      return toast({ message: NETWORK_ERROR, tone: "error" });
    } finally {
      setBusy(false);
    }
    if (!res.ok && res.reconnect) setReconnect(true);
    const sent = await call(
      Promise.resolve(res),
      `Application link sent. Next follow-up ${formatDate(next, today)}`,
    );
    if (sent) onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={`Email the application to ${card.contact_name || card.business_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {gmailConnected && !reconnect ? (
            <Button
              variant="primary"
              disabled={busy || loading || subject.trim() === "" || missingLink}
              title={
                loading
                  ? "Loading your signature…"
                  : missingLink
                    ? "The application link has to stay in the note"
                    : undefined
              }
              onClick={() => void send()}
            >
              {busy ? "Sending…" : "Send from my Gmail"}
            </Button>
          ) : (
            <a className={buttonClass("primary", "md")} href="/api/auth/google?purpose=mail">
              {reconnect ? "Reconnect Gmail" : "Connect Gmail to send"}
            </a>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <Field label="To">
          <Input value={card.email} readOnly />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field
          label="Message"
          hint={missingLink ? "The application link has to stay in the note." : undefined}
        >
          <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="rounded-xl border border-dashed border-border-strong p-3">
          <p className="text-[12px] font-medium text-text-2">
            Signature (added to the end automatically)
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap">{signature}</p>
        </div>
        <Field label="Follow up again" group>
          <TimerPicker value={next} onChange={setNext} today={today} />
        </Field>
        {reconnect ? (
          <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn">
            Gmail needs to be reconnected (Google expired the permission).
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
