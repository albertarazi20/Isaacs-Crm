"use client";

import { useState, type FormEvent } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";

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

/** The merchant's own application: prefilled from what the rep already knows, signed by typing their name. */
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

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
        setError(j.error ?? "Something went wrong — try again");
        return;
      }
      setDone(true);
    } catch {
      setError("Couldn't reach the server — check your connection and try again");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <section className="mt-6 rounded-xl border border-border bg-surface p-5" role="status">
        <h2 className="text-base font-semibold">Thank you — your application is in</h2>
        <p className="mt-1 text-sm text-muted">
          A copy is on its way to your email. If any statements are still missing, the upload link
          in your earlier email still works.
        </p>
      </section>
    );

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <legend className="px-1 text-sm font-semibold">Business</legend>
        <Field label="Legal business name">
          <Input
            name="legal_business_name"
            required
            defaultValue={prefill.legal_business_name ?? ""}
            autoComplete="organization"
          />
        </Field>
        <Field label="DBA (if different)">
          <Input name="dba" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry">
            <Input name="industry" defaultValue={prefill.industry ?? ""} />
          </Field>
          <Field label="Business started" hint="Year and month">
            <Input name="business_start" type="month" />
          </Field>
        </div>
        <Field
          label="EIN, last four digits only"
          hint="We never ask for the full EIN or an SSN here"
        >
          <Input name="ein_last4" inputMode="numeric" pattern="\d{4}" maxLength={4} />
        </Field>
        <Field label="Business address">
          <Input name="address" autoComplete="street-address" />
        </Field>
        <div className="grid grid-cols-[1fr_88px_110px] gap-3">
          <Field label="City">
            <Input name="city" autoComplete="address-level2" />
          </Field>
          <Field label="State">
            <Select name="state" required defaultValue={prefill.state ?? ""}>
              <option value="">—</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ZIP">
            <Input name="zip" inputMode="numeric" autoComplete="postal-code" />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <legend className="px-1 text-sm font-semibold">Owner</legend>
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Full name">
            <Input
              name="owner_name"
              required
              defaultValue={prefill.owner_name ?? ""}
              autoComplete="name"
            />
          </Field>
          <Field label="Title">
            <Input name="title" placeholder="Owner" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mobile phone">
            <Input
              name="phone"
              type="tel"
              required
              defaultValue={prefill.phone ?? ""}
              autoComplete="tel"
            />
          </Field>
          <Field label="Email">
            <Input
              name="email"
              type="email"
              required
              defaultValue={prefill.email ?? ""}
              autoComplete="email"
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <legend className="px-1 text-sm font-semibold">The request</legend>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly revenue ($)">
            <Input
              name="monthly_revenue_dollars"
              type="number"
              min={0}
              step={1000}
              inputMode="numeric"
              defaultValue={prefill.monthly_revenue_dollars ?? ""}
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
            />
          </Field>
        </div>
        <Field label="What is the money for?">
          <Textarea name="use_of_funds" className="min-h-20" />
        </Field>
        <Field label="Any advances or financing open today?" hint="Who, and the balance, or 'none'">
          <Input name="existing_advances" />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <legend className="px-1 text-sm font-semibold">Consent and signature</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="consent_email" defaultChecked className="mt-1 size-4" />
          <span>Email me updates about this application.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="consent_sms" className="mt-1 size-4" />
          <span>
            Text me about this application. Message and data rates may apply; reply STOP to end.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="agree" required className="mt-1 size-4" />
          <span>
            I confirm the information is accurate and authorize sharing it with funding providers to
            obtain offers on my behalf. This is a soft inquiry and does not affect my credit.
          </span>
        </label>
        <Field label="Type your full name to sign">
          <Input name="signer_name" required autoComplete="off" placeholder="Your full name" />
        </Field>
      </fieldset>

      {error ? (
        <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <Button variant="primary" type="submit" disabled={busy} className="w-full">
        {busy ? "Sending…" : "Sign and send"}
      </Button>
    </form>
  );
}
