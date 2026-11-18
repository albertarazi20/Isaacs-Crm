"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Glyph } from "@/components/shell/icons";
import { cn } from "@/components/ui";
import { formatUS } from "@/lib/mca/phone";
import {
  FREQUENCY_WORDS,
  factorWords,
  paymentsWords,
  sheetMoney,
  termWords,
  timeLeft,
} from "@/lib/offers/terms";
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

const SERIF = { fontFamily: "var(--font-offer-serif), Georgia, 'Times New Roman', serif" };
const EYEBROW = "text-[10.5px] font-semibold tracking-[0.24em] uppercase";
const CARD =
  "rounded-[20px] border border-[#e5e2d9] bg-white shadow-[0_1px_2px_rgba(14,20,36,0.04),0_12px_32px_-12px_rgba(14,20,36,0.12)]";
const INPUT =
  "h-12 w-full rounded-xl border border-[#d9d5ca] bg-white px-3.5 text-[16px] text-[#0e1424] placeholder:text-[#9a9ea9] focus:border-[#0e1424] focus:ring-[3px] focus:ring-[#0e1424]/10 focus:outline-none";
const INK_BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-[#0e1424] font-semibold text-white transition hover:bg-[#1c2438] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

/**
 * What the merchant sees: who it is for, how long it stands, the terms as a term sheet, and the form to accept with
 * the documents it needs. Always on paper (light) with a text face for the figures. The numbers are the database's,
 * so they match the email and the CRM to the cent.
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

  // the merchant has the page in front of them: told to their rep (a mail scanner fetching the link is not)
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
          className="rounded-2xl border border-[#6d28d9]/25 bg-[#6d28d9]/[0.06] px-4 py-2.5 text-[13px] font-medium text-[#5b21b6]"
        >
          Preview: you&apos;re signed in to the CRM, so this is the merchant&apos;s page as they see
          it. Nothing you do here counts.
        </p>
      ) : null}

      {/* who it is for */}
      <header>
        <p className={cn(EYEBROW, "text-[#6d28d9]")}>Prepared for</p>
        <h1
          style={SERIF}
          className="mt-2.5 text-[36px] leading-[1.05] font-medium tracking-[-0.01em] text-balance sm:text-[46px]"
        >
          {offer.businessName}
        </h1>
        <p className="mt-4 text-[14px] text-[#5f6370]">
          From {offer.repName ? `${offer.repName}, ` : ""}
          {offer.shopName}
        </p>
        <p className="mt-5 text-[16px] leading-relaxed text-pretty text-[#3d4150]">
          {offer.firstName ? `${offer.firstName}, here` : "Here"} are the terms we put together for
          you. Review them below, and accept when you&apos;re ready to move forward.
        </p>
      </header>

      {/* how long it stands */}
      <section
        aria-label="How long the offer stands"
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-[18px] border px-5 py-4",
          state === "accepted"
            ? "border-[#15803d]/25 bg-[#15803d]/[0.05]"
            : running
              ? "border-[#e5e2d9] bg-white"
              : "border-[#b45309]/25 bg-[#b45309]/[0.06]",
        )}
      >
        <div>
          <p
            className={cn(
              EYEBROW,
              state === "accepted"
                ? "text-[#15803d]"
                : running
                  ? "text-[#5f6370]"
                  : "text-[#b45309]",
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
          <p style={SERIF} className="mt-1 text-[19px]">
            {offer.validThrough}
          </p>
          {!running && state !== "accepted" ? (
            <p className="mt-1 text-[13.5px] text-[#3d4150]">
              Get in touch below and we&apos;ll see what we can do.
            </p>
          ) : null}
        </div>
        {running ? (
          <p className="rounded-full bg-[#0e1424] px-3.5 py-1.5 text-[12px] font-semibold tracking-[0.14em] text-white uppercase tabular-nums">
            {left} left
          </p>
        ) : null}
      </section>

      {/* the term sheet */}
      <section aria-label="Your funding offer" className={cn(CARD, "overflow-hidden p-1.5")}>
        <div className="rounded-[15px] border border-[#ece9e1]">
          <div className="px-6 pt-7 pb-6 text-center">
            <p className={cn(EYEBROW, "text-[#5f6370]")}>Funding offered</p>
            <p
              style={SERIF}
              className="mt-3 text-[52px] leading-none font-medium tracking-[-0.02em] tabular-nums sm:text-[60px]"
            >
              {sheetMoney(offer.fundedCents)}
            </p>
            <p className="mt-3 text-[13px] text-[#5f6370]">
              {paymentsWords(offer.payments, offer.frequency)} ·{" "}
              {termWords(offer.frequency, offer.payments)}
            </p>
          </div>
          <dl className="grid grid-cols-3 border-y border-[#ece9e1]">
            {[
              [freq.payment, sheetMoney(offer.paymentCents)],
              ["Payments", String(offer.payments)],
              ["Factor rate", factorWords(offer.factorRate)],
            ].map(([k, v], i) => (
              <div
                key={k}
                className={cn("px-3 py-4 text-center", i > 0 && "border-l border-[#ece9e1]")}
              >
                <dt className="text-[10px] leading-tight font-semibold tracking-[0.16em] text-[#5f6370] uppercase">
                  {k}
                </dt>
                <dd style={SERIF} className="mt-1.5 text-[20px] tabular-nums sm:text-[22px]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <dl className="px-6 py-2">
            {[
              ["Total payback", sheetMoney(offer.paybackCents)],
              ...(uneven ? [["Final payment", sheetMoney(offer.finalPaymentCents)]] : []),
              ["Term", termWords(offer.frequency, offer.payments)],
            ].map(([k, v], i) => (
              <div
                key={k}
                className={cn(
                  "flex items-baseline justify-between gap-3 py-3.5",
                  i > 0 && "border-t border-[#ece9e1]",
                )}
              >
                <dt className="text-[14.5px] text-[#5f6370]">{k}</dt>
                <dd style={SERIF} className="text-[18px] tabular-nums">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {uneven ? (
            <p className="border-t border-[#ece9e1] px-6 py-3 text-[12.5px] text-[#5f6370]">
              The final payment carries the few cents left over, so the payments add up to the total
              payback exactly.
            </p>
          ) : null}
        </div>
      </section>

      {offer.message ? (
        <figure className="border-l-[3px] border-[#6d28d9] py-1 pl-5">
          <blockquote style={SERIF} className="text-[18px] leading-relaxed text-[#2b2f3c] italic">
            “{offer.message}”
          </blockquote>
          {offer.repName ? (
            <figcaption className="mt-2 text-[13px] font-medium text-[#5f6370]">
              {offer.repName}, {offer.shopName}
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
      <section aria-label="Your contact" className={cn(CARD, "px-6 py-5")}>
        <p className={cn(EYEBROW, "text-[#5f6370]")}>Your contact</p>
        <p style={SERIF} className="mt-1.5 text-[20px]">
          {offer.repName || offer.shopName}
        </p>
        <p className="text-[13px] text-[#5f6370]">{offer.shopName}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {offer.repPhone ? (
            <a
              href={`tel:${offer.repPhone}`}
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#d9d5ca] bg-white px-4 text-[14px] font-medium hover:border-[#0e1424]"
            >
              <Glyph name="phone" className="size-4" />
              {formatUS(offer.repPhone)}
            </a>
          ) : null}
          {offer.repEmail ? (
            <a
              href={`mailto:${offer.repEmail}`}
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#d9d5ca] bg-white px-4 text-[14px] font-medium hover:border-[#0e1424]"
            >
              <Glyph name="mail" className="size-4" />
              {offer.repEmail}
            </a>
          ) : null}
        </div>
      </section>

      <p className="px-2 text-center text-[12px] leading-relaxed text-pretty text-[#5f6370]">
        This page is a summary of an offer, not a contract. Final terms, and any disclosures your
        state requires, come with the funding agreement. Your documents are stored privately and
        shared only with the people working on your file. Offer {offer.number}.
      </p>
    </div>
  );
}

function Accepted({ offer }: { offer: OfferPage }) {
  return (
    <section aria-label="Accepted" className={cn(CARD, "px-6 py-9 text-center")}>
      <span className="mx-auto flex size-14 animate-pop items-center justify-center rounded-full bg-[#15803d]/10 text-[#15803d] ring-1 ring-[#15803d]/25">
        <Glyph name="check" className="size-6" strokeWidth={2.2} />
      </span>
      <h2 style={SERIF} className="mt-4 text-[28px] font-medium">
        Offer accepted
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-[#3d4150]">
        Thank you{offer.firstName ? `, ${offer.firstName}` : ""}. {offer.repName || "Your contact"}{" "}
        has your documents, will review them, and will be in touch about next steps.
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
    <section aria-label="Accept your offer" className={cn(CARD, "overflow-hidden")}>
      <div className="border-b border-[#ece9e1] px-6 py-5">
        <h2 style={SERIF} className="text-[26px] font-medium">
          Accept your offer
        </h2>
        <p className="mt-1 text-[14.5px] text-[#3d4150]">
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
            className={INPUT}
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
            className={INPUT}
          />
        </label>
        {offer.docs.map((d) => {
          const s = slots[d.kind] ?? "waiting";
          return (
            <div
              key={d.kind}
              className={cn(
                "rounded-2xl border px-4 py-3.5",
                s === "done" ? "border-[#15803d]/30 bg-[#15803d]/[0.05]" : "border-[#e5e2d9]",
              )}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">
                    {d.label}
                    <span aria-hidden className="ml-0.5 text-[#b91c1c]">
                      *
                    </span>
                    <span className="sr-only"> (required)</span>
                  </p>
                  <p className="text-[13px] text-[#5f6370]">
                    {s === "done"
                      ? onFileNow.has(d.kind) && d.onFile
                        ? "Already on file. Thank you."
                        : "Received. Thank you."
                      : d.hint}
                  </p>
                </div>
                {s === "done" ? (
                  <span className="flex size-11 items-center justify-center rounded-full bg-[#15803d]/10 text-[#15803d]">
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
                      className={cn(INK_BUTTON, "h-11 shrink-0 px-5 text-[15px]")}
                    >
                      {s === "sending" ? "Sending…" : s === "error" ? "Try again" : "Upload"}
                    </button>
                  </>
                )}
              </div>
              {errors[d.kind] ? (
                <p role="alert" className="mt-2 text-[13px] text-[#b91c1c]">
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
          <p role="alert" className="text-[14px] text-[#b91c1c]">
            {problem}
          </p>
        ) : null}
        <button
          type="button"
          disabled={!ready || busy || preview}
          onClick={() => void accept()}
          className={cn(INK_BUTTON, "h-14 w-full rounded-2xl text-[16px] tracking-[0.01em]")}
        >
          {busy ? "Accepting…" : n > 0 ? "Accept offer & submit documents" : "Accept offer"}
        </button>
        <p className="text-center text-[12.5px] text-[#5f6370]">
          {preview
            ? "This is a preview: uploading and accepting are for the merchant."
            : ready
              ? "Everything's in. Accepting is subject to final review and verification."
              : "Upload each document above, then accept. Subject to final review and verification."}
        </p>
      </div>
    </section>
  );
}
