"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Glyph } from "@/components/shell/icons";
import { Button, cn, Field, Input, Select, Textarea } from "@/components/ui";

const US_STATES =
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  );

export interface ApplicationPrefill {
  legal_business_name?: string;
  owner_name?: string;
  phone?: string;
  email?: string;
  state?: string;
  industry?: string;
  monthly_revenue_dollars?: number;
  amount_requested_dollars?: number;
}

const STEPS = [
  { key: "business", label: "Business", title: "Your business", lead: "The legal details." },
  { key: "owner", label: "Owner", title: "About you", lead: "Who we will be talking to." },
  { key: "request", label: "Request", title: "The request", lead: "Rough numbers are fine." },
  { key: "sign", label: "Sign", title: "Consent and signature", lead: "Last step." },
] as const;

/** A thumb-sized field: 16px text so a phone does not zoom in on focus. */
const BIG = "h-12 text-base sm:h-11 sm:text-[15px]";

type Invalid = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function firstInvalid(root: HTMLElement | null): Invalid | null {
  if (!root) return null;
  for (const el of root.querySelectorAll<Invalid>("input, select, textarea"))
    if (!el.checkValidity()) return el;
  return null;
}

function ConsentBox({
  children,
  name,
  required,
  defaultChecked,
}: {
  children: ReactNode;
  name: string;
  required?: boolean;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-surface-3/60 p-4 text-[15px] leading-snug transition duration-150 hover:border-border-strong has-checked:border-accent/50 has-checked:bg-accent-soft/50 has-focus-visible:ring-[3px] has-focus-visible:ring-ring">
      <input
        type="checkbox"
        name={name}
        required={required}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-5 shrink-0 accent-accent"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * The merchant's own application: prefilled from what the rep already knows, signed by typing their name. One
 * section per screen with the whole form kept mounted, so going back never loses a word and the single post at the
 * end carries every field.
 */
export function ApplicationForm({
  token,
  prefill,
}: {
  token: string;
  prefill: ApplicationPrefill;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  /** One screen's fields, found when a button is pressed (never while rendering). */
  const panel = (i: number) =>
    formRef.current?.querySelector<HTMLElement>(`fieldset[data-step="${i}"]`) ?? null;
  const top = useRef<HTMLDivElement>(null);
  // a field the browser should point at once its screen is showing
  const complain = useRef<Invalid | null>(null);

  const shown = useRef(step);
  useEffect(() => {
    // the first paint stays where the page opened; only a change of step moves the view
    if (shown.current === step) return;
    shown.current = step;
    if (complain.current) {
      complain.current.reportValidity();
      complain.current = null;
      return;
    }
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step]);

  function go(to: number) {
    if (to > step) {
      const bad = firstInvalid(panel(step));
      if (bad) return void bad.reportValidity();
    }
    setError(null);
    setStep(Math.max(0, Math.min(STEPS.length - 1, to)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < STEPS.length - 1) return go(step + 1);
    // every screen is checked again: an earlier answer may have been cleared on the way back
    for (let i = 0; i < STEPS.length; i++) {
      const bad = firstInvalid(panel(i));
      if (!bad) continue;
      if (i === step) bad.reportValidity();
      else {
        complain.current = bad;
        setStep(i);
      }
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body: Record<string, FormDataEntryValue | boolean> = {};
    for (const [k, v] of form.entries()) body[k] = v;
    for (const k of ["consent_email", "consent_sms", "agree"]) body[k] = form.get(k) === "on";
    try {
      const r = await fetch(`/api/apply/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error ?? "Something went wrong. Try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <section
        className="mt-7 rounded-3xl border border-border bg-surface px-6 py-10 text-center"
        role="status"
      >
        <span
          aria-hidden
          className="mx-auto flex size-16 animate-pop items-center justify-center rounded-full bg-good-soft text-good ring-1 ring-good/25"
        >
          <Glyph name="check" className="size-7" strokeWidth={2.2} />
        </span>
        <h2 className="mt-5 text-[22px] font-semibold tracking-[-0.025em]">
          Thank you. Your application is in
        </h2>
        <p className="mx-auto mt-2.5 max-w-sm text-[15px] leading-relaxed text-text-2">
          A copy is on its way to your email. If any statements are still missing, the upload link
          in your earlier email still works.
        </p>
      </section>
    );

  const current = STEPS[step] ?? STEPS[0];
  const last = step === STEPS.length - 1;
  const show = (i: number) => ({
    "data-step": i,
    hidden: step !== i,
    "aria-label": STEPS[i]?.title,
    className: "min-w-0 space-y-4",
  });

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="mt-7">
      <div ref={top} className="scroll-mt-20" />
      <ol className="flex items-center gap-1.5" aria-label="Application steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => go(i)}
              aria-current={i === step ? "step" : undefined}
              className="group block w-full rounded-lg py-1 text-left"
            >
              <span
                className={cn(
                  "block h-1.5 rounded-full transition duration-300",
                  i <= step ? "bg-brand" : "bg-surface-2",
                  i === step && "shadow-glow",
                )}
              />
              <span
                className={cn(
                  "mt-2 flex items-center gap-1.5 text-xs font-medium transition duration-150",
                  i === step ? "text-text" : "text-muted group-hover:text-text-2",
                )}
              >
                <span
                  className={cn(
                    "flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                    i < step
                      ? "bg-good-soft text-good"
                      : i === step
                        ? "bg-accent-soft text-accent"
                        : "bg-surface-2 text-muted",
                  )}
                >
                  {i < step ? <Glyph name="check" className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="truncate">{s.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-5 rounded-3xl border border-border bg-surface p-5 sm:p-7">
        <div className="mb-5">
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.025em]">{current.title}</h2>
          <p className="mt-0.5 text-sm text-muted">{current.lead}</p>
        </div>

        <fieldset {...show(0)}>
          <Field label="Legal business name">
            <Input
              name="legal_business_name"
              required
              defaultValue={prefill.legal_business_name ?? ""}
              autoComplete="organization"
              className={BIG}
            />
          </Field>
          <Field label="DBA (if different)">
            <Input name="dba" className={BIG} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Industry">
              <Input name="industry" defaultValue={prefill.industry ?? ""} className={BIG} />
            </Field>
            <Field label="Business started" hint="Year and month">
              <Input name="business_start" type="month" className={BIG} />
            </Field>
          </div>
          <Field
            label="EIN, last four digits only"
            hint="We never ask for the full EIN or an SSN here"
          >
            <Input
              name="ein_last4"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              className={cn(BIG, "block max-w-40 tracking-[0.3em] tabular-nums")}
            />
          </Field>
          <Field label="Business address">
            <Input name="address" autoComplete="street-address" className={BIG} />
          </Field>
          <div className="grid grid-cols-[1fr_88px] gap-3 sm:grid-cols-[1fr_96px_120px]">
            <Field label="City" className="max-sm:col-span-2">
              <Input name="city" autoComplete="address-level2" className={BIG} />
            </Field>
            <Field label="State" className="max-sm:order-last">
              <Select name="state" required defaultValue={prefill.state ?? ""} className={BIG}>
                <option value="">—</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="ZIP">
              <Input name="zip" inputMode="numeric" autoComplete="postal-code" className={BIG} />
            </Field>
          </div>
        </fieldset>

        <fieldset {...show(1)}>
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Full name">
              <Input
                name="owner_name"
                required
                defaultValue={prefill.owner_name ?? ""}
                autoComplete="name"
                className={BIG}
              />
            </Field>
            <Field label="Title">
              <Input name="title" placeholder="Owner" className={BIG} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Mobile phone">
              <Input
                name="phone"
                type="tel"
                required
                defaultValue={prefill.phone ?? ""}
                autoComplete="tel"
                className={BIG}
              />
            </Field>
            <Field label="Email">
              <Input
                name="email"
                type="email"
                required
                defaultValue={prefill.email ?? ""}
                autoComplete="email"
                className={BIG}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset {...show(2)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Monthly revenue ($)">
              <Input
                name="monthly_revenue_dollars"
                type="number"
                min={0}
                step={1000}
                inputMode="numeric"
                defaultValue={prefill.monthly_revenue_dollars ?? ""}
                className={cn(BIG, "tabular-nums")}
              />
            </Field>
            <Field label="Amount requested ($)">
              <Input
                name="amount_requested_dollars"
                type="number"
                min={0}
                step={1000}
                inputMode="numeric"
                defaultValue={prefill.amount_requested_dollars ?? ""}
                className={cn(BIG, "tabular-nums")}
              />
            </Field>
          </div>
          <Field label="What is the money for?">
            <Textarea name="use_of_funds" className="min-h-24 text-base sm:text-[15px]" />
          </Field>
          <Field
            label="Any advances or financing open today?"
            hint="Who, and the balance, or 'none'"
          >
            <Input name="existing_advances" className={BIG} />
          </Field>
        </fieldset>

        <fieldset {...show(3)}>
          <ConsentBox name="consent_email" defaultChecked>
            Email me updates about this application.
          </ConsentBox>
          <ConsentBox name="consent_sms">
            Text me about this application. Message and data rates may apply; reply STOP to end.
          </ConsentBox>
          <ConsentBox name="agree" required>
            I confirm the information is accurate and authorize sharing it with funding providers to
            obtain offers on my behalf. This is a soft inquiry and does not affect my credit.
          </ConsentBox>
          <Field label="Type your full name to sign">
            <Input
              name="signer_name"
              required
              autoComplete="off"
              placeholder="Your full name"
              className="h-14 text-lg font-medium italic"
            />
          </Field>
        </fieldset>

        {error ? (
          <p
            role="alert"
            className="mt-5 flex items-start gap-2.5 rounded-2xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad"
          >
            <Glyph name="alert" className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>

      <div className="glass-strong sticky bottom-0 z-10 -mx-5 mt-5 flex items-center gap-3 border-t border-border px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:bottom-4 sm:mx-0 sm:rounded-full sm:border sm:p-2 sm:shadow-pop">
        {step > 0 ? (
          <Button size="lg" onClick={() => go(step - 1)} disabled={busy}>
            Back
          </Button>
        ) : null}
        <Button variant="primary" size="lg" type="submit" disabled={busy} className="flex-1">
          {last ? (busy ? "Sending…" : "Sign and send") : "Continue"}
          {last ? null : <Glyph name="arrowRight" className="size-4" strokeWidth={2.2} />}
        </Button>
      </div>
    </form>
  );
}
