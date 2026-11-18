"use client";

import { useMemo, useState } from "react";
import { createOfferAction } from "@/app/offer-actions";
import type { MadeOffer } from "@/lib/offers/mutations";
import {
  exactMoney,
  FREQUENCIES,
  FREQUENCY_WORDS,
  OFFER_DOCS,
  OFFER_DOC_WORDS,
  computeTerms,
  offerSchema,
  termWords,
  validThroughWords,
  type Frequency,
  type OfferDoc,
} from "@/lib/offers/terms";
import { copyText } from "../client/parts";
import { Dialog, useCall, useToast } from "../overlay";
import { Glyph } from "../shell/icons";
import { Toggle } from "../settings/Toggle";
import { Button, Field, Input, Select, Textarea, buttonClass, cn } from "../ui";

const pad = (n: number) => String(n).padStart(2, "0");
/** A date-time input's value (the rep's own clock). */
const localValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The hold date at 5 pm when there is one, else two days from now, on the hour. */
function defaultExpiry(holdUntil: string | null | undefined): string {
  if (holdUntil) {
    const d = new Date(`${holdUntil}T17:00:00`);
    if (d.getTime() > Date.now() + 60 * 60_000) return localValue(d);
  }
  const d = new Date(Date.now() + 48 * 3_600_000);
  d.setMinutes(0, 0, 0);
  return localValue(d);
}

const dollars = (s: string): number | null => {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/**
 * Generate a merchant offer: the funding terms, a live preview of what the merchant will see, the documents they
 * upload before accepting, and whether it goes out by email now. Afterwards the link is shown to copy.
 */
export function OfferForm({
  merchant,
  approval,
  onClose,
}: {
  merchant: {
    id: string;
    name: string;
    email: string;
    /** The merchant's own zone, so the rep sees the deadline as the merchant will. */
    timezone?: string;
    /** Why this merchant cannot be emailed (asked not to be, an address that bounced), or null. */
    emailBlocked?: string | null;
  };
  /** Made from an approval: its amount and hold date fill the form. */
  approval?: { id: string; amountCents: number; holdUntil: string | null; funder: string } | null;
  onClose: () => void;
}) {
  const call = useCall();
  const toast = useToast();
  const [funded, setFunded] = useState(approval ? String(approval.amountCents / 100) : "");
  const [factor, setFactor] = useState("1.35");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [payments, setPayments] = useState("26");
  const [expires, setExpires] = useState(() => defaultExpiry(approval?.holdUntil));
  const [docs, setDocs] = useState<ReadonlySet<OfferDoc>>(
    () => new Set<OfferDoc>(["drivers_license", "voided_check"]),
  );
  const [message, setMessage] = useState("");
  const [funder, setFunder] = useState(approval?.funder ?? "");
  const canEmail = merchant.email.trim() !== "" && !merchant.emailBlocked;
  const [send, setSend] = useState(canEmail);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<MadeOffer | null>(null);

  const cents = dollars(funded);
  const rate = /^\d(\.\d{1,3})?$/.test(factor.trim()) ? Number(factor) : null;
  const count = /^\d+$/.test(payments.trim()) ? Number(payments) : null;
  const preview = useMemo(
    () =>
      cents && rate && count && count > 0
        ? computeTerms({ fundedCents: cents, factorRate: rate, payments: count })
        : null,
    [cents, rate, count],
  );
  // the same rules the server applies, said before the button is pressed
  const problem = useMemo(() => {
    const r = offerSchema.safeParse({
      clientId: merchant.id,
      funded,
      factorRate: factor,
      frequency,
      payments,
      expiresAt: expires ? new Date(expires).toISOString() : "",
      funder,
      message,
      docs: [...docs],
      send,
    });
    if (!r.success) return r.error.issues[0]?.message ?? "Check the terms";
    if (docs.size === 0) return "Pick at least one document for them to upload";
    return null;
  }, [merchant.id, funded, factor, frequency, payments, expires, funder, message, docs, send]);
  const theirTime =
    expires && merchant.timezone && !Number.isNaN(new Date(expires).getTime())
      ? validThroughWords(new Date(expires).toISOString(), merchant.timezone)
      : null;

  async function submit() {
    setBusy(true);
    const r = await call(
      createOfferAction({
        clientId: merchant.id,
        approvalId: approval?.id ?? null,
        funded,
        factorRate: factor,
        frequency,
        payments,
        expiresAt: expires ? new Date(expires).toISOString() : "",
        funder,
        message,
        docs: OFFER_DOCS.filter((d) => docs.has(d)),
        send,
      }),
    );
    setBusy(false);
    if (r) setMade(r);
  }

  async function copy(url: string) {
    const ok = await copyText(url);
    toast({ message: ok ? "Offer link copied" : url, tone: ok ? "success" : "info" });
  }

  if (made) {
    const e = made.email;
    const said = !e
      ? "The offer is ready. Send the link your own way: text it, or paste it in an email."
      : e.queued
        ? `It's on its way to ${merchant.email} from your Gmail. You can also send the link yourself.`
        : e.reason === "no_address"
          ? "There's no email address on file, so nothing was emailed. Send the link your own way."
          : e.reason === "opted_out" || e.reason === "suppressed" || e.reason === "dnc"
            ? "This merchant asked not to be emailed, so nothing was sent. Send the link another way only if they agreed to it."
            : "The email didn't go out. Send the link your own way.";
    return (
      <Dialog
        open
        onClose={onClose}
        title="Offer ready"
        footer={
          <>
            <a
              href={made.url}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("ghost", "md", "mr-auto")}
            >
              Preview the page
            </a>
            <Button onClick={() => void copy(made.url)}>
              <Glyph name="copy" className="size-4" />
              Copy link
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-good-soft text-good ring-1 ring-good/25 ring-inset">
            <Glyph name={e?.queued ? "send" : "check"} className="size-5" />
          </span>
          <p className="text-sm text-text-2">{said}</p>
        </div>
        <label className="mt-4 block space-y-1.5">
          <span className="text-[12px] font-medium text-text-2">The merchant&apos;s link</span>
          <Input readOnly value={made.url} onFocus={(ev) => ev.currentTarget.select()} />
        </label>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Generate an offer for ${merchant.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() => void submit()}
          >
            <Glyph name={send ? "send" : "check"} className="size-4" />
            {busy ? "Working…" : send ? "Send the offer" : "Make the offer"}
          </Button>
        </>
      }
    >
      {problem && funded.trim() !== "" ? (
        <p
          role="alert"
          className="mb-4 rounded-2xl border border-warn/30 bg-warn-soft px-4 py-2.5 text-[13px] text-warn"
        >
          {problem}
        </p>
      ) : null}
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Funding amount">
              <Input
                value={funded}
                onChange={(e) => setFunded(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 80,850"
                aria-label="Funding amount"
              />
            </Field>
            <Field label="Factor rate">
              <Input
                value={factor}
                onChange={(e) => setFactor(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 1.35"
                aria-label="Factor rate"
              />
            </Field>
            <Field label="How often">
              <Select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                aria-label="How often"
              >
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_WORDS[f].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Number of payments">
              <Input
                value={payments}
                onChange={(e) => setPayments(e.target.value)}
                inputMode="numeric"
                aria-label="Number of payments"
              />
            </Field>
          </div>
          <Field
            label="Offer valid until"
            hint={
              theirTime
                ? `The merchant sees: ${theirTime}. The page counts down to it, then says the offer has ended.`
                : "Your own clock. The page counts down to it, then says the offer has ended."
            }
          >
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              aria-label="Offer valid until"
            />
          </Field>
          <fieldset>
            <legend className="text-[12px] font-medium text-text-2">
              Documents they upload to accept
            </legend>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {OFFER_DOCS.map((d) => {
                const on = docs.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setDocs((cur) => {
                        const next = new Set(cur);
                        if (on) next.delete(d);
                        else next.add(d);
                        return next;
                      })
                    }
                    className={cn(
                      "h-9 rounded-full border px-3 text-[12.5px] font-medium transition",
                      on
                        ? "border-accent/50 bg-accent-soft text-accent"
                        : "border-border bg-surface text-text-2 hover:border-border-strong",
                    )}
                  >
                    {OFFER_DOC_WORDS[d].label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Field label="A note on the page (optional)">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={600}
              rows={3}
              placeholder="Great speaking with you today. Once the two documents are in, we can move quickly."
              aria-label="A note on the page"
            />
          </Field>
          <Field label="Funder (for you, not shown to the merchant)">
            <Input value={funder} onChange={(e) => setFunder(e.target.value)} maxLength={120} />
          </Field>
          <Toggle
            label={
              merchant.emailBlocked
                ? `Not emailed: ${merchant.emailBlocked}`
                : merchant.email
                  ? `Email it to ${merchant.email}`
                  : "No email address on file"
            }
            hint="From your Gmail, with a button to the offer page. Off: you get the link to send yourself."
            checked={send}
            disabled={!canEmail}
            onChange={setSend}
          />
        </div>

        {/* what the merchant will see */}
        <aside
          aria-label="Preview"
          className="self-start rounded-3xl border border-border bg-surface-3/50 p-4"
        >
          <p className="eyebrow">What they will see</p>
          <div className="mt-3 rounded-2xl bg-[#16121f] p-4 text-white">
            <p className="text-[10.5px] font-semibold tracking-[0.18em] text-violet-200 uppercase">
              Your funding offer
            </p>
            <p className="mt-1 text-[30px] leading-none font-semibold tracking-tight tabular-nums">
              {cents ? exactMoney(cents) : "$0"}
            </p>
            <p className="mt-2 text-[12.5px] text-white/70">
              {count ? `${count} ${FREQUENCY_WORDS[frequency].label.toLowerCase()} payments` : "—"}
            </p>
          </div>
          <dl className="mt-3 divide-y divide-border text-[13px]">
            {[
              [
                FREQUENCY_WORDS[frequency].payment,
                preview ? exactMoney(preview.paymentCents) : "—",
              ],
              ["Total payback", preview ? exactMoney(preview.paybackCents) : "—"],
              ...(preview && preview.finalPaymentCents !== preview.paymentCents
                ? [["Final payment", exactMoney(preview.finalPaymentCents)]]
                : []),
              ["Factor rate", rate ? rate.toFixed(3) : "—"],
              ["Term", count ? termWords(frequency, count) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-2">
                <dt className="text-muted">{k}</dt>
                <dd className="font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {!preview ? (
            <p className="mt-2 text-xs text-warn">
              Fill in the amount, the factor rate and the number of payments.
            </p>
          ) : null}
        </aside>
      </div>
    </Dialog>
  );
}
