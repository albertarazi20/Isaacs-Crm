"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Glyph } from "@/components/shell/icons";
import { buttonClass, cn } from "@/components/ui";
import { formatUS } from "@/lib/mca/phone";
import { exactMoney, FREQUENCY_WORDS, factorWords, termWords, timeLeft } from "@/lib/offers/terms";
import type { OfferPage } from "@/lib/system/offers";

type Slot = "waiting" | "sending" | "done" | "error";

/** How the page's clock lines up with the server's: a phone set wrong must not end the offer early, or keep it open. */
function useServerClock(serverNow: number): number {
  const skew = useRef<number | null>(null);
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    skew.current = serverNow - Date.now();
    const tick = () => setNow(Date.now() + (skew.current ?? 0));
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [serverNow]);
  return now;
}

/**
 * What the merchant sees: who it is for, how long it stands, the terms, and the form to accept with the documents it
 * needs. The numbers are the database's, so they match the email and the CRM to the cent.
 */
export function OfferView({
  offer,
  token,
  preview,
  serverNow,
}: {
  offer: OfferPage;
  token: string;
  /** A signed-in rep is looking: nothing counts, nothing uploads, nothing is accepted. */
  preview: boolean;
  /** The server's clock when the page was made. */
  serverNow: number;
}) {
  const now = useServerClock(serverNow);
  const [state, setState] = useState(offer.state);
  const left = timeLeft(offer.expiresAt, now);
  const running = state === "open" && left !== null;
  const freq = FREQUENCY_WORDS[offer.frequency];
  const uneven = offer.finalPaymentCents !== offer.paymentCents;

  // the merchant has the page in front of them: told to their rep once (a mail scanner fetching the link is not)
  useEffect(() => {
    if (preview || offer.state !== "open") return;
    const t = setTimeout(() => {
      void fetch(`/api/offer/${token}/seen`, { method: "POST", keepalive: true }).catch(
        () => undefined,
      );
    }, 3000);
    return () => clearTimeout(t);
  }, [preview, offer.state, token]);

  return (
    <div className="space-y-6">
      {preview ? (
        <p
          role="status"
          className="rounded-2xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-[13px] font-medium text-accent"
        >
          Preview: you&apos;re signed in to the CRM, so this is the merchant&apos;s page as they see
          it. Nothing you do here counts.
        </p>
      ) : null}

      {/* who it is for */}
      <header>
        <p className="text-[11.5px] font-semibold tracking-[0.22em] text-accent uppercase">
          Prepared for
        </p>
        <h1 className="mt-2 text-[32px] leading-[1.08] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
          {offer.businessName}
        </h1>
        <p className="mt-6 text-[11.5px] font-semibold tracking-[0.22em] text-muted uppercase">
          From {offer.repName ? `${offer.repName} at ` : ""}
          {offer.shopName}
        </p>
        <h2 className="mt-2 text-[26px] leading-tight font-semibold tracking-[-0.02em] sm:text-[30px]">
          Your custom funding offer.
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-pretty text-text-2">
          {offer.firstName ? `${offer.firstName}, here` : "Here"} are the terms we put together for
          you. Review the details below and accept when you&apos;re ready to move forward.
        </p>
      </header>

      {/* how long it stands */}
      <section
        aria-label="How long the offer stands"
        className={cn(
          "rounded-3xl border px-5 py-4",
          state === "accepted"
            ? "border-good/30 bg-good-soft/50"
            : running
              ? "border-accent/30 bg-accent-soft/40"
              : "border-warn/30 bg-warn-soft/60",
        )}
      >
        <p
          className={cn(
            "text-[11px] font-semibold tracking-[0.2em] uppercase",
            state === "accepted" ? "text-good" : running ? "text-accent" : "text-warn",
          )}
        >
          {state === "accepted"
            ? "Accepted"
            : running
              ? "Offer valid through"
              : state === "withdrawn"
                ? "No longer available"
                : "This offer has ended"}
        </p>
        <p className="mt-1 text-[17px] font-medium">{offer.validThrough}</p>
        {running ? (
          <p className="mt-1.5 text-[12px] font-semibold tracking-[0.16em] text-text-2 uppercase tabular-nums">
            {left} remaining
          </p>
        ) : state === "accepted" ? null : (
          <p className="mt-1.5 text-[13.5px] text-text-2">
            Get in touch below and we&apos;ll see what we can do.
          </p>
        )}
      </section>

      {/* the terms */}
      <section
        aria-label="Your funding offer"
        className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card"
      >
        <div className="relative overflow-hidden bg-[#16121f] bg-[url(/brand/offer-hero.png)] bg-cover bg-center px-6 py-6 text-white">
          <p className="relative text-[11px] font-semibold tracking-[0.22em] text-violet-200 uppercase">
            Your funding offer
          </p>
          <p className="relative mt-2 text-[44px] leading-none font-semibold tracking-[-0.035em] tabular-nums">
            {exactMoney(offer.fundedCents)}
          </p>
          <div className="relative mt-4 flex flex-wrap gap-2">
            {[
              `${offer.payments} payments`,
              freq.label,
              termWords(offer.frequency, offer.payments),
            ].map((t) => (
              <span
                key={t}
                className="rounded-lg border border-white/15 bg-white/10 px-2.5 py-1 text-[12.5px] font-medium"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.2em] text-muted uppercase">
                {freq.payment}
              </p>
              <p className="mt-1.5 text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
                {exactMoney(offer.paymentCents)}
              </p>
            </div>
            <span className="rounded-full bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent">
              {offer.payments} payments
            </span>
          </div>
          <dl className="mt-4 divide-y divide-border border-t border-border">
            {[
              ["Factor rate", factorWords(offer.factorRate)],
              ["Funded amount", exactMoney(offer.fundedCents)],
              ["Total payback", exactMoney(offer.paybackCents)],
              ...(uneven ? [["Final payment", exactMoney(offer.finalPaymentCents)]] : []),
              ["Term", termWords(offer.frequency, offer.payments)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-3.5">
                <dt className="text-[14.5px] text-muted">{k}</dt>
                <dd className="text-[15px] font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {uneven ? (
            <p className="mt-1 text-[12.5px] text-muted">
              The final payment carries the few cents left over, so the payments add up to the total
              payback exactly.
            </p>
          ) : null}
        </div>
      </section>

      {offer.message ? (
        <figure className="rounded-3xl border border-border bg-surface px-6 py-5">
          <blockquote className="text-[15px] leading-relaxed text-text-2">
            “{offer.message}”
          </blockquote>
          {offer.repName ? (
            <figcaption className="mt-2 text-[13px] font-medium text-muted">
              — {offer.repName}
            </figcaption>
          ) : null}
        </figure>
      ) : null}

      {state === "accepted" ? (
        <Accepted offer={offer} />
      ) : running ? (
        <AcceptForm
          offer={offer}
          token={token}
          preview={preview}
          onAccepted={() => setState("accepted")}
        />
      ) : null}

      {/* who to talk to */}
      <section
        aria-label="Your contact"
        className="rounded-3xl border border-border bg-surface px-6 py-5"
      >
        <p className="text-[11px] font-semibold tracking-[0.2em] text-muted uppercase">
          Questions?
        </p>
        <p className="mt-1.5 text-[15px] font-semibold">{offer.repName || offer.shopName}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {offer.repPhone ? (
            <a href={`tel:${offer.repPhone}`} className={buttonClass("secondary", "md", "h-11")}>
              <Glyph name="phone" className="size-4" />
              {formatUS(offer.repPhone)}
            </a>
          ) : null}
          {offer.repEmail ? (
            <a href={`mailto:${offer.repEmail}`} className={buttonClass("secondary", "md", "h-11")}>
              <Glyph name="mail" className="size-4" />
              {offer.repEmail}
            </a>
          ) : null}
        </div>
      </section>

      <p className="text-center text-[12px] leading-relaxed text-pretty text-muted">
        This page is a summary of an offer, not a contract. Final terms, and any disclosures your
        state requires, come with the funding agreement. Your documents are stored privately and
        shared only with the people working on your file.
      </p>
    </div>
  );
}

function Accepted({ offer }: { offer: OfferPage }) {
  return (
    <section
      aria-label="Accepted"
      className="rounded-3xl border border-good/30 bg-good-soft/50 px-6 py-8 text-center"
    >
      <span className="mx-auto flex size-14 animate-pop items-center justify-center rounded-full bg-good-soft text-good ring-1 ring-good/25">
        <Glyph name="check" className="size-6" strokeWidth={2.2} />
      </span>
      <h2 className="mt-4 text-[22px] font-semibold tracking-tight">Offer accepted</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-text-2">
        Thank you{offer.firstName ? `, ${offer.firstName}` : ""}. {offer.repName || "Your contact"}{" "}
        will review your documents and be in touch about next steps.
      </p>
    </section>
  );
}

function AcceptForm({
  offer,
  token,
  preview,
  onAccepted,
}: {
  offer: OfferPage;
  token: string;
  preview: boolean;
  onAccepted: () => void;
}) {
  const [name, setName] = useState(offer.contactName);
  const [email, setEmail] = useState("");
  const [slots, setSlots] = useState<Record<string, Slot>>(() =>
    Object.fromEntries(offer.docs.map((d) => [d.kind, d.onFile ? "done" : "waiting"])),
  );
  const [onFileNow, setOnFileNow] = useState<ReadonlySet<string>>(
    () => new Set(offer.docs.filter((d) => d.onFile).map((d) => d.kind)),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [said, setSaid] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const ready = offer.docs.every((d) => slots[d.kind] === "done");

  /** The slots as the server has them: what is on file is done, whatever this page thought. */
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/offer/${token}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { docs?: string[] };
      const have = new Set(j.docs ?? []);
      setOnFileNow(have);
      setSlots((s) =>
        Object.fromEntries(
          Object.entries(s).map(([k, v]) => [
            k,
            have.has(k) ? "done" : v === "done" ? "waiting" : v,
          ]),
        ),
      );
    } catch {
      // the next upload or accept tries again
    }
  }, [token]);

  async function upload(kind: string, label: string, file: File) {
    if (!offer.uploadToken || preview) return;
    setSlots((s) => ({ ...s, [kind]: "sending" }));
    setErrors((e) => ({ ...e, [kind]: "" }));
    const body = new FormData();
    body.append("file", file);
    body.append("kind", kind);
    try {
      const r = await fetch(`/api/upload/${offer.uploadToken}`, { method: "POST", body });
      const j = (await r.json().catch(() => ({}))) as {
        results?: { ok: boolean; error?: string; kind?: string }[];
        error?: string;
      };
      const res = j.results?.[0];
      if (r.ok && res?.ok && (!res.kind || res.kind === kind)) {
        setSlots((s) => ({ ...s, [kind]: "done" }));
        setSaid(`${label} received.`);
      } else {
        setSlots((s) => ({ ...s, [kind]: "error" }));
        setErrors((e) => ({
          ...e,
          [kind]:
            res?.error ??
            (r.status === 404
              ? "This page was open a long time. Refresh it and try again."
              : r.status === 413
                ? "That file is too big. Send a smaller photo or PDF."
                : (j.error ?? "That didn't upload. Try again.")),
        }));
      }
    } catch {
      setSlots((s) => ({ ...s, [kind]: "error" }));
      setErrors((e) => ({ ...e, [kind]: "No connection. Try again." }));
    }
    await refresh();
  }

  async function accept() {
    setBusy(true);
    setProblem("");
    try {
      const r = await fetch(`/api/offer/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) onAccepted();
      else {
        setProblem(j.error ?? "That didn't go through. Try again.");
        await refresh();
      }
    } catch {
      setProblem("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const n = offer.docs.length;
  return (
    <section
      aria-label="Accept your offer"
      className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card"
    >
      <div className="border-b border-border px-6 py-5">
        <h2 className="text-[22px] font-semibold tracking-tight">Accept your offer</h2>
        <p className="mt-1 text-[14.5px] text-text-2">
          {n === 0
            ? "Confirm your details to move forward."
            : `Confirm your details and upload the ${n === 1 ? "document" : `${n} documents`} needed to move forward.`}
        </p>
      </div>
      <div className="space-y-4 px-6 py-5">
        <label className="block space-y-1.5">
          <span className="text-[14px] font-medium">Full name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            autoComplete="name"
            className="h-12 w-full rounded-xl border border-border bg-surface px-3.5 text-[16px] focus:border-accent focus:ring-[3px] focus:ring-ring focus:outline-none"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[14px] font-medium">Email (optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            autoComplete="email"
            placeholder="you@business.com"
            className="h-12 w-full rounded-xl border border-border bg-surface px-3.5 text-[16px] focus:border-accent focus:ring-[3px] focus:ring-ring focus:outline-none"
          />
        </label>
        {offer.docs.map((d) => {
          const s = slots[d.kind] ?? "waiting";
          return (
            <div
              key={d.kind}
              className={cn(
                "rounded-2xl border px-4 py-3.5",
                s === "done" ? "border-good/30 bg-good-soft/40" : "border-border",
              )}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">
                    {d.label}
                    <span aria-hidden className="ml-0.5 text-bad">
                      *
                    </span>
                    <span className="sr-only"> (required)</span>
                  </p>
                  <p className="text-[13px] text-muted">
                    {s === "done"
                      ? onFileNow.has(d.kind) && d.onFile
                        ? "Already on file. Thank you."
                        : "Received. Thank you."
                      : d.hint}
                  </p>
                </div>
                {s === "done" ? (
                  <span className="flex size-11 items-center justify-center rounded-full bg-good-soft text-good">
                    <Glyph name="check" className="size-5" strokeWidth={2.2} />
                  </span>
                ) : (
                  <>
                    <input
                      ref={(el) => {
                        inputs.current[d.kind] = el;
                      }}
                      type="file"
                      tabIndex={-1}
                      accept="image/*,application/pdf"
                      className="sr-only"
                      aria-label={`Upload your ${d.label.toLowerCase()}`}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(d.kind, d.label, f);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Upload your ${d.label.toLowerCase()}`}
                      disabled={s === "sending" || !offer.uploadToken || preview}
                      onClick={() => inputs.current[d.kind]?.click()}
                      className={buttonClass("primary", "md", "h-11 shrink-0 px-5")}
                    >
                      {s === "sending" ? "Sending…" : s === "error" ? "Try again" : "Upload"}
                    </button>
                  </>
                )}
              </div>
              {errors[d.kind] ? (
                <p role="alert" className="mt-2 text-[13px] text-bad">
                  {errors[d.kind]}
                </p>
              ) : null}
            </div>
          );
        })}
        <p aria-live="polite" className="sr-only">
          {said}
        </p>
        {problem ? (
          <p role="alert" className="text-[14px] text-bad">
            {problem}
          </p>
        ) : null}
        <button
          type="button"
          disabled={!ready || busy || preview}
          onClick={() => void accept()}
          className="h-14 w-full rounded-2xl bg-linear-to-r from-violet-600 to-fuchsia-600 text-[16px] font-semibold text-white shadow-glow transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Accepting…" : n > 0 ? "Accept offer & submit documents" : "Accept offer"}
        </button>
        <p className="text-center text-[12.5px] text-muted">
          {preview
            ? "This is a preview: uploading and accepting are for the merchant."
            : ready
              ? "Everything's in. Press accept and we'll take it from here."
              : "Upload each document above, then accept."}
        </p>
      </div>
    </section>
  );
}
