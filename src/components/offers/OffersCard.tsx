"use client";

import { useState } from "react";
import { resendOfferNoticeAction, withdrawOfferAction } from "@/app/offer-actions";
import type { OfferRow, OfferState } from "@/lib/offers/queries";
import { exactMoney, paymentsWords, factorWords, offerNumber, timeLeft } from "@/lib/offers/terms";
import { timeAgo } from "@/lib/format";
import { whenWords } from "@/lib/approvals/words";
import { useApp } from "../app-context";
import { ConfirmButton, copyText } from "../client/parts";
import { useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Badge, Button, buttonClass, cn } from "../ui";
import { OfferForm } from "./OfferForm";

const STATE: Record<OfferState, { label: string; tone: "accent" | "good" | "neutral" | "warn" }> = {
  sent: { label: "Waiting on them", tone: "accent" },
  accepted: { label: "Accepted", tone: "good" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
  expired: { label: "Expired", tone: "warn" },
};

const EMAIL_WORDS: Record<string, string> = {
  queued: "email going out",
  sending: "email going out",
  sent: "emailed",
  failed: "email failed",
  cancelled: "email not sent",
  skipped: "email not sent",
};

/** The merchant's offers on their page: make one, see whether they opened it, copy the link, take it back. */
export function OffersCard({
  merchant,
  offers,
  approval,
  className,
}: {
  merchant: {
    id: string;
    name: string;
    email: string;
    timezone?: string;
    emailBlocked?: string | null;
  };
  offers: readonly OfferRow[];
  approval?: { id: string; amountCents: number; holdUntil: string | null; funder: string } | null;
  className?: string;
}) {
  const { nowMs, timezone } = useApp();
  const when = (iso: string) => whenWords(iso, timezone, nowMs);
  const call = useCall();
  const toast = useToast();
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const now = new Date(nowMs);
  // the offer page is on this same site: the CRM's own address is the merchant's too
  const link = (o: OfferRow) => `${window.location.origin}/offer/${o.token}`;

  async function withdraw(o: OfferRow) {
    setBusy(o.id);
    await call(withdrawOfferAction({ offerId: o.id, clientId: merchant.id }), "Offer withdrawn");
    setBusy(null);
  }
  async function resend(o: OfferRow) {
    setBusy(o.id);
    const r = await call(resendOfferNoticeAction({ offerId: o.id, clientId: merchant.id }));
    setBusy(null);
    if (r)
      toast({
        message: r.sent ? "Sent to your email, documents attached" : (r.error ?? "It didn't send"),
        tone: r.sent ? "success" : "error",
      });
  }
  async function copy(o: OfferRow) {
    const ok = await copyText(link(o));
    toast({ message: ok ? "Offer link copied" : link(o), tone: ok ? "success" : "info" });
  }

  return (
    <section
      aria-label="Offers"
      className={cn("rounded-2xl border border-border bg-surface", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Offers</p>
          <p className="text-xs text-muted">
            {offers.length === 0
              ? "Write the terms and they get a page to review and accept, with the documents it needs."
              : `${offers.length} made · the newest first`}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setMaking(true)}>
          <Glyph name="sparkles" className="size-4" />
          Generate merchant offer
        </Button>
      </div>
      {offers.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {offers.map((o) => {
            // a sent offer they have opened says so in the badge: the first thing a rep looks for
            const st =
              o.state === "sent" && o.views > 0
                ? { label: "Opened", tone: "accent" as const }
                : STATE[o.state];
            const left = o.state === "sent" ? timeLeft(o.expires_at, nowMs) : null;
            return (
              <li
                key={o.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold tabular-nums">
                      {exactMoney(o.funded_cents)}
                    </span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <span className="text-[11.5px] text-muted tabular-nums">
                      No. {offerNumber(o.id, o.created_at)}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {`${paymentsWords(o.payments, o.frequency)} of ${exactMoney(o.payment_cents)} · factor ${factorWords(o.factor_rate)} · payback ${exactMoney(o.payback_cents)}`}
                  </p>
                  {/* did they open it: the first thing a rep wants to know */}
                  <p
                    className={cn(
                      "mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px]",
                      o.views > 0 ? "font-medium text-accent" : "text-muted",
                    )}
                  >
                    <Glyph name={o.views > 0 ? "eye" : "clock"} className="size-3.5" />
                    {o.views > 0 && o.first_viewed_at && o.last_viewed_at
                      ? `Opened ${o.views === 1 ? "once" : `${o.views} times`} · first ${timeAgo(o.first_viewed_at, now)}${o.views > 1 ? ` · last ${timeAgo(o.last_viewed_at, now)}` : ""}`
                      : o.state === "sent"
                        ? "Not opened yet"
                        : "Never opened"}
                  </p>
                  <p className="text-xs text-muted">
                    {[
                      o.state === "accepted" && o.accepted_at
                        ? `Accepted ${when(o.accepted_at)}${o.accepted_name ? ` as ${o.accepted_name}` : ""}`
                        : "",
                      left ? `${left} left` : "",
                      o.email_status
                        ? (EMAIL_WORDS[o.email_status] ?? o.email_status)
                        : "link only",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {o.state === "accepted" ? (
                    o.accept_notified_at ? (
                      <p className="text-xs text-muted">
                        Your copy with the documents went to your email {when(o.accept_notified_at)}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-warn">
                        Your copy didn&apos;t send
                        {o.accept_notice_error ? `: ${o.accept_notice_error}` : ""}
                      </p>
                    )
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void copy(o)}
                    aria-label={`Copy the link to the ${exactMoney(o.funded_cents)} offer`}
                  >
                    <Glyph name="copy" className="size-3.5" />
                    Copy link
                  </Button>
                  <a
                    href={`/offer/${o.token}`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClass("ghost", "sm")}
                  >
                    Preview
                  </a>
                  {o.state === "accepted" && !o.accept_notified_at ? (
                    <Button size="sm" disabled={busy === o.id} onClick={() => void resend(o)}>
                      <Glyph name="mail" className="size-3.5" />
                      Email me the documents
                    </Button>
                  ) : null}
                  {o.state === "sent" ? (
                    <ConfirmButton
                      size="sm"
                      label="Withdraw"
                      confirmLabel="Withdraw it: the link stops"
                      busy={busy === o.id}
                      onConfirm={() => void withdraw(o)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {making ? (
        <OfferForm merchant={merchant} approval={approval} onClose={() => setMaking(false)} />
      ) : null}
    </section>
  );
}
